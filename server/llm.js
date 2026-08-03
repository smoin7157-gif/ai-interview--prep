'use strict';
/**
 * LLM layer — talks to OpenRouter (OpenAI-compatible chat completions).
 *
 * Every high-level function returns `null` instead of throwing when the LLM is
 * unavailable (no API key, network error, bad JSON), so the app degrades
 * gracefully to the built-in rule-based engine.
 */

const config = require('./config');

function isAvailable() {
  return !!config.openrouterApiKey;
}

async function chat(messages, { temperature = 0.7, maxTokens = 900 } = {}) {
  if (!isAvailable()) throw new Error('No OpenRouter API key configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.llmTimeoutMs);
  try {
    const res = await fetch(`${config.openrouterBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.openrouterApiKey}`,
      },
      body: JSON.stringify({
        model: config.openrouterModel,
        messages,
        temperature,
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error('Empty LLM response');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/** Robustly extract a JSON object from an LLM response (handles markdown fences). */
function parseJSON(text) {
  if (!text) return null;
  let t = text.trim();
  // strip ```json ... ```
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

const sys = (extra) => ({
  role: 'system',
  content: 'You are a sharp, empathetic senior technical interviewer and feedback coach. ' + extra,
});

// ---------------------------------------------------------------------------
// High-level helpers (all return null on failure)
// ---------------------------------------------------------------------------

/** Tailored first question generated from the resume + JD. */
async function generateOpeningQuestion(profile, jdText, resumeText) {
  const prompt = [
    sys(`You prepare candidates for a ${profile.roleLabel} interview${profile.companyLabel ? ' at ' + profile.companyLabel : ''}.`),
    {
      role: 'user',
      content: [
        `Job description:\n${(jdText || 'Not provided').slice(0, 3000)}`,
        `Resume:\n${(resumeText || 'Not provided').slice(0, 3000)}`,
        `Candidate profile: role=${profile.roleLabel}, skills=${(profile.skills || []).join(', ') || 'n/a'}.`,
        'Create ONE tailored opening interview question — the most important thing this candidate should be asked first, based on their specific background. Prefer a behavioral or experience-based question that warms them up.',
        'Respond ONLY with JSON: {"text": "...", "topic": "behavioral" or "hr" or similar, "difficulty": 1}',
      ].join('\n\n'),
    },
  ];
  try {
    const raw = await chat(prompt, { temperature: 0.8, maxTokens: 300 });
    const j = parseJSON(raw);
    if (j && j.text) return j;
  } catch (e) { /* fallback below */ }
  return null;
}

/** One follow-up question that probes depth based on the candidate's answer. */
async function generateFollowUp(questionText, answerText, idealPoints, difficulty) {
  const prompt = [
    sys('You probe answers like a great interviewer — one sharp, specific follow-up at a time.'),
    {
      role: 'user',
      content: [
        `Original question: ${questionText}`,
        `What a strong answer should include: ${(idealPoints || []).join('; ')}`,
        `Candidate's answer: ${(answerText || '').slice(0, 3000)}`,
        `Difficulty level (1-3): ${difficulty}`,
        'The answer was judged weak or shallow. Generate ONE concise follow-up question that (a) targets the missing piece, or (b) asks for a concrete example/numbers.',
        'Respond ONLY with JSON: {"text": "..."}',
      ].join('\n\n'),
    },
  ];
  try {
    const raw = await chat(prompt, { temperature: 0.7, maxTokens: 250 });
    const j = parseJSON(raw);
    if (j && j.text) return j;
  } catch (e) { /* fallback below */ }
  return null;
}

/** LLM judge for a single answer. */
async function evaluateAnswer(questionText, answerText, idealPoints) {
  const prompt = [
    sys('You grade mock-interview answers. Be fair, specific, and encouraging.'),
    {
      role: 'user',
      content: [
        `Question: ${questionText}`,
        `What a strong answer includes: ${(idealPoints || []).join('; ')}`,
        `Answer: ${(answerText || '').slice(0, 3500)}`,
        'Grade on relevance to the question, structure (STAR for behavioral), clarity, and evidence (numbers).',
        'Respond ONLY with JSON: {"score": 0-100, "verdict": "one short sentence", "strengths": ["2-3 short bullets"], "improvements": ["2-3 short bullets"]}',
      ].join('\n\n'),
    },
  ];
  try {
    const raw = await chat(prompt, { temperature: 0.4, maxTokens: 400 });
    const j = parseJSON(raw);
    if (j && typeof j.score === 'number') {
      return {
        score: Math.max(0, Math.min(100, Math.round(j.score))),
        verdict: j.verdict || '',
        strengths: Array.isArray(j.strengths) ? j.strengths.slice(0, 3) : [],
        improvements: Array.isArray(j.improvements) ? j.improvements.slice(0, 3) : [],
      };
    }
  } catch (e) { /* fallback below */ }
  return null;
}

/** Full post-interview report. */
async function generateReport(context) {
  const prompt = [
    sys('You write concise, actionable post-interview feedback reports.'),
    {
      role: 'user',
      content: [
        `Role: ${context.roleLabel || 'general'}${context.companyLabel ? ' at ' + context.companyLabel : ''}`,
        `Overall score: ${context.avg}/100 across ${context.sampleSize} answers.`,
        `Per-criterion: ${JSON.stringify(context.perCriterion)}`,
        `Per-topic: ${JSON.stringify(context.perTopic)}`,
        `Company patterns to address: ${(context.companyThemes || []).join('; ') || 'none'}`,
        'Write a short, warm, specific report.',
        'Respond ONLY with JSON: {"summary": "2-3 sentences", "strengths": ["2-3 bullets"], "gaps": ["2-3 bullets"], "resources": ["2-3 concrete resources"]}',
      ].join('\n\n'),
    },
  ];
  try {
    const raw = await chat(prompt, { temperature: 0.6, maxTokens: 600 });
    const j = parseJSON(raw);
    if (j && j.summary) return j;
  } catch (e) { /* fallback below */ }
  return null;
}

module.exports = { isAvailable, chat, parseJSON, generateOpeningQuestion, generateFollowUp, evaluateAnswer, generateReport };
