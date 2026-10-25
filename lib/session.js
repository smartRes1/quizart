'use strict';

// Wer spielt gerade? Angemeldete über das Cookie „sid“ (Sitzung in der Datenbank,
// gespeichert nur als SHA-256), Gäste über ein zufälliges Cookie „gid“.

const crypto = require('crypto');
const db = require('./db');
const { cookies, setCookie } = require('./http');

const SESSION_DAYS = 30;
const GUEST_MAX_AGE = 365 * 24 * 3600;

const newToken = (bytes = 16) => crypto.randomBytes(bytes).toString('base64url');
const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

function guestId(req, res, create) {
  let gid = cookies(req).gid;
  if (gid && /^[\w-]{16,64}$/.test(gid)) return gid;
  if (!create) return null;
  gid = newToken();
  setCookie(req, res, 'gid', gid, GUEST_MAX_AGE);
  return gid;
}

// Pro Anfrage zwischengespeichert, damit mehrere Module nicht mehrfach nachschlagen
function currentUser(req, now = Date.now()) {
  if (req.user !== undefined) return req.user;
  const sid = cookies(req).sid;
  req.user = (sid && db.get().prepare(`SELECT u.id, u.name, u.email, u.name_chosen FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(hash(sid), now)) || null;
  return req.user;
}

function startSession(req, res, userId, now = Date.now()) {
  const token = newToken(32);
  const d = db.get();
  d.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  d.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hash(token), userId, now + SESSION_DAYS * 86400 * 1000);
  setCookie(req, res, 'sid', token, SESSION_DAYS * 86400);
  req.user = undefined;
}

function endSession(req, res) {
  const sid = cookies(req).sid;
  if (sid) db.get().prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(sid));
  setCookie(req, res, 'sid', '', 0);
  req.user = null;
}

module.exports = { guestId, currentUser, startSession, endSession, newToken, hash };
