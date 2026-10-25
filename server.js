// Quiz-Party – selbst gehostetes Quiz
// Party: Teams spielen am Handy, die Spielleitung steuert am Beamer (lib/party.js).
// Die Fragen liegen als Pool in data/quizzes/<thema>/<short|mid|long>.json (lib/quizzes.js).

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { PORT, PUBLIC_DIR, PUBLIC_URL, SMTP_URL } = require('./lib/config');
const { send } = require('./lib/http');
const quizzes = require('./lib/quizzes');

// npm run check: Pool prüfen, ohne den Server zu starten
if (process.argv.includes('--check')) process.exit(quizzes.checkPool());

const party = require('./lib/party');
const runs = require('./lib/runs');
const board = require('./lib/board');
const auth = require('./lib/auth');
const db = require('./lib/db');

const PAGES = {
  '/': 'index.html',
  '/party': 'party.html',
  '/host': 'host.html',
  '/solo': 'play.html',
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
  if (/^\/solo\/[\w-]{10,40}$/.test(p)) return 'play.html';
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

    for (const mod of [party, runs, board, auth]) {
      if (!res.writableEnded) await mod.handle(req, res, url);
    }
    if (!res.writableEnded) send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 400, { error: e.message || 'Fehler' });
  }
});

server.listen(PORT, () => {
  console.log(`Quiz läuft auf Port ${PORT} – Party: ${party.summary()}.`);
  console.log(`Spielleitung: ${PUBLIC_URL || 'http://localhost:' + PORT}/host`);
  const logins = ['E-Mail' + (SMTP_URL ? '' : ' (ohne SMTP_URL: Links nur in dieser Konsole)'), auth.PROVIDERS.google && 'Google', auth.PROVIDERS.facebook && 'Facebook'];
  console.log(`Anmeldung: ${logins.filter(Boolean).join(', ')}`);
});

// docker stop schickt SIGTERM: Spielstand sichern, dann beenden
function shutdown() {
  party.saveNow();
  db.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
