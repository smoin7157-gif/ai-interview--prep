'use strict';
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

// Some deployments (e.g. Vercel serverless) have a read-only project filesystem.
// Fall back to an in-memory database there so the app still runs (sessions just
// won't persist between function invocations — see README for production options).
let db;
try {
  fs.mkdirSync(config.dataDir, { recursive: true });
  db = new DatabaseSync(config.dbPath);
} catch {
  db = new DatabaseSync(':memory:');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT PRIMARY KEY,
    role         TEXT,
    company      TEXT,
    jd_text      TEXT,
    resume_text  TEXT,
    profile_json TEXT,
    queue_json   TEXT,
    state_json   TEXT,
    status       TEXT DEFAULT 'active',
    total_score  REAL,
    report_json  TEXT,
    created_at   TEXT,
    completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS turns (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT,
    turn_index  INTEGER,
    kind        TEXT,
    speaker     TEXT,
    question    TEXT,
    answer      TEXT,
    topic       TEXT,
    difficulty  INTEGER,
    score       REAL,
    score_json  TEXT,
    feedback    TEXT,
    created_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);

  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'student',
    created_at    TEXT
  );
  CREATE TABLE IF NOT EXISTS auth_tokens (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    created_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);
`);

// Lightweight migration for DBs created before the roles feature existed.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('sessions', 'owner_id', 'owner_id TEXT');
ensureColumn('sessions', 'assigned_by', 'assigned_by TEXT');

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function createSession({ id, role, company, jdText, resumeText, profile, queue, state, ownerId = null, assignedBy = null }) {
  db.prepare(
    `INSERT INTO sessions
       (id, role, company, jd_text, resume_text, profile_json, queue_json, state_json, status, created_at, owner_id, assigned_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
  ).run(id, role || null, company || null, jdText || '', resumeText || '',
        JSON.stringify(profile), JSON.stringify(queue), JSON.stringify(state),
        nowIso(), ownerId, assignedBy);
}

function getSession(id) {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!row) return null;
  return {
    id: row.id,
    role: row.role,
    company: row.company,
    jdText: row.jd_text,
    resumeText: row.resume_text,
    profile: safeJson(row.profile_json),
    queue: safeJson(row.queue_json, []),
    state: safeJson(row.state_json),
    status: row.status,
    totalScore: row.total_score,
    report: safeJson(row.report_json),
    createdAt: row.created_at,
    completedAt: row.completed_at,
    ownerId: row.owner_id,
    assignedBy: row.assigned_by,
  };
}

