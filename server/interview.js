'use strict';
/**
 * Interview engine — a LangGraph-style state machine.
 *
 * State tracks: stage, difficulty progression, covered topics, asked questions,
 * pending follow-ups and per-question scores. Transitions:
 *
 *   start → (opening question) → [answer → score → follow-up | next question]*
 *         → closing → report
 *
 * The LLM (OpenRouter) powers tailored opening questions, follow-ups, answer
 * judgment and the report; the rule-based engine (KB + ML) covers everything
 * offline.
 */

const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const rag = require('./rag');
const ml = require('./ml');
const llm = require('./llm');

const uid = () => crypto.randomUUID();

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

async function startSession({ role, company, jd, resumeText, questionCount, ownerId = null, assignedBy = null }) {
  const profile = rag.inferProfile(jd, resumeText, role, company);

  const totalQuestions = Math.max(
    config.minQuestionCount,
    Math.min(config.maxQuestionCount, Number(questionCount) || config.defaultQuestionCount)
  );

  const state = {
    stage: 'active',
    difficulty: 2,
    totalQuestions,
    coveredTopics: [],
    topicCounts: {},
    askedIds: [],
    answeredQuestions: 0,
    current: null,
    pendingFollowUp: null,
    lastScore: null,
  };

  const queue = rag.retrieve(profile, jd, resumeText, { limit: 40, targetDifficulty: 2 });

  const sessionId = uid();
  db.createSession({
    id: sessionId,
    role: profile.role,
    company: profile.company,
    jdText: jd,
    resumeText: resumeText,
    profile,
    queue,
    state,
    ownerId,
    assignedBy,
  });

  // Opening: prefer a tailored LLM question, else the best KB warm-up.
  let opening = null;
  if (llm.isAvailable()) {
    const tailored = await llm.generateOpeningQuestion(profile, jd, resumeText);
    if (tailored && tailored.text) {
      opening = {
        id: 'custom-opening',
        text: tailored.text,
        topics: [tailored.topic || 'behavioral'],
        topicLabels: [rag.topicLabel(tailored.topic || 'behavioral')],
        difficulty: Math.max(1, Math.min(3, tailored.difficulty || 1)),
        idealPoints: [],
        followUps: ['Can you expand on that with a specific example?'],
        custom: true,
      };
    }
  }
  if (!opening) opening = pickBest(state, queue, profile, 1);

  state.askedIds.push(opening.id);
  state.current = opening;
  db.addTurn(sessionId, {
    kind: 'question', speaker: 'ai',
    question: opening.text, topic: opening.topics[0] || 'behavioral',
    difficulty: opening.difficulty,
  });
  db.updateSession(sessionId, { state });

  const welcome = welcomeMessage(sessionId, profile, state.totalQuestions, opening);
  return { sessionId, profile, opening, welcome };
}

function welcomeMessage(sessionId, profile, totalQuestions, opening) {
  const parts = [
    `👋 Hi! I'm your interview co-pilot. We'll run a ${totalQuestions}-question mock interview for a **${profile.roleLabel}** role${profile.companyLabel ? ' at ' + profile.companyLabel : ''}.`,
  ];
  if (profile.skills && profile.skills.length) {
    parts.push(`From your resume + job description I picked up: **${profile.skills.slice(0, 5).join(', ')}** — I'll focus there.`);
  }
  if (profile.companyLabel) {
    const info = rag.companyInfo(profile.company);
    if (info && info.themes) parts.push(`Company patterns I'll watch for: ${info.themes.join('; ')}.`);
  }
  parts.push('Answer in full sentences — the more specific and quantified, the better. Take your time; I adapt difficulty as we go.');
  return parts.join('\n\n');
}

function pickBest(state, queue, profile, preferDifficulty) {
  const candidates = queue.filter((q) => !state.askedIds.includes(q.id));
  if (!candidates.length) return null;
  const targetDiff = preferDifficulty || state.difficulty;
  const ranked = candidates
    .map((q) => {
      const topicCount = state.topicCounts[q.topics[0]] || 0;
      let s = q.retrievalScore;
      s += topicCount === 0 ? 0.45 : 0;                       // prefer uncovered topics
      s -= topicCount * 0.12;
      s += (1 - Math.min(Math.abs(q.difficulty - targetDiff), 2) * 0.15) * 0.35;
      if (profile.company && q.companies.includes(profile.company)) s += 0.2;
      return { q, s };
    })
    .sort((a, b) => b.s - a.s);
  return ranked[0].q;
}

// ---------------------------------------------------------------------------
// Answer handling
// ---------------------------------------------------------------------------

