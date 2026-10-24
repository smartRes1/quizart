// Quiz-Party – selbst gehostetes Party-Quiz
// Teams spielen am Handy, die Spielleitung steuert am Beamer.
// Keine Datenbank, keine externen Dienste: Spielstand liegt in data/state.json,
// die Fragen liegen als Pool in data/quizzes/<thema>/<short|mid|long>.json.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const QUIZ_DIR = process.env.QUIZ_DIR || path.join(DATA_DIR, 'quizzes');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const MAX_TEAMS = parseInt(process.env.MAX_TEAMS || '60', 10);
const LETTERS = ['A', 'B', 'C', 'D'];

let HOST_PIN = process.env.HOST_PIN;
if (!HOST_PIN && !process.argv.includes('--check')) {
  HOST_PIN = String(crypto.randomInt(1000, 10000));
  console.log(`\n  Kein HOST_PIN gesetzt – PIN für die Spielleitung: ${HOST_PIN}\n`);
}

// ---------------------------------------------------------------- Fragen

const DURATIONS = { short: 'Kurz', mid: 'Mittel', long: 'Lang' };
// Erlaubte Spieldauer in Minuten je Länge
const DURATION_FITS = { short: (m) => m >= 2 && m <= 6, mid: (m) => m >= 7 && m <= 15, long: (m) => m > 15 };
// Schätzung pro Frage: Fragezeit + Auflösung/Funfact, pro Runde: Intro + Zwischenergebnis
const REVEAL_SECONDS = 20;
const ROUND_SECONDS = 45;

