'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ROOT = path.join(__dirname, '..');

module.exports = {
  root: ROOT,
  port: Number(process.env.PORT || 3000),
  publicDir: path.join(ROOT, 'public'),
  dataDir: path.join(ROOT, 'data'),
  dbPath: path.join(ROOT, 'data', 'sessions.db'),
  kbPath: path.join(ROOT, 'data', 'knowledge-base.json'),

  // OpenRouter (OpenAI-compatible). Empty key => offline rule-based engine.
  openrouterApiKey: (process.env.OPENROUTER_API_KEY || '').trim(),
  openrouterModel: process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
  openrouterBaseUrl: 'https://openrouter.ai/api/v1',
  llmTimeoutMs: 60000,

  defaultQuestionCount: 6,
  minQuestionCount: 3,
  maxQuestionCount: 12,
};