async function submitAnswer(sessionId, answerText) {
  const session = db.getSession(sessionId);
  if (!session) throw new Error('Session not found');
  const s = session.state;
  if (s.stage !== 'active' && s.stage !== 'followup') throw new Error('Interview is over');

  const q = s.current;
  const clean = (answerText || '').trim();
  if (!clean) throw new Error('Answer is empty');

  const isFollowUpAnswer = !!s.pendingFollowUp;

  // 1. Score with ML features + (optional) LLM judge
  const mlRes = ml.evaluateAnswer(clean, q.text, q.idealPoints);
  let llmJudge = null;
  if (llm.isAvailable()) llmJudge = await llm.evaluateAnswer(q.text, clean, q.idealPoints);

  const llmScore = llmJudge ? llmJudge.score : null;
  const finalScore = llmScore != null
    ? Math.round(mlRes.overall * 0.6 + llmScore * 0.4)
    : mlRes.overall;

  const feedback = buildFeedback(finalScore, mlRes, llmJudge);

  // 2. Difficulty progression
  if (finalScore >= 72) s.difficulty = Math.min(3, s.difficulty + 1);
  else if (finalScore <= 42) s.difficulty = Math.max(1, s.difficulty - 1);

  // 3. Topic coverage
  const topic = q.topics[0] || 'behavioral';
  s.topicCounts[topic] = (s.topicCounts[topic] || 0) + 1;
  if (!s.coveredTopics.includes(topic)) s.coveredTopics.push(topic);

  // 4. Persist the answer turn
  db.addTurn(sessionId, {
    kind: 'answer', speaker: 'user',
    question: q.text, answer: clean,
    topic, difficulty: q.difficulty,
    score: finalScore, scoreJson: mlRes, feedback,
  });

  if (!isFollowUpAnswer) s.answeredQuestions++;
  s.lastScore = finalScore;

  const progress = Math.min(1, s.answeredQuestions / s.totalQuestions);
  const base = {
    score: finalScore,
    criteria: mlRes.criteria,
    llmJudge,
    feedback,
    progress,
  };

  // 5. Follow-up when the answer was weak AND we haven't already probed once
  if (!isFollowUpAnswer && finalScore <= 62 && q.followUps && q.followUps.length) {
    let fuText = q.followUps[0];
    if (llm.isAvailable()) {
      const gen = await llm.generateFollowUp(q.text, clean, q.idealPoints, s.difficulty);
      if (gen && gen.text) fuText = gen.text;
    }
    s.pendingFollowUp = {
      text: fuText,
      topic,
      difficulty: s.difficulty,
      idealPoints: q.idealPoints,
    };
    s.stage = 'followup';
    db.addTurn(sessionId, { kind: 'followup', speaker: 'ai', question: fuText, topic, difficulty: s.difficulty });
    db.updateSession(sessionId, { state: s });
    return { ...base, type: 'followup', followUp: s.pendingFollowUp, complete: false };
  }
  s.pendingFollowUp = null;

  // 6. Finished?
  if (s.answeredQuestions >= s.totalQuestions) {
    s.stage = 'closing';
    db.updateSession(sessionId, { state: s });
    return { ...base, type: 'done', next: null, complete: true, closing: closingMessage() };
  }

  // 7. Next question
  const next = pickBest(s, session.queue, session.profile, null);
  if (!next) {
    s.stage = 'closing';
    db.updateSession(sessionId, { state: s });
    return { ...base, type: 'done', next: null, complete: true, closing: closingMessage() };
  }

  s.askedIds.push(next.id);
  session.queue = session.queue.filter((q2) => q2.id !== next.id);
  s.current = next;
  s.stage = 'active';
  db.addTurn(sessionId, {
    kind: 'question', speaker: 'ai',
    question: next.text, topic: next.topics[0] || 'behavioral',
    difficulty: next.difficulty,
  });
  db.updateSession(sessionId, { state: s, queue: session.queue });

  return {
    ...base, type: 'next',
    next: { text: next.text, topic: next.topics[0], topicLabel: next.topicLabels[0], difficulty: next.difficulty },
    complete: false,
  };
}

function closingMessage() {
  return "That's a wrap! 🎉 Generating your post-interview report now — it'll cover strengths, gaps, and what to practice next.";
}

