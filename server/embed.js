'use strict';
/**
 * Lightweight lexical embeddings for the RAG pipeline.
 *
 * Instead of requiring a neural embedding model (which downloads hundreds of MB
 * on first run), we build sparse vector embeddings from:
 *   - word tokens (with a small synonym normalizer)
 *   - character 3-grams (robust to typos and technical vocabulary)
 *
 * Cosine similarity over these sparse vectors gives strong retrieval quality
 * for a small, curated knowledge base and runs fully offline. The module is
 * intentionally isolated so a neural embedder can be swapped in later.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'when', 'while',
  'how', 'why', 'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did',
  'have', 'has', 'had', 'will', 'would', 'can', 'could', 'should', 'shall', 'may',
  'might', 'must', 'of', 'in', 'on', 'at', 'to', 'for', 'from', 'by', 'with',
  'about', 'into', 'over', 'under', 'between', 'as', 'than', 'so', 'such', 'not',
  'no', 'nor', 'only', 'own', 'same', 'too', 'very', 'just', 'also', 'your', 'you',
  'my', 'me', 'mine', 'our', 'ours', 'us', 'their', 'they', 'them', 'it', 'its',
  'he', 'she', 'his', 'her', 'hers', 'we', 'i', 'im', 'ive', 'id', 'ive', 'lets',
  'let', 'tell', 'explain', 'describe', 'talk', 'please', 'walk', 'me', 'through',
  'time', 'one', 'two', 'ever', 'used', 'use', 'using', 'make', 'made', 'get', 'got',
  'give', 'like', 'want', 'need', 'know', 'thing', 'things', 'people', 'work',
  'would', 'could', 'should', 'also', 'way', 'ways', 'part', 'parts', 'many', 'much',
  'some', 'any', 'each', 'every', 'really', 'actually', 'usually', 'however',
  'first', 'second', 'last', 'next', 'look', 'see', 'say', 'said', 'good', 'great',
  'well', 'better', 'best', 'big', 'small', 'new', 'old', 'different', 'around',
  'before', 'after', 'during', 'until', 'where', 'here', 'there', 'always', 'never',
]);

// Normalize common variants so "front-end", "frontend", "ui developer" all match.
const SYNONYMS = {
  frontend: 'frontend', 'front-end': 'frontend', 'front end': 'frontend',
  'ui developer': 'frontend', 'web developer': 'frontend',
  backend: 'backend', 'back-end': 'backend', 'back end': 'backend',
  'software engineer': 'swe', 'software engineering': 'swe', sde: 'swe',
  developer: 'swe', 'software developer': 'swe', programmer: 'swe', engineering: 'swe',
  'machine learning': 'ml', 'deep learning': 'ml', 'data science': 'ml',
  'data scientist': 'ml', 'ml engineer': 'ml', 'ai engineer': 'ml', ai: 'ml',
  'product manager': 'pm', 'product management': 'pm', 'product owner': 'pm', pm: 'pm',
  devops: 'devops', 'site reliability': 'sre', sre: 'sre',
  qa: 'qa', 'quality assurance': 'qa', tester: 'qa', 'test engineer': 'qa',
  javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts',
  'data structures': 'dsa', algorithms: 'dsa', algorithm: 'dsa', dsa: 'dsa',
  'system design': 'system-design', architecture: 'system-design', architectures: 'system-design',
  database: 'db', databases: 'db', sql: 'db', nosql: 'db',
  kubernetes: 'k8s', k8s: 'k8s',
  amazon: 'amazon', aws: 'aws', google: 'google', microsoft: 'microsoft',
  meta: 'meta', facebook: 'meta', flipkart: 'flipkart',
};

function tokenize(text) {
  if (!text) return [];
  const out = [];
  const lower = text.toLowerCase();
  // Words
  for (const raw of lower.split(/[^a-z0-9+.#%$-]+/)) {
    if (!raw || raw.length < 2) continue;
    const tok = SYNONYMS[raw] || raw;
    if (!STOPWORDS.has(tok)) out.push(tok);
  }
  // Char 3-grams (prefix with ## to separate from words)
  const clean = lower.replace(/[^a-z0-9]/g, '');
  if (clean.length >= 3) {
    for (let i = 0; i <= clean.length - 3; i++) out.push('##' + clean.slice(i, i + 3));
  }
  return out;
}

/** Build a sparse embedding { term: count } from text. */
function embed(text) {
  const vec = new Map();
  for (const tok of tokenize(text)) vec.set(tok, (vec.get(tok) || 0) + 1);
  return vec;
}

/** Cosine similarity between two sparse Maps (term -> count). */
function cosine(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (const [t, c] of a) { na += c * c; if (b.has(t)) dot += c * b.get(t); }
  for (const [, c] of b) nb += c * c;
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Overlap of two keyword sets, normalized (Dice-ish). */
function diceOverlap(aSet, bList) {
  if (!bList || bList.length === 0) return 0;
  let hits = 0;
  for (const b of bList) if (aSet.has(b)) hits++;
  return hits / bList.length;
}

module.exports = { tokenize, embed, cosine, diceOverlap, STOPWORDS, SYNONYMS };
