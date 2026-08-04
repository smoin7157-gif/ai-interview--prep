'use strict';
const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const config = require('./config');
const db = require('./db');
const rag = require('./rag');
const llm = require('./llm');
const interview = require('./interview');
const auth = require('./auth');

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

/** A student may only touch their own sessions; teachers may touch any. */
function canAccess(user, session) {
  if (!session) return false;
  if (user.role === 'teacher') return true;
  return session.ownerId === user.id;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

// POST /api/auth/register — create an account and log in
router.post('/auth/register', wrap(async (req, res) => {
  const { username, password, role } = req.body || {};
  const clean = String(username || '').trim().toLowerCase();
  const pass = String(password || '');
  const r = role === 'teacher' ? 'teacher' : 'student';

  if (!/^[a-z0-9_]{3,20}$/.test(clean)) {
    return res.status(400).json({ error: 'Username must be 3–20 characters (letters, numbers, underscore).' });
  }
  if (pass.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  if (db.getUserByUsername(clean)) {
    return res.status(409).json({ error: 'That username is already taken — try another.' });
  }

  const user = { id: require('crypto').randomUUID(), username: clean, role: r, createdAt: db.nowIso() };
  db.createUser({ id: user.id, username: user.username, passwordHash: auth.hashPassword(pass), role: user.role });
  auth.loginUser(res, user.id);
  res.status(201).json({ user: db.publicUser(user) });
}));

// POST /api/auth/login
router.post('/auth/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const clean = String(username || '').trim().toLowerCase();
  const user = db.getUserByUsername(clean);
  if (!user || !auth.verifyPassword(String(password || ''), user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  auth.loginUser(res, user.id);
  res.json({ user: db.publicUser(user) });
}));

// POST /api/auth/logout
router.post('/auth/logout', (req, res) => {
  auth.logoutUser(req, res);
  res.json({ ok: true });
});

// GET /api/auth/me — current user (or { user: null } when logged out)
router.get('/auth/me', (req, res) => {
  res.json({ user: auth.PUBLIC_USER_FIELDS(auth.currentUser(req)) });
});

// ---------------------------------------------------------------------------
// Health & meta (public)
// ---------------------------------------------------------------------------

// GET /api/health
router.get('/health', (req, res) => {
  res.json({
    ok: true,
    llm: llm.isAvailable(),
    model: llm.isAvailable() ? config.openrouterModel : null,
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

// ---------------------------------------------------------------------------
// Question bank — teachers only
// ---------------------------------------------------------------------------

// GET /api/questions — full bank + taxonomies for the management UI
router.get('/questions', auth.requireAuth(['teacher']), (req, res) => {
  const kb = rag.loadKb();
  res.json({
    questions: kb.questions,
    roles: Object.entries(kb.roles).map(([id, r]) => ({ id, label: r.label })),
    topics: Object.entries(kb.topics).map(([id, t]) => ({ id, label: t.label })),
  });
});

// POST /api/questions — add a question
router.post('/questions', auth.requireAuth(['teacher']), wrap(async (req, res) => {
  const kb = rag.loadKb();
  const q = sanitizeQuestion(req.body);
  if (!q.text) return res.status(400).json({ error: 'Question text is required.' });
  q.id = 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  kb.questions.push(q);
  try {
    rag.persistKb();
    res.status(201).json({ question: q });
  } catch {
    res.status(500).json({ error: 'Could not save to the question bank (read-only filesystem on this host).' });
  }
}));

// PUT /api/questions/:id — edit a question
router.put('/questions/:id', auth.requireAuth(['teacher']), wrap(async (req, res) => {
  const kb = rag.loadKb();
  const idx = kb.questions.findIndex((q) => q.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Question not found.' });
  const patch = sanitizeQuestion(req.body);
  if (patch.text !== undefined && !patch.text) return res.status(400).json({ error: 'Question text is required.' });
  kb.questions[idx] = { ...kb.questions[idx], ...patch };
  try {
    rag.persistKb();
    res.json({ question: kb.questions[idx] });
  } catch {
    res.status(500).json({ error: 'Could not save to the question bank (read-only filesystem on this host).' });
  }
}));

// DELETE /api/questions/:id
router.delete('/questions/:id', auth.requireAuth(['teacher']), wrap(async (req, res) => {
  const kb = rag.loadKb();
  const before = kb.questions.length;
  kb.questions = kb.questions.filter((q) => q.id !== req.params.id);
  if (kb.questions.length === before) return res.status(404).json({ error: 'Question not found.' });
  try {
    rag.persistKb();
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Could not save to the question bank (read-only filesystem on this host).' });
  }
}));

/** Coerce user input into a valid question object (only known fields). */
function sanitizeQuestion(body) {
  const out = {};
  if (body.text !== undefined) out.text = String(body.text).trim();
  if (body.difficulty !== undefined) {
    const d = Number(body.difficulty);
    out.difficulty = Number.isFinite(d) ? Math.max(1, Math.min(3, Math.round(d))) : 1;
  }
  if (body.roles !== undefined) out.roles = Array.isArray(body.roles) ? body.roles.map(String) : [];
  if (body.topics !== undefined) out.topics = Array.isArray(body.topics) ? body.topics.map(String) : [];
  if (body.idealPoints !== undefined) {
    out.idealPoints = Array.isArray(body.idealPoints) ? body.idealPoints.map((x) => String(x).trim()).filter(Boolean) : [];
  }
  if (body.followUps !== undefined) {
    out.followUps = Array.isArray(body.followUps) ? body.followUps.map((x) => String(x).trim()).filter(Boolean) : [];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Teacher workspace
// ---------------------------------------------------------------------------

// GET /api/teacher/students — roster for assignments
router.get('/teacher/students', auth.requireAuth(['teacher']), (req, res) => {
  res.json({ students: db.listStudents() });
});

// POST /api/teacher/assign — create an interview session for a student
router.post('/teacher/assign', auth.requireAuth(['teacher']), wrap(async (req, res) => {
  const { studentId, role, company, questionCount } = req.body || {};
  const student = studentId ? db.getUserById(studentId) : null;
  if (!student || student.role !== 'student') {
    return res.status(400).json({ error: 'Pick a valid student to assign this interview to.' });
  }
  const result = await interview.startSession({
    role: role || undefined,
    company: company || undefined,
    jd: '',
    resumeText: '',
    questionCount,
    ownerId: student.id,
    assignedBy: req.user.id,
  });
  res.status(201).json({ sessionId: result.sessionId, profile: result.profile, student: db.publicUser(student) });
}));

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

// POST /api/sessions — create a session and open the interview
router.post('/sessions', auth.requireAuth(), wrap(async (req, res) => {
  const { role, company, jd, resumeText, questionCount } = req.body || {};
  if (!jd && !resumeText) {
    return res.status(400).json({ error: 'Provide a job description and/or resume text.' });
  }
  const result = await interview.startSession({
    role, company, jd, resumeText, questionCount,
    ownerId: req.user.id,
  });
  res.json(result);
}));

// GET /api/sessions — history (students see their own; teachers see all)
router.get('/sessions', auth.requireAuth(), (req, res) => {
  const sessions = (req.user.role === 'teacher' ? db.listSessions() : db.listSessions(req.user.id)).map((s) => ({
    ...s,
    roleLabel: s.role ? rag.roleLabel(s.role) : 'General',
    companyLabel: s.company ? ((rag.companyInfo(s.company) || {}).label || null) : null,
  }));
  res.json({ sessions });
});

// GET /api/sessions/:id — full record (turns + report)
router.get('/sessions/:id', auth.requireAuth(), (req, res) => {
  const session = db.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!canAccess(req.user, session)) return res.status(403).json({ error: 'This interview belongs to another account.' });
  const turns = db.getTurns(req.params.id);
  if (session.assignedBy) {
    const teacher = db.getUserById(session.assignedBy);
    if (teacher) session.assignedByUsername = teacher.username;
  }
  res.json({ session, turns });
});

// POST /api/sessions/:id/answer — submit an answer, get scoring + next question
router.post('/sessions/:id/answer', auth.requireAuth(), wrap(async (req, res) => {
  const session = db.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!canAccess(req.user, session)) return res.status(403).json({ error: 'This interview belongs to another account.' });
  const { answer } = req.body || {};
  const result = await interview.submitAnswer(req.params.id, answer);
  res.json(result);
}));

// POST /api/sessions/:id/complete — finish and generate the report
router.post('/sessions/:id/complete', auth.requireAuth(), wrap(async (req, res) => {
  const session = db.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!canAccess(req.user, session)) return res.status(403).json({ error: 'This interview belongs to another account.' });
  const result = await interview.completeSession(req.params.id);
  res.json(result);
}));

// ---------------------------------------------------------------------------
// Resume extraction
// ---------------------------------------------------------------------------

// POST /api/resume/extract — upload a resume file, get extracted text
router.post('/resume/extract', auth.requireAuth(), upload.single('file'), wrap(async (req, res) => {
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
