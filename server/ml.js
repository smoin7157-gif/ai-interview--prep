'use strict';
/**
 * ML answer scoring.
 *
 * Instead of relying purely on LLM judgment (which would make this a "GPT
 * wrapper"), we score answers with a lightweight logistic-regression classifier
 * trained on labeled answer-quality data:
 *
 *   features  = [length, STAR coverage, action verbs, relevance,
 *                filler penalty, quantified evidence, clarity]
 *   label     = 1 (good answer) / 0 (weak answer)
 *
 * The classifier is trained at startup on an embedded, deterministic synthetic
 * dataset that encodes the rubric. `trainFromLabeledRows()` is exposed so real
 * human-labeled answers can be dropped in later without changing the pipeline.
 */

const { embed, cosine } = require('./embed');

// ---------------------------------------------------------------------------
// Feature extraction
// ---------------------------------------------------------------------------

const FILLERS = ['um', 'umm', 'uh', 'uhh', 'hmm', 'you know', 'basically', 'actually', 'sort of', 'kind of', 'i mean', 'like '];

const STAR_SITUATION = ['situation', 'context', 'when i was', 'in my previous', 'in my last', 'at my previous', 'during my', 'while working', 'i was working', 'back when', 'in my team'];
const STAR_TASK = ['task', 'responsibility', 'i was responsible', 'needed to', 'had to', 'goal was', 'objective', 'assigned', 'expected to', 'my job was'];
const STAR_ACTION = ['i did', 'i implemented', 'i built', 'i led', 'i created', 'i designed', 'i improved', 'i introduced', 'i developed', 'i wrote', 'i took', 'i launched', 'i automated', 'i redesigned', 'i shipped', 'i set up', 'i organized', 'i started', 'i fixed', 'i resolved', 'i coordinated', 'i drove', 'i owned'];
const STAR_RESULT = ['result', 'as a result', 'outcome', 'increased', 'decreased', 'reduced', 'improved', 'percent', 'metrics', 'impact', 'achieved', 'delivered', 'grew', 'boosted', 'saved', 'earned', 'adoption', 'conversion', 'revenue'];

const ACTION_VERBS = ['implemented', 'built', 'led', 'created', 'designed', 'improved', 'introduced', 'developed', 'wrote', 'launched', 'automated', 'redesigned', 'shipped', 'organized', 'started', 'fixed', 'resolved', 'coordinated', 'drove', 'owned', 'optimized', 'migrated', 'integrated'];

function countHits(text, phrases) {
  let n = 0;
  for (const p of phrases) {
    const idx = text.indexOf(p);
    if (idx !== -1) n++;
  }
  return n;
}

function sentences(text) {
  const parts = text.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 0);
  return parts.length ? parts : [text];
}