function buildFeedback(score, mlRes, llmJudge) {
  const lines = [];
  if (llmJudge && llmJudge.verdict) lines.push(`**${llmJudge.verdict}**`);
  const f = mlRes.features;
  lines.push(`Score: **${score}/100** · STAR ${mlRes.criteria.star} · Relevance ${mlRes.criteria.relevance} · Structure ${mlRes.criteria.structure} · Evidence ${mlRes.criteria.evidence}`);
  const tips = [];
  if (mlRes.star && !(mlRes.star.situation && mlRes.star.task && mlRes.star.action && mlRes.star.result)) {
    tips.push('Use the STAR structure — set the **S**ituation, **T**ask, your **A**ctions, and the **R**esult.');
  }
  if (f.fillerDensity > 0.05) {
    tips.push(`You used ~${f.fillerCount} filler word(s) — pause instead of "um"/"like".`);
  }
  if (!f.quantified && score < 70) {
    tips.push('Quantify your impact — "reduced latency by 40%", "grew signups 2x".');
  }
  if (f.wordCount < 25) {
    tips.push('Give a fuller answer — expand with a concrete example or deeper reasoning.');
  }
  if (f.relevance < 0.3) {
    tips.push('Stay on the question — directly address what was asked.');
  }
  if (llmJudge) {
    if (llmJudge.strengths.length) lines.push(`\n💡 Strengths: ${llmJudge.strengths.map((x) => '• ' + x).join('  ')}`);
    if (llmJudge.improvements.length) lines.push(`📈 To improve: ${llmJudge.improvements.map((x) => '• ' + x).join('  ')}`);
  } else if (tips.length) {
    lines.push(`📈 Tips: ${tips.join(' ')}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Completion & report
// ---------------------------------------------------------------------------

async function completeSession(sessionId) {
  const session = db.getSession(sessionId);
  if (!session) throw new Error('Session not found');
  const turns = db.getTurns(sessionId);
  const stats = ml.computeReportStats(turns);
  const profile = session.profile || {};
  const previous = db.getCompletedSessions().filter((p) => p.id !== sessionId);
  const prevAvg = previous.length
    ? Math.round(previous.reduce((s, p) => s + p.totalScore, 0) / previous.length)
    : null;

  const report = buildReport(stats, profile, prevAvg);
  report.improvementDelta = prevAvg != null ? stats.avg - prevAvg : null;
  report.previousAvg = prevAvg;
  report.previousSessions = previous.slice(-8);
  db.updateSession(sessionId, {
    status: 'completed',
    totalScore: stats.avg,
    report,
    completedAt: db.nowIso(),
  });

  return {
    report,
    stats,
    improvementDelta: prevAvg != null ? stats.avg - prevAvg : null,
    previousSessions: previous.slice(-8),
  };
}

function buildReport(stats, profile, prevAvg) {
  const level =
    stats.avg >= 80 ? 'strong' :
    stats.avg >= 65 ? 'solid' :
    stats.avg >= 50 ? 'developing' : 'needs-practice';

  const topicEntries = Object.entries(stats.perTopic).sort((a, b) => b[1].avg - a[1].avg);
  const strengths = topicEntries.filter(([, t]) => t.avg >= 65).slice(0, 3).map(([topic, t]) => ({
    topic, label: rag.topicLabel(topic), avg: t.avg, count: t.count,
  }));
  const gaps = [...topicEntries].reverse().filter(([, t]) => t.avg < 62).slice(0, 3).map(([topic, t]) => ({
    topic, label: rag.topicLabel(topic), avg: t.avg, count: t.count,
  }));

  const gapResources = rag.resourcesForTopics(gaps.map((g) => g.topic).concat(profile.topics || []));

  const summary = [
    `You scored **${stats.avg}/100** across ${stats.sampleSize} answered question(s) for a ${profile.roleLabel || 'general'} role${profile.companyLabel ? ' at ' + profile.companyLabel : ''} — a **${level}** performance.`,
    stats.starCoverageAvg < 0.5
      ? 'Your answers leaned on experience without a clear Situation→Task→Action→Result arc; adding that structure will raise every behavioral score.'
      : 'You used the STAR structure well — keep leading with a crisp story arc.',
    prevAvg != null
      ? `Compared with your previous sessions (avg ${prevAvg}/100), this run is ${stats.avg - prevAvg >= 0 ? 'up' : 'down'} ${Math.abs(stats.avg - prevAvg)} points.`
      : 'This is your first session — future sessions will chart your improvement.',
  ].join(' ');

  const report = {
    summary,
    level,
    strengths,
    gaps,
    resources: gapResources,
    perCriterion: stats.perCriterion,
    perTopic: stats.perTopic,
    fillerStats: { total: stats.totalFillers, avgWordCount: stats.avgWordCount },
  };

  const company = rag.companyInfo(profile.company);
  if (company && company.themes) report.companyThemes = company.themes;

  return report;
}

module.exports = { startSession, submitAnswer, completeSession };
