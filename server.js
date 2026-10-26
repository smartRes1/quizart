// Quiz-Party – selbst gehostetes Quiz
// Party: Teams spielen am Handy, die Spielleitung steuert am Beamer (lib/party.js).
// Die Fragen liegen als Pool in data/quizzes/<thema>/<short|mid|long>.json (lib/quizzes.js).

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');
const { PORT, PUBLIC_DIR, PUBLIC_URL, SMTP_URL } = require('./lib/config');
const { send } = require('./lib/http');
const quizzes = require('./lib/quizzes');

// npm run check: Pool prüfen, ohne den Server zu starten
if (process.argv.includes('--check')) process.exit(quizzes.checkPool());

const party = require('./lib/party');
const runs = require('./lib/runs');
const board = require('./lib/board');
const auth = require('./lib/auth');
const battle = require('./lib/battle');
const db = require('./lib/db');
const hostpin = require('./lib/hostpin');

const PAGES = {
  '/': 'index.html',
  '/party': 'party.html',
  '/host': 'host.html',
  '/solo': 'play.html',
  '/battle': 'battle.html',
  '/login': 'login.html',
  '/konto': 'konto.html',
  '/bestenliste': 'board.html',
  '/datenschutz': 'datenschutz.html',
  '/impressum': 'impressum.html',
};
// Gemeinsame Bausteine der neuen Seiten (Party-Seiten bleiben eigenständig)
const ASSETS = {
  '/common.css': 'text/css; charset=utf-8',
  '/common.js': 'text/javascript; charset=utf-8',
};

function page(p) {
  if (PAGES[p]) return PAGES[p];
  if (/^\/r\/[A-Za-z0-9]{4,10}\/?$/.test(p)) return 'party.html'; // Link im Party-QR-Code
  if (/^\/(solo|spiel)\/[\w-]{10,40}$/.test(p)) return 'play.html';
  if (/^\/battle\/\d+$/.test(p) || /^\/b\/[A-Za-z0-9]{6,12}$/.test(p)) return 'battle.html';
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try {
    if (req.method === 'GET' && page(p)) {
      return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, page(p))), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && ASSETS[p]) return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, p.slice(1))), ASSETS[p]);

    if (req.method === 'GET' && p === '/healthz') return send(res, 200, { ok: true });

    for (const mod of [party, runs, board, auth, battle]) {
      if (!res.writableEnded) await mod.handle(req, res, url);
    }
    if (!res.writableEnded) send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 400, { error: e.message || 'Fehler' });
  }
});

// Adresse im WLAN, damit Handys den QR-Code aus dem Terminal öffnen können
function lanUrl() {
  if (PUBLIC_URL) return PUBLIC_URL;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return `http://${a.address}:${PORT}`;
  }
  return `http://localhost:${PORT}`;
}

server.listen(PORT, async () => {
  const base = lanUrl();
  console.log(`Quiz läuft auf ${base} – Party: ${party.summary()}.`);
  const logins = ['Name', auth.PROVIDERS.email && 'E-Mail' + (SMTP_URL ? '' : ' (Links nur in dieser Konsole)'), auth.PROVIDERS.google && 'Google', auth.PROVIDERS.facebook && 'Facebook'];
  console.log(`Anmeldung: ${logins.filter(Boolean).join(', ')}`);
  // QR-Code zur Startseite, damit Handys im WLAN direkt hinkommen
  const qr = await QRCode.toString(`${base}/`, { type: 'terminal', small: true, errorCorrectionLevel: 'L' }).catch(() => '');
  console.log(`\nStartseite zum Scannen:\n${qr}${base}/\n`);
  console.log(`Moderator-PIN (nicht weitergeben): ${hostpin.PIN}  – Startseite → „Moderator werden“ oder direkt ${base}/host\n`);
});

// docker stop schickt SIGTERM: Spielstand sichern, dann beenden
function shutdown() {
  party.saveNow();
  db.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