function extractFeatures(answerText, questionText, idealPoints) {
  const raw = answerText || '';
  const lower = raw.toLowerCase();
  const words = lower.split(/[^a-z']+/).filter((w) => w.length > 0);
  const wordCount = words.length;

  // STAR coverage
  const sHit = countHits(lower, STAR_SITUATION) > 0 ? 1 : 0;
  const tHit = countHits(lower, STAR_TASK) > 0 ? 1 : 0;
  const aHit = countHits(lower, STAR_ACTION) > 0 ? 1 : 0;
  const rHit = countHits(lower, STAR_RESULT) > 0 ? 1 : 0;
  const starCoverage = (sHit + tHit + aHit + rHit) / 4;

  // Action verbs ("I implemented ...")
  let actionCount = 0;
  for (const verb of ACTION_VERBS) if (lower.includes('i ' + verb)) actionCount++;
  const actionRatio = Math.min(actionCount / 3, 1);

  // Fillers
  let fillerCount = 0;
  for (const f of FILLERS) {
    const re = new RegExp(f.replace(/ /g, '\\s+'), 'g');
    const m = lower.match(re);
    if (m) fillerCount += m.length;
  }
  const fillerDensity = wordCount ? fillerCount / wordCount : 0;
  const fillerPenalty = Math.max(0, 1 - Math.min(fillerDensity / 0.12, 1));

  // Quantified evidence
  const quantified = /\d/.test(raw) || /%|percent|rupees|inr|lakh|crore|dollars|\$/.test(lower) ? 1 : 0;

  // Relevance to the question (lexical)
  const queryText = (questionText || '') + ' ' + (idealPoints || []).join(' ');
  const relevance = cosine(embed(raw), embed(queryText));

  // Length score: weak when too short or rambling, ideal ~60-220 words
  let lengthScore;
  if (wordCount < 20) lengthScore = wordCount / 60;
  else if (wordCount <= 220) lengthScore = 1;
  else if (wordCount <= 400) lengthScore = 1 - (wordCount - 220) / 180 * 0.5;
  else lengthScore = 0.5;

  // Clarity: words per sentence in a healthy band (~8-25)
  const sents = sentences(raw);
  const wps = wordCount / Math.max(sents.length, 1);
  let clarityScore = 1;
  if (wps < 8) clarityScore = Math.max(0.15, wps / 8);
  if (wps > 25) clarityScore = Math.max(0.15, 1 - (wps - 25) / 20);

  return {
    wordCount,
    fillerCount,
    fillerDensity,
    fillerPenalty,
    star: { situation: sHit, task: tHit, action: aHit, result: rHit, coverage: starCoverage },
    actionRatio,
    quantified,
    relevance,
    lengthScore,
    clarityScore,
    features: [lengthScore, starCoverage, actionRatio, relevance, fillerPenalty, quantified, clarityScore],
  };
}

// ---------------------------------------------------------------------------
// Lightweight logistic regression
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

/**
 * Binary logistic regression trained with mini-batch gradient descent + L2.
 * Returns {w, b, mean, std} ready for predict().
 */
function trainLogistic(X, y, { iters = 700, lr = 0.25, lambda = 1e-4, seed = 42 } = {}) {
  const n = X.length;
  const d = X[0].length;
  const rnd = mulberry32(seed);

  const mean = new Array(d).fill(0);
  const std = new Array(d).fill(0);
  for (const row of X) for (let j = 0; j < d; j++) mean[j] += row[j];
  for (let j = 0; j < d; j++) mean[j] /= n;
  for (const row of X) for (let j = 0; j < d; j++) std[j] += (row[j] - mean[j]) ** 2;
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j] / n) || 1;

  const Xs = X.map((row) => row.map((v, j) => (v - mean[j]) / std[j]));
  let w = new Array(d).fill(0).map(() => (rnd() - 0.5) * 0.1);
  let b = 0;

  for (let it = 0; it < iters; it++) {
    let gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * Xs[i][j];
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < d; j++) gw[j] += err * Xs[i][j];
      gb += err;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + lambda * w[j]);
    b -= lr * (gb / n);
  }
  return { w, b, mean, std };
}

function predictProbability(model, rawFeatures) {
  let z = model.b;
  for (let j = 0; j < rawFeatures.length; j++) {
    z += model.w[j] * ((rawFeatures[j] - model.mean[j]) / model.std[j]);
  }
  return sigmoid(z);
}

/** Train from real labeled rows: [{features, label}] (0/1). */
function trainFromLabeledRows(rows, opts) {
  return trainLogistic(rows.map((r) => r.features), rows.map((r) => r.label), opts);
}

