'use strict';
/**
 * Auth layer — dependency-free username/password accounts.
 *
 * - Passwords are hashed with Node's built-in crypto.scryptSync (salt:hash).
 * - Logins mint a random bearer token stored in auth_tokens and delivered as
 *   an HttpOnly SameSite=Lax cookie (no extra packages, works on Vercel).
 * - `requireAuth` / `requireRole` middleware protect API routes.
 */

const crypto = require('crypto');
const db = require('./db');

const COOKIE_NAME = 'iq_token';
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = String(stored).split(':');
    const test = crypto.scryptSync(String(password), salt, 64).toString('hex');
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(test, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tokens & cookies
// ---------------------------------------------------------------------------

const newToken = () => crypto.randomBytes(32).toString('hex');

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setTokenCookie(res, token) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${TOKEN_TTL_MS / 1000}; SameSite=Lax`);
}

function clearTokenCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

/** Resolve the logged-in user (or null) from the request cookie. */
function currentUser(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const userId = db.getUserIdByToken(token);
  return userId ? db.getUserById(userId) : null;
}

/** Mint + persist a token for a user and set the cookie. */
function loginUser(res, userId) {
  const token = newToken();
  db.createAuthToken({ token, userId });
  setTokenCookie(res, token);
  return token;
}

function logoutUser(req, res) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (token) db.deleteAuthToken(token);
  clearTokenCookie(res);
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/** Requires a logged-in user; attaches `req.user`. Optional role allow-list. */
function requireAuth(roles) {
  return (req, res, next) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'Please log in to continue.' });
    if (roles && !roles.includes(user.role)) {
      return res.status(403).json({ error: 'This action is not available for your account type.' });
    }
    req.user = user;
    next();
  };
}

const PUBLIC_USER_FIELDS = (u) => (u ? { id: u.id, username: u.username, role: u.role, createdAt: u.createdAt } : null);

module.exports = {
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  newToken,
  parseCookies,
  setTokenCookie,
  clearTokenCookie,
  currentUser,
  loginUser,
  logoutUser,
  requireAuth,
  PUBLIC_USER_FIELDS,
};
