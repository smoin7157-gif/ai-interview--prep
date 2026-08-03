'use strict';
const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const db = require('./db');
const rag = require('./rag');
const llm = require('./llm');
const interview = require('./interview');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = (file.originalname.split('.').pop() || '').toLowerCase();
    if (['pdf', 'docx', 'txt'].includes(ext)) return cb(null, true);
    cb(new Error('Unsupported file type. Please upload a .pdf, .docx, or .txt file.'));
  },
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// GET /api/health
router.get('/health', (req, res) => {
  res.json({
    ok: true,
    llm: llm.isAvailable(),
    model: llm.isAvailable() ? llm.openrouterModel : null,
    kb: rag.kbStats(),
    sessions: db.listSessions().length,
  });
});

// GET /api/meta/roles — available roles + companies for the setup UI
router.get('/meta/roles', (req, res) => {
  const kb = rag.loadKb();
  res.json({
    roles: Object.entries(kb.roles).map(([id, r]) => ({ id, label: r.label })),
    companies: Object.entries(kb.companies).map(([id, c]) => ({ id, label: c.label })),
  });
});

// POST /api/sessions — create a session and open the interview
router.post('/sessions', wrap(async (req, res) => {
  const { role, company, jd, resumeText, questionCount } = req.body || {};
  if (!jd && !resumeText) {
    return res.status(400).json({ error: 'Provide a job description and/or resume text.' });
  }
  const result = await interview.startSession({ role, company, jd, resumeText, questionCount });
  res.json(result);
}));

// GET /api/sessions — history
router.get('/sessions', (req, res) => {
  res.json({ sessions: db.listSessions() });
});

// GET /api/sessions/:id — full record (turns + report)
router.get('/sessions/:id', (req, res) => {
  const session = db.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const turns = db.getTurns(req.params.id);
  res.json({ session, turns });
});

// POST /api/sessions/:id/answer — submit an answer, get scoring + next question
router.post('/sessions/:id/answer', wrap(async (req, res) => {
  const { answer } = req.body || {};
  const result = await interview.submitAnswer(req.params.id, answer);
  res.json(result);
}));

// POST /api/sessions/:id/complete — finish and generate the report
router.post('/sessions/:id/complete', wrap(async (req, res) => {
  const result = await interview.completeSession(req.params.id);
  res.json(result);
}));

// POST /api/resume/extract — upload a resume file, get extracted text
router.post('/resume/extract', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const text = await extractText(req.file);
  if (!text || text.trim().length < 10) {
    return res.status(422).json({ error: 'Could not extract meaningful text (scanned PDF?). Try a .txt/.docx file.' });
  }
  res.json({ text: text.trim(), fileName: req.file.originalname, chars: text.trim().length });
}));

async function extractText(file) {
  const ext = (file.originalname.split('.').pop() || '').toLowerCase();
  if (ext === 'txt') return file.buffer.toString('utf8');
  if (ext === 'pdf') {
    const parsed = await pdfParse(file.buffer);
    return parsed.text || '';
  }
  if (ext === 'docx') {
    const parsed = await mammoth.extractRawText({ buffer: file.buffer });
    return parsed.value || '';
  }
  throw new Error('Unsupported file type');
}

module.exports = router;
