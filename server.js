// Quiz-Party – selbst gehostetes Quiz
// Party: Teams spielen am Handy, die Spielleitung steuert am Beamer (lib/party.js).
// Die Fragen liegen als Pool in data/quizzes/<thema>/<short|mid|long>.json (lib/quizzes.js).

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { PORT, PUBLIC_DIR, PUBLIC_URL } = require('./lib/config');
const { send } = require('./lib/http');
const quizzes = require('./lib/quizzes');

// npm run check: Pool prüfen, ohne den Server zu starten
if (process.argv.includes('--check')) process.exit(quizzes.checkPool());

const party = require('./lib/party');
const db = require('./lib/db');

const PAGES = {
  '/': 'index.html',
  '/party': 'party.html',
  '/host': 'host.html',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try {
    // ---- Seiten; /r/<code> ist der Link im Party-QR-Code
    if (req.method === 'GET' && (PAGES[p] || /^\/r\/[A-Za-z0-9]{4,10}\/?$/.test(p))) {
      return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, PAGES[p] || 'party.html')), 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && p === '/healthz') return send(res, 200, { ok: true });

    await party.handle(req, res, url);
    if (!res.writableEnded) send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 400, { error: e.message || 'Fehler' });
  }
});

server.listen(PORT, () => {
  console.log(`Quiz läuft auf Port ${PORT} – Party: ${party.summary()}.`);
  console.log(`Spielleitung: ${PUBLIC_URL || 'http://localhost:' + PORT}/host`);
});

// docker stop schickt SIGTERM: Spielstand sichern, dann beenden
function shutdown() {
  party.saveNow();
  db.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
