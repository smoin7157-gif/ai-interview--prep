'use strict';
const path = require('path');
const express = require('express');
const config = require('./config');
const rag = require('./rag');
const llm = require('./llm');
const routes = require('./routes');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '6mb' }));

app.use('/api', routes);

// Static SPA
app.use(express.static(config.publicDir));
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(config.publicDir, 'index.html'));
});

// 404 for unknown API routes
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  let status = 500;
  if (err && err.name === 'MulterError') {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
  } else if (err && err.message) {
    if (err.message.includes('file type')) status = 400;
    else if (err.message === 'Answer is empty') status = 400;
    else if (err.message === 'Session not found') status = 404;
    else if (err.message === 'Interview is over') status = 400;
  }
  console.error(`[${new Date().toISOString()}] ${err.message}`);
  res.status(status).json({ error: err.message || 'Internal error' });
});

module.exports = app;

// Start the HTTP server only when run directly (required by the Vercel
// serverless adapter, which imports `app` via api/index.js).
if (require.main === module) {
  app.listen(config.port, () => {
    const stats = rag.kbStats();
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║        AI Interview Prep & Feedback Platform              ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log(`  ➜ Local:      http://localhost:${config.port}`);
    console.log(`  ➜ Knowledge base: ${stats.questions} questions · ${stats.roles} roles · ${stats.topics} topics · ${stats.companies} company patterns`);
    console.log(`  ➜ LLM engine: ${llm.isAvailable() ? 'OpenRouter (' + config.openrouterModel + ')' : 'offline rule-based (set OPENROUTER_API_KEY in .env to enable the LLM)'}`);
    console.log('');
  });
}