function loadQuestions(file) {
  const raw = fs.readFileSync(file, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${path.relative(QUIZ_DIR, file)} ist kein gültiges JSON: ${e.message}`);
  }
  const errors = [];
  if (!Array.isArray(data.rounds) || data.rounds.length === 0) errors.push('Es gibt keine "rounds".');
  (data.rounds || []).forEach((r, ri) => {
    const where = `Runde ${ri + 1}`;
    if (!r.name) errors.push(`${where}: "name" fehlt.`);
    if (!Array.isArray(r.questions) || r.questions.length === 0) errors.push(`${where}: keine Fragen.`);
    (r.questions || []).forEach((q, qi) => {
      const w = `${where}, Frage ${qi + 1}`;
      if (!q.q) errors.push(`${w}: Fragetext "q" fehlt.`);
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) {
        errors.push(`${w}: "options" braucht 2 bis 4 Antworten.`);
      } else {
        const idx = LETTERS.indexOf(String(q.correct || '').trim().toUpperCase());
        if (idx < 0 || idx >= q.options.length) errors.push(`${w}: "correct" muss einer der Buchstaben ${LETTERS.slice(0, q.options.length).join('/')} sein.`);
      }
    });
  });
  if (errors.length) throw new Error(errors.join('\n'));
  const settings = Object.assign({ secondsPerQuestion: 25, pointsPerCorrect: 1 }, data.settings || {});
  return {
    title: data.title || 'Quiz',
    settings,
    rounds: data.rounds.map((r) => ({
      name: r.name,
      subtitle: r.subtitle || '',
      questions: r.questions.map((q) => ({
        q: q.q,
        options: q.options.map(String),
        correct: LETTERS.indexOf(String(q.correct).trim().toUpperCase()),
        fact: q.fact || '',
        points: Number.isFinite(q.points) ? q.points : settings.pointsPerCorrect,
        seconds: Number.isFinite(q.seconds) ? q.seconds : settings.secondsPerQuestion,
      })),
    })),
  };
}

const questionCount = (qz) => qz.rounds.reduce((s, r) => s + r.questions.length, 0);

function estimateMinutes(qz) {
  const secs = qz.rounds.reduce((s, r) => s + ROUND_SECONDS + r.questions.reduce((t, q) => t + q.seconds + REVEAL_SECONDS, 0), 0);
  return Math.round(secs / 60);
}

// Alle Quizze im Pool, auch fehlerhafte (mit `error`), damit das Menü zeigt, was nicht passt
function listQuizzes() {
  let topics = [];
  try {
    topics = fs.readdirSync(QUIZ_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^[\w-]+$/.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch {}
  const list = [];
  for (const topic of topics) {
    for (const duration of Object.keys(DURATIONS)) {
      const file = path.join(QUIZ_DIR, topic, `${duration}.json`);
      if (!fs.existsSync(file)) continue;
      const item = { id: `${topic}/${duration}`, topic, duration, durationLabel: DURATIONS[duration] };
      try {
        const qz = loadQuestions(file);
        Object.assign(item, { title: qz.title, rounds: qz.rounds.length, questions: questionCount(qz), minutes: estimateMinutes(qz) });
      } catch (e) {
        item.error = e.message;
      }
      list.push(item);
    }
  }
  return list;
}

function loadQuiz(id) {
  const m = /^([\w-]+)\/(short|mid|long)$/.exec(String(id || ''));
  const file = m && path.join(QUIZ_DIR, m[1], `${m[2]}.json`);
  if (!file || !fs.existsSync(file)) throw new Error(`Quiz „${id}“ gibt es nicht.`);
  return { ...loadQuestions(file), id };
}

// npm run check: Pool prüfen, ohne den Server zu starten
if (process.argv.includes('--check')) {
  const list = listQuizzes();
  if (!list.length) console.log(`Keine Quizze in ${QUIZ_DIR} gefunden.`);
  for (const q of list) {
    if (q.error) { console.log(`✗ ${q.id}\n  ${q.error.replace(/\n/g, '\n  ')}`); continue; }
    const fit = DURATION_FITS[q.duration](q.minutes) ? '' : `  ⚠ passt nicht zu „${q.durationLabel}“`;
    console.log(`✓ ${q.id}: ${q.rounds} Runde(n), ${q.questions} Fragen, ca. ${q.minutes} Min${fit}`);
  }
  process.exit(list.length && list.every((q) => !q.error) ? 0 : 1);
}

function defaultQuizId() {
  const first = listQuizzes().find((q) => !q.error);
  if (!first) throw new Error(`Kein gültiges Quiz in ${QUIZ_DIR} gefunden (erwartet: <thema>/short.json, mid.json oder long.json).`);
  return first.id;
}

let quiz = null;

// ---------------------------------------------------------------- Spielstand

function newCode() {
  // gut lesbar, keine verwechselbaren Zeichen
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[crypto.randomInt(alphabet.length)];
  return s;
}

function freshState(keepTeams) {
  const teams = keepTeams && state ? state.teams.map((t) => ({ ...t, rounds: [] })) : [];
  return {
    quiz: quiz.id, // "<thema>/<short|mid|long>"
    phase: 'intro', // intro | question | reveal | standings | final
    round: 0,
    question: -1,
    deadline: 0,
    startedAt: 0,
    codes: ((c) => quiz.rounds.map(() => c))(newCode()), // ein QR-Code für das ganze Spiel
    teams, // {id, token, name, rounds:[roundIdx], joinedAt}
    answers: {}, // "r:q" -> { teamId: {choice, ms} }
    seen: {}, // "r:q" -> { teamId: Zeitpunkt, an dem das Handy die Frage zuerst abgeholt hat }
    revealed: [], // ["r:q", ...]
  };
}

let state = null;
try {
  state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  quiz = loadQuiz(state.quiz);
  if (!Array.isArray(state.codes) || state.codes.length !== quiz.rounds.length) throw new Error('Rundenzahl geändert');
  state.seen = state.seen || {};
  console.log(`Spielstand wiederhergestellt (${quiz.id}).`);
} catch {
  quiz = loadQuiz(defaultQuizId());
  state = freshState(false);
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(state), (err) => {
      if (!err) fs.rename(tmp, STATE_FILE, () => {});
    });
  }, 150);
}

const key = (r, q) => `${r}:${q}`;
const currentQ = () => (state.question >= 0 ? quiz.rounds[state.round].questions[state.question] : null);
const teamsInRound = (r) => state.teams.filter((t) => t.rounds.includes(r));
// Quiz wechseln oder neu laden geht nur, solange noch keine Frage gespielt wurde
const notStarted = () => state.round === 0 && state.phase === 'intro' && state.revealed.length === 0;

// Punkte aus allen aufgelösten Fragen (optional nur bis vor Runde `beforeRound`)
function ranking(beforeRound = Infinity) {
  const rows = state.teams.map((t) => ({ id: t.id, name: t.name, score: 0, roundScore: 0, ms: 0, correct: 0 }));
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  for (const k of state.revealed) {
    const [r, q] = k.split(':').map(Number);
    if (r >= beforeRound) continue;
    const qq = quiz.rounds[r] && quiz.rounds[r].questions[q];
    if (!qq) continue;
    for (const [teamId, a] of Object.entries(state.answers[k] || {})) {
      const row = byId[teamId];
      if (!row || a.choice !== qq.correct) continue;
      row.score += qq.points;
      row.correct += 1;
      row.ms += a.ms;
      if (r === state.round) row.roundScore += qq.points;
    }
  }
  rows.sort((a, b) => b.score - a.score || a.ms - b.ms || a.name.localeCompare(b.name, 'de'));
  let rank = 0;
  rows.forEach((row, i) => {
    if (i === 0 || row.score !== rows[i - 1].score || row.ms !== rows[i - 1].ms) rank = i + 1;
    row.rank = rank;
  });
  return rows;
}

function rankingWithMovement() {
  const now = ranking();
  if (state.round === 0) return now.map((r) => ({ ...r, move: 0 }));
  const before = Object.fromEntries(ranking(state.round).map((r) => [r.id, r.rank]));
  return now.map((r) => ({ ...r, move: before[r.id] ? before[r.id] - r.rank : 0 }));
}

function distribution(r, q) {
  const qq = quiz.rounds[r].questions[q];
  const counts = qq.options.map(() => 0);
  for (const a of Object.values(state.answers[key(r, q)] || {})) if (counts[a.choice] !== undefined) counts[a.choice]++;
  return counts;
}

// ---------------------------------------------------------------- Ablauf

function startQuestion(q) {
  state.phase = 'question';
  state.question = q;
  state.startedAt = Date.now();
  state.deadline = state.startedAt + currentQ().seconds * 1000;
  save();
}

function reveal() {
  if (state.phase !== 'question') return;
  state.phase = 'reveal';
  const k = key(state.round, state.question);
  if (!state.revealed.includes(k)) state.revealed.push(k);
  save();
}

function next() {
  const round = quiz.rounds[state.round];
  switch (state.phase) {
    case 'intro':
      startQuestion(0);
      break;
    case 'question':
      reveal();
      break;
    case 'reveal':
      if (state.question + 1 < round.questions.length) startQuestion(state.question + 1);
      else if (state.round + 1 < quiz.rounds.length) { state.phase = 'standings'; save(); }
      else { state.phase = 'final'; save(); }
      break;
    case 'standings':
      state.round += 1;
      state.question = -1;
      state.phase = 'intro';
      // Alle Teams spielen automatisch in der nächsten Runde weiter, kein erneutes Scannen
      state.teams.forEach((t) => { if (!t.rounds.includes(state.round)) t.rounds.push(state.round); });
      save();
      break;
    default:
      break;
  }
}

// Zeit abgelaufen oder alle Teams der Runde haben geantwortet → automatisch auflösen
setInterval(() => {
  if (state.phase !== 'question') return;
  const players = teamsInRound(state.round);
  const answered = Object.keys(state.answers[key(state.round, state.question)] || {});
  const allIn = players.length > 0 && players.every((t) => answered.includes(t.id));
  if (Date.now() >= state.deadline + 300 || allIn) reveal();
}, 250);

// ---------------------------------------------------------------- Antworten an Clients

function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function questionPayload(withSolution) {
  const qq = currentQ();
  if (!qq) return null;
  const p = {
    number: state.question + 1,
    total: quiz.rounds[state.round].questions.length,
    text: qq.q,
    options: qq.options,
    durationMs: qq.seconds * 1000,
    remainingMs: Math.max(0, state.deadline - Date.now()),
    points: qq.points,
  };
  if (withSolution) {
    p.correct = qq.correct;
    p.fact = qq.fact;
    p.distribution = distribution(state.round, state.question);
  }
  return p;
}

function commonPayload() {
  const round = quiz.rounds[state.round];
  return {
    title: quiz.title,
    phase: state.phase,
    roundIndex: state.round,
    roundCount: quiz.rounds.length,
    roundName: round.name,
    roundSubtitle: round.subtitle,
    roundQuestions: round.questions.length,
    nextRoundName: quiz.rounds[state.round + 1] ? quiz.rounds[state.round + 1].name : null,
  };
}

function teamView(team) {
  // Zeitmessung fair pro Team: ab dem Moment, in dem dieses Handy die Frage zuerst abgeholt hat (Serverzeit)
  if (team && state.phase === 'question' && team.rounds.includes(state.round)) {
    const k = key(state.round, state.question);
    state.seen[k] = state.seen[k] || {};
    if (!state.seen[k][team.id]) state.seen[k][team.id] = Date.now();
  }
  const p = commonPayload();
  p.team = team ? { name: team.name, inRound: team.rounds.includes(state.round) } : null;
  const showSolution = state.phase === 'reveal';
  if (state.phase === 'question' || state.phase === 'reveal') {
    p.question = questionPayload(showSolution);
    // Teams sehen die Verteilung nicht, nur ob sie richtig lagen
    if (p.question) delete p.question.distribution;
    const a = team && (state.answers[key(state.round, state.question)] || {})[team.id];
    p.myAnswer = a ? a.choice : null;
  }
  if (team) {
    const rows = ranking();
    const me = rows.find((r) => r.id === team.id);
    p.me = me ? { score: me.score, rank: me.rank, roundScore: me.roundScore, teams: rows.length } : null;
  }
  if (state.phase === 'standings' || state.phase === 'final') {
    p.ranking = rankingWithMovement().map(({ id, ...r }) => ({ ...r, isMe: team ? id === team.id : false }));
  }
  return p;
}

function hostView(req) {
  const p = commonPayload();
  const code = state.codes[state.round];
  p.code = code;
  p.joinUrl = `${baseUrl(req)}/r/${code}`;
  p.joinHost = p.joinUrl.replace(/^https?:\/\//, '').replace(/\/r\/.*$/, '');
  p.teams = state.teams.map((t) => ({ id: t.id, name: t.name, inRound: t.rounds.includes(state.round) }));
  p.playersInRound = teamsInRound(state.round).length;
  if (state.phase === 'question' || state.phase === 'reveal') {
    p.question = questionPayload(state.phase === 'reveal');
    const answered = state.answers[key(state.round, state.question)] || {};
    p.answeredCount = Object.keys(answered).length;
    p.answeredIds = Object.keys(answered);
  }
  if (state.phase === 'standings' || state.phase === 'final') {
    p.ranking = rankingWithMovement();
    // Höchstmögliche Punkte bis einschließlich der aktuellen Runde (für „x von y“)
    p.maxPoints = quiz.rounds.slice(0, state.round + 1).reduce((s, r) => s + r.questions.reduce((t, q) => t + q.points, 0), 0);
  }
  p.canReload = notStarted();
  p.quizId = quiz.id;
  return p;
}

// ---------------------------------------------------------------- HTTP

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 16 * 1024) { reject(new Error('zu groß')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('ungültiges JSON')); }
    });
    req.on('error', reject);
  });
}

function cleanName(name) {
  return String(name || '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
}

function pinOk(req) {
  const given = Buffer.from(String(req.headers['x-host-pin'] || ''));
  const want = Buffer.from(HOST_PIN);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

const findTeam = (token) => (token ? state.teams.find((t) => t.token === token) : null);

function codeRound(code) {
  // Ein Rundencode ist nur gültig, solange diese Runde läuft
  const c = String(code || '').toUpperCase();
  return state.codes[state.round] === c && state.phase !== 'final' && state.phase !== 'standings' ? state.round : -1;
}

const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/host': ['host.html', 'text/html; charset=utf-8'],
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try {
    // ---- Seiten
    if (req.method === 'GET' && (staticFiles[p] || /^\/r\/[A-Za-z0-9]{4,10}\/?$/.test(p))) {
      const [file, type] = staticFiles[p] || staticFiles['/'];
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', file)), type);
    }

    if (req.method === 'GET' && p === '/healthz') return send(res, 200, { ok: true });

    // ---- QR-Code der aktuellen Runde (nur für die Spielleitung)
    if (req.method === 'GET' && p === '/api/host/qr.svg') {
      if (url.searchParams.get('pin') !== HOST_PIN) return send(res, 403, 'forbidden', 'text/plain');
      const target = `${baseUrl(req)}/r/${state.codes[state.round]}`;
      const svg = await QRCode.toString(target, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#111111', light: '#ffffff' } });
      return send(res, 200, svg, 'image/svg+xml');
    }

    // ---- Team-API
    if (p === '/api/state' && req.method === 'GET') {
      return send(res, 200, teamView(findTeam(url.searchParams.get('token'))));
    }

    if (p === '/api/join' && req.method === 'POST') {
      const body = await readBody(req);
      const r = codeRound(body.code);
      if (r < 0) return send(res, 409, { error: 'Dieser QR-Code ist nicht (mehr) gültig. Scannt den Code, der gerade am Bildschirm zu sehen ist.' });
      const name = cleanName(body.name);
      if (name.length < 2) return send(res, 400, { error: 'Bitte einen Teamnamen mit mindestens 2 Zeichen eingeben.' });
      if (state.teams.some((t) => t.name.toLowerCase() === name.toLowerCase())) return send(res, 409, { error: 'Diesen Teamnamen gibt es schon. Wählt einen anderen.' });
      if (state.teams.length >= MAX_TEAMS) return send(res, 409, { error: 'Es sind schon zu viele Teams angemeldet.' });
      const team = { id: crypto.randomBytes(6).toString('hex'), token: crypto.randomBytes(18).toString('base64url'), name, rounds: [r], joinedAt: Date.now() };
      state.teams.push(team);
      save();
      return send(res, 200, { token: team.token });
    }

    if (p === '/api/enter' && req.method === 'POST') {
      const body = await readBody(req);
      const team = findTeam(body.token);
      if (!team) return send(res, 404, { error: 'unknown team' });
      const r = codeRound(body.code);
      if (r < 0) return send(res, 409, { error: 'Dieser QR-Code ist nicht (mehr) gültig. Scannt den Code, der gerade am Bildschirm zu sehen ist.' });
      if (!team.rounds.includes(r)) { team.rounds.push(r); save(); }
      return send(res, 200, { ok: true });
    }

    if (p === '/api/answer' && req.method === 'POST') {
      const body = await readBody(req);
      const team = findTeam(body.token);
      if (!team) return send(res, 404, { error: 'unknown team' });
      if (state.phase !== 'question' || body.round !== state.round || body.question !== state.question) return send(res, 409, { error: 'Diese Frage ist schon vorbei.' });
      if (!team.rounds.includes(state.round)) return send(res, 403, { error: 'Scannt zuerst den QR-Code dieser Runde.' });
      if (Date.now() > state.deadline + 500) return send(res, 409, { error: 'Zeit abgelaufen.' });
      const choice = Number(body.choice);
      if (!Number.isInteger(choice) || choice < 0 || choice >= currentQ().options.length) return send(res, 400, { error: 'ungültige Antwort' });
      const k = key(state.round, state.question);
      state.answers[k] = state.answers[k] || {};
      if (state.answers[k][team.id]) return send(res, 409, { error: 'Ihr habt schon geantwortet.' });
      const from = (state.seen[k] && state.seen[k][team.id]) || state.startedAt;
      state.answers[k][team.id] = { choice, ms: Math.max(0, Date.now() - from) };
      save();
      return send(res, 200, { ok: true });
    }

    // ---- Spielleitung
    if (p.startsWith('/api/host/')) {
      if (!pinOk(req)) return send(res, 403, { error: 'Falscher PIN' });
      const action = p.slice('/api/host/'.length);
      if (action === 'state' && req.method === 'GET') return send(res, 200, hostView(req));
      if (action === 'quizzes' && req.method === 'GET') return send(res, 200, listQuizzes());
      if (req.method !== 'POST') return send(res, 405, { error: 'method' });
      const body = await readBody(req);
      if (action === 'next') { next(); return send(res, 200, hostView(req)); }
      if (action === 'kick') {
        state.teams = state.teams.filter((t) => t.id !== body.id);
        save();
        return send(res, 200, hostView(req));
      }
      if (action === 'reset') {
        try { quiz = loadQuiz(body.quiz || quiz.id); } catch (e) { return send(res, 400, { error: e.message }); }
        state = freshState(!!body.keepTeams);
        save();
        return send(res, 200, hostView(req));
      }
      if (action === 'reload' || action === 'select') {
        // select: anderes Quiz aus dem Pool, Teams und QR-Code bleiben
        if (!notStarted()) return send(res, 409, { error: 'Das Quiz kann nur vor dem Spielstart gewechselt oder neu geladen werden. Sonst „Neues Spiel“ wählen.' });
        try { quiz = loadQuiz(action === 'select' ? body.id : quiz.id); } catch (e) { return send(res, 400, { error: e.message }); }
        state.quiz = quiz.id;
        state.codes = quiz.rounds.map(() => state.codes[0] || newCode());
        save();
        return send(res, 200, { ok: true, message: `${quiz.title}: ${quiz.rounds.length} Runde(n) mit ${questionCount(quiz)} Fragen geladen.`, state: hostView(req) });
      }
      return send(res, 404, { error: 'unknown action' });
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 400, { error: e.message || 'Fehler' });
  }
});

server.listen(PORT, () => {
  console.log(`Quiz läuft auf Port ${PORT} – ${quiz.id}: ${quiz.rounds.length} Runden, ${questionCount(quiz)} Fragen.`);
  console.log(`Spielleitung: ${PUBLIC_URL || 'http://localhost:' + PORT}/host`);
});