// Synthetic rubric dataset: encodes what a "good" vs "weak" answer looks like
// on the feature space, with noise for robustness. Deterministic (seed 42).
function syntheticDataset() {
  const rnd = mulberry32(424242);
  const rows = [];
  const goodBase = [0.85, 0.95, 0.85, 0.8, 0.95, 0.9, 0.9];
  const weakBase = [0.3, 0.15, 0.1, 0.3, 0.5, 0.1, 0.45];
  for (let i = 0; i < 160; i++) {
    const good = i % 2 === 0;
    const base = good ? goodBase : weakBase;
    const feat = base.map((v) => clamp01(v + (rnd() - 0.5) * 0.3));
    rows.push({ features: feat, label: good ? 1 : 0 });
  }
  // A few borderline cases to keep the boundary realistic
  for (let i = 0; i < 40; i++) {
    const good = rnd() > 0.5;
    const base = good ? [0.65, 0.6, 0.55, 0.6, 0.7, 0.55, 0.65] : [0.4, 0.35, 0.3, 0.4, 0.6, 0.2, 0.5];
    const feat = base.map((v) => clamp01(v + (rnd() - 0.5) * 0.2));
    rows.push({ features: feat, label: good ? 1 : 0 });
  }
  return rows;
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

// Train once at startup on the deterministic rubric dataset.
const TRAIN_DATA = syntheticDataset();
const MODEL = trainLogistic(TRAIN_DATA.map((r) => r.features), TRAIN_DATA.map((r) => r.label));

// ---------------------------------------------------------------------------
// Scoring API
// ---------------------------------------------------------------------------

/**
 * Score a single answer. Returns structured 0-100 scores + feature details.
 */
function evaluateAnswer(answerText, questionText, idealPoints) {
  const f = extractFeatures(answerText, questionText, idealPoints);
  const mlProb = predictProbability(MODEL, f.features);

  const criteria = {
    star: Math.round(f.star.coverage * 100),
    relevance: Math.round(f.relevance * 100),
    structure: Math.round((f.actionRatio * 0.6 + f.lengthScore * 0.4) * 100),
    clarity: Math.round(f.clarityScore * 100),
    evidence: Math.round(f.quantified * 100),
  };

  const composite =
    criteria.star * 0.25 + criteria.relevance * 0.2 + criteria.structure * 0.2 +
    criteria.clarity * 0.2 + criteria.evidence * 0.15;

  const overall = Math.round(0.5 * mlProb * 100 + 0.5 * composite);

  return {
    overall: clampScore(overall),
    mlProbability: Number(mlProb.toFixed(3)),
    criteria,
    features: {
      wordCount: f.wordCount,
      fillerCount: f.fillerCount,
      fillerDensity: Number(f.fillerDensity.toFixed(4)),
      starCoverage: Number(f.star.coverage.toFixed(2)),
      actionRatio: Number(f.actionRatio.toFixed(2)),
      quantified: !!f.quantified,
      relevance: Number(f.relevance.toFixed(3)),
      clarityScore: Number(f.clarityScore.toFixed(2)),
      lengthScore: Number(f.lengthScore.toFixed(2)),
    },
    star: f.star,
  };
}

function clampScore(v) { return Math.max(0, Math.min(100, Math.round(v))); }

/**
 * Aggregate scoring stats across answer turns for the post-interview report.
 */
function computeReportStats(turns) {
  const answers = turns.filter((t) => t.kind === 'answer' && typeof t.score === 'number' && t.scoreJson);
  const stats = {
    sampleSize: answers.length,
    avg: 0,
    perCriterion: { star: [], relevance: [], structure: [], clarity: [], evidence: [] },
    perTopic: {},
    totalFillers: 0,
    avgWordCount: 0,
    avgRelevance: 0,
    starCoverageAvg: 0,
  };
  if (!answers.length) return stats;

  const criterionKeys = Object.keys(stats.perCriterion);
  for (const a of answers) {
    stats.avg += a.score;
    const sj = a.scoreJson;
    for (const k of criterionKeys) {
      const v = sj && sj.criteria && sj.criteria[k];
      if (typeof v === 'number') stats.perCriterion[k].push(v);
    }
    stats.totalFillers += (sj && sj.features && sj.features.fillerCount) || 0;
    stats.avgWordCount += (sj && sj.features && sj.features.wordCount) || 0;
    stats.avgRelevance += (sj && sj.features && sj.features.relevance) || 0;
    stats.starCoverageAvg += (sj && sj.features && sj.features.starCoverage) || 0;

    const topic = a.topic || 'general';
    if (!stats.perTopic[topic]) stats.perTopic[topic] = { count: 0, sum: 0, scores: [] };
    stats.perTopic[topic].count++;
    stats.perTopic[topic].sum += a.score;
    stats.perTopic[topic].scores.push(a.score);
  }

  stats.avg = Math.round(stats.avg / answers.length);
  stats.avgWordCount = Math.round(stats.avgWordCount / answers.length);
  stats.avgRelevance = Number((stats.avgRelevance / answers.length).toFixed(3));
  stats.starCoverageAvg = Number((stats.starCoverageAvg / answers.length).toFixed(2));

  const avgCriterion = {};
  for (const k of criterionKeys) {
    const arr = stats.perCriterion[k];
    avgCriterion[k] = arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : 0;
  }
  stats.perCriterion = avgCriterion;

  const topicStats = {};
  for (const [topic, t] of Object.entries(stats.perTopic)) {
    topicStats[topic] = { count: t.count, avg: Math.round(t.sum / t.count) };
  }
  stats.perTopic = topicStats;
  return stats;
}

module.exports = { evaluateAnswer, computeReportStats, extractFeatures, trainFromLabeledRows };
