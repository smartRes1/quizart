'use strict';

// PIN der Moderation: HOST_PIN, sonst eine zufällige 6-stellige PIN in data/host-pin
// (bleibt über Neustarts gleich; neue PIN = Datei löschen). Wer die PIN kennt, moderiert:
// direkt am Beamer (/host) oder dauerhaft für sein Konto (Startseite → „Moderator werden“).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./config');

const PIN_FILE = path.join(DATA_DIR, 'host-pin');

function load() {
  if (process.env.HOST_PIN) return process.env.HOST_PIN;
  try {
    const pin = fs.readFileSync(PIN_FILE, 'utf8').trim();
    if (pin) return pin;
  } catch {}
  const pin = String(crypto.randomInt(100000, 1000000));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PIN_FILE, pin + '\n', { mode: 0o600 });
  return pin;
}
const PIN = load();

// Falsche Versuche je IP begrenzen, sonst ließe sich eine kurze PIN durchprobieren
const MAX_FAILS = 10;
const WINDOW_MS = 15 * 60 * 1000;
const fails = new Map();
setInterval(() => { const now = Date.now(); for (const [k, f] of fails) if (f.until < now) fails.delete(k); }, WINDOW_MS).unref();

const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

// true/false; 'locked', wenn diese IP zu oft falsch lag
function check(req, given, now = Date.now()) {
  const ip = clientIp(req);
  const f = fails.get(ip);
  if (f && f.until > now && f.n >= MAX_FAILS) return 'locked';
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(PIN);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  if (!f || f.until < now) fails.set(ip, { n: 1, until: now + WINDOW_MS });
  else f.n++;
  return false;
}

module.exports = { PIN, check };
