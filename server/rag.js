'use strict';
/**
 * RAG pipeline (retrieval side).
 *
 * 1. The curated knowledge base (data/knowledge-base.json) is the corpus.
 * 2. At session start, the candidate profile (role, company, skills, topics)
 *    is inferred from the resume + job description.
 * 3. A sparse-vector query embedding (embed.js) retrieves the most relevant
 *    questions, boosted by topic overlap and company-pattern matches, and
 *    ranked by difficulty fit for adaptive progression.
 */

const fs = require('fs');
const { embed, cosine, diceOverlap, tokenize } = require('./embed');
const config = require('./config');

let KB = null;
let index = new Map(); // questionId -> embedding

function loadKb() {
  if (KB) return KB;
  KB = JSON.parse(fs.readFileSync(config.kbPath, 'utf8'));
  buildIndex();
  return KB;
}

function buildIndex() {
  index = new Map();
  for (const q of KB.questions) {
    const vec = embed(q.text);
    // fold ideal points + follow-ups into the embedding for richer matching
    const extra = embed((q.idealPoints || []).join(' '));
    for (const [t, c] of extra) vec.set(t, (vec.get(t) || 0) + c * 0.5);
    index.set(q.id, vec);
  }
}

const kb = () => loadKb();

/** Write the in-memory knowledge base back to disk (teacher edits). */
function persistKb() {
  loadKb();
  fs.writeFileSync(config.kbPath, JSON.stringify(KB, null, 2));
}

function roleLabel(role) {
  return (kb().roles[role] && kb().roles[role].label) || (kb().roles.general.label);
}

function companyInfo(company) {
  return company ? kb().companies[company] || null : null;
}

function topicLabel(topic) {
  return (kb().topics[topic] && kb().topics[topic].label) || topic;
}

function resourcesForTopics(topics) {
  const seen = new Set();
  const out = [];
  for (const t of topics) {
    const list = kb().resources[t];
    if (!list) continue;
    for (const r of list) {
      if (!seen.has(r)) { seen.add(r); out.push(r); }
    }
  }
  return out.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Profile inference
// ---------------------------------------------------------------------------

function hitScore(text, keywords) {
  const lower = text.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    // Multi-word phrases are more specific than single generic words (e.g.
    // "software engineer" > "engineer"), so weight them higher.
    if (lower.includes(kw.toLowerCase())) score += kw.includes(' ') ? 2 : 1;
  }
  return score;
}

/**
 * Infer { role, roleConfidence, company, companyConfidence, skills, topics }
 * from the job description + resume, with explicit overrides winning.
 */
function inferProfile(jdText, resumeText, explicitRole, explicitCompany) {
  const text = `${jdText || ''}\n${resumeText || ''}`.toLowerCase();
  const roles = kb().roles;

  let role = 'general';
  let roleScore = 0;
  for (const [key, r] of Object.entries(roles)) {
    if (key === 'general') continue;
    const s = hitScore(text, r.keywords);
    if (s > roleScore) { roleScore = s; role = key; }
  }
  if (explicitRole && roles[explicitRole]) {
    role = explicitRole;
    roleScore = Math.max(roleScore, 5);
  }
  const roleConfidence = Math.min(1, roleScore / 3);

  // Company match
  let company = null;
  let companyScore = 0;
  for (const [key, c] of Object.entries(kb().companies)) {
    const s = hitScore(text, c.keywords);
    if (s > companyScore) { companyScore = s; company = key; }
  }
  if (explicitCompany && kb().companies[explicitCompany]) {
    company = explicitCompany;
    companyScore = Math.max(companyScore, 3);
  }
  const companyConfidence = Math.min(1, companyScore / 2);

  // Topic/skill extraction
  const topicScores = [];
  for (const [key, t] of Object.entries(kb().topics)) {
    const s = hitScore(text, t.keywords);
    if (s > 0) topicScores.push({ topic: key, score: s });
  }
  topicScores.sort((a, b) => b.score - a.score);
  const topics = topicScores.slice(0, 6).map((t) => t.topic);
  const skills = topicScores.slice(0, 8).map((t) => topicLabel(t.topic));

  return {
    role,
    roleLabel: roleLabel(role),
    roleConfidence: Number(roleConfidence.toFixed(2)),
    company,
    companyLabel: companyInfo(company) ? companyInfo(company).label : null,
    companyConfidence: Number(companyConfidence.toFixed(2)),
    topics,
    skills,
    roleKeywords: roles[role] ? roles[role].keywords : [],
  };
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/**
 * Retrieve the most relevant questions for a profile.
 * Returns ranked question objects with a retrievalScore.
 */
function retrieve(profile, jdText, resumeText, { limit = 40, targetDifficulty = 2, excludeIds = [] } = {}) {
  const kbData = kb();
  const topicSet = new Set(profile.topics || []);
  const queryText = [
    jdText || '', resumeText || '',
    (profile.roleKeywords || []).join(' '),
    (profile.topics || []).join(' '),
  ].join('\n');
  const qEmbed = embed(queryText);

  const exclude = new Set(excludeIds);
  const results = [];

  for (const q of kbData.questions) {
    if (exclude.has(q.id)) continue;
    // role filter: question must target the profile role or be general
    const roleOk = (q.roles || []).includes(profile.role) || (q.roles || []).includes('general');
    if (!roleOk) continue;

    const sim = cosine(index.get(q.id), qEmbed);
    const topicOverlap = diceOverlap(topicSet, q.topics);
    const companyMatch = profile.company && (q.companies || []).includes(profile.company) ? 1 : 0;
    const diffFit = 1 - Math.min(Math.abs(q.difficulty - targetDifficulty), 2) * 0.15;

    const score = sim * 0.6 + topicOverlap * 0.35 + companyMatch * 0.5 + diffFit * 0.3;
    results.push({
      id: q.id,
      text: q.text,
      topics: q.topics || [],
      topicLabels: (q.topics || []).map(topicLabel),
      difficulty: q.difficulty,
      idealPoints: q.idealPoints || [],
      followUps: q.followUps || [],
      companies: q.companies || [],
      retrievalScore: Number(score.toFixed(4)),
    });
  }

  results.sort((a, b) => b.retrievalScore - a.retrievalScore);
  return results.slice(0, limit);
}

/** Question bank stats for the startup banner. */
function kbStats() {
  const d = kb();
  return {
    questions: d.questions.length,
    roles: Object.keys(d.roles).length,
    topics: Object.keys(d.topics).length,
    companies: Object.keys(d.companies).length,
  };
}

module.exports = { loadKb, persistKb, kbStats, inferProfile, retrieve, roleLabel, companyInfo, resourcesForTopics, topicLabel };