function updateSession(id, patch = {}) {
  const cols = [];
  const vals = [];
  if (patch.profile !== undefined) { cols.push('profile_json = ?'); vals.push(JSON.stringify(patch.profile)); }
  if (patch.queue !== undefined) { cols.push('queue_json = ?'); vals.push(JSON.stringify(patch.queue)); }
  if (patch.state !== undefined) { cols.push('state_json = ?'); vals.push(JSON.stringify(patch.state)); }
  if (patch.status !== undefined) { cols.push('status = ?'); vals.push(patch.status); }
  if (patch.totalScore !== undefined) { cols.push('total_score = ?'); vals.push(patch.totalScore); }
  if (patch.report !== undefined) { cols.push('report_json = ?'); vals.push(JSON.stringify(patch.report)); }
  if (patch.completedAt !== undefined) { cols.push('completed_at = ?'); vals.push(patch.completedAt); }
  if (cols.length === 0) return;
  db.prepare(`UPDATE sessions SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);
}

function addTurn(sessionId, turn) {
  const turnIndex = db.prepare(
    'SELECT COALESCE(MAX(turn_index), -1) + 1 AS n FROM turns WHERE session_id = ?'
  ).get(sessionId).n;
  const row = {
    sessionId,
    turnIndex,
    kind: turn.kind || 'message',
    speaker: turn.speaker || 'ai',
    question: turn.question ?? null,
    answer: turn.answer ?? null,
    topic: turn.topic ?? null,
    difficulty: turn.difficulty ?? null,
    score: turn.score ?? null,
    scoreJson: turn.scoreJson ? JSON.stringify(turn.scoreJson) : null,
    feedback: turn.feedback ?? null,
    createdAt: nowIso(),
  };
  db.prepare(
    `INSERT INTO turns (session_id, turn_index, kind, speaker, question, answer, topic, difficulty, score, score_json, feedback, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(row.sessionId, row.turnIndex, row.kind, row.speaker, row.question, row.answer,
        row.topic, row.difficulty, row.score, row.scoreJson, row.feedback, row.createdAt);
  return row;
}

function getTurns(sessionId) {
  const rows = db.prepare(
    'SELECT * FROM turns WHERE session_id = ? ORDER BY turn_index ASC'
  ).all(sessionId);
  return rows.map((r) => ({
    id: r.id,
    turnIndex: r.turn_index,
    kind: r.kind,
    speaker: r.speaker,
    question: r.question,
    answer: r.answer,
    topic: r.topic,
    difficulty: r.difficulty,
    score: r.score,
    scoreJson: safeJson(r.score_json),
    feedback: r.feedback,
    createdAt: r.created_at,
  }));
}

/**
 * Session list (newest first). Pass `ownerId` to scope to one student; omit to
 * list every session (teachers).
 */
function listSessions(ownerId = null) {
  const sql = `
    SELECT s.id, s.role, s.company, s.status, s.total_score, s.created_at, s.completed_at,
           s.owner_id, s.assigned_by, u.username AS owner_username, t.username AS assigned_by_username,
      (SELECT COUNT(*) FROM turns t2 WHERE t2.session_id = s.id AND t2.kind = 'question') AS question_count
    FROM sessions s
    LEFT JOIN users u ON u.id = s.owner_id
    LEFT JOIN users t ON t.id = s.assigned_by
    ${ownerId ? 'WHERE s.owner_id = ?' : ''}
    ORDER BY s.created_at DESC
  `;
  const rows = ownerId ? db.prepare(sql).all(ownerId) : db.prepare(sql).all();
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    company: r.company,
    status: r.status,
    totalScore: r.total_score,
    questionCount: r.question_count,
    createdAt: r.created_at,
    completedAt: r.completed_at,
    ownerId: r.owner_id,
    assignedBy: r.assigned_by,
    ownerUsername: r.owner_username,
    assignedByUsername: r.assigned_by_username,
  }));
}

function getCompletedSessions(ownerId = null) {
  const sql = `
    SELECT id, role, company, total_score, created_at FROM sessions
    WHERE status = 'completed' ${ownerId ? 'AND owner_id = ?' : ''}
    ORDER BY created_at ASC
  `;
  const rows = ownerId ? db.prepare(sql).all(ownerId) : db.prepare(sql).all();
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    company: r.company,
    totalScore: r.total_score,
    createdAt: r.created_at,
  }));
}

// ---------------------------------------------------------------------------
// Users & auth tokens
// ---------------------------------------------------------------------------

function createUser({ id, username, passwordHash, role }) {
  db.prepare(
    'INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, username, passwordHash, role, nowIso());
}

function getUserByUsername(username) {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  return row ? rowToUser(row) : null;
}

function getUserById(id) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return row ? rowToUser(row) : null;
}

function rowToUser(row) {
  return { id: row.id, username: row.username, passwordHash: row.password_hash, role: row.role, createdAt: row.created_at };
}

/** Public-facing user object (no password hash). */
function publicUser(user) {
  return user ? { id: user.id, username: user.username, role: user.role, createdAt: user.createdAt } : null;
}

function createAuthToken({ token, userId }) {
  db.prepare('INSERT INTO auth_tokens (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, nowIso());
}

function getUserIdByToken(token) {
  const row = db.prepare('SELECT user_id FROM auth_tokens WHERE token = ?').get(token);
  return row ? row.user_id : null;
}

function deleteAuthToken(token) {
  db.prepare('DELETE FROM auth_tokens WHERE token = ?').run(token);
}

function listStudents() {
  const rows = db.prepare(
    `SELECT u.id, u.username, u.created_at,
       (SELECT COUNT(*) FROM sessions s WHERE s.owner_id = u.id) AS session_count
     FROM users u WHERE u.role = 'student' ORDER BY u.username ASC`
  ).all();
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    createdAt: r.created_at,
    sessionCount: r.session_count,
  }));
}

function safeJson(str, fallback = null) {
  if (str == null) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

module.exports = {
  createSession, getSession, updateSession, addTurn, getTurns,
  listSessions, getCompletedSessions, nowIso,
  createUser, getUserByUsername, getUserById, publicUser,
  createAuthToken, getUserIdByToken, deleteAuthToken, listStudents,
};
