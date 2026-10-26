'use strict';

// Party-Modus: Spielleitung am Beamer (/host), Teams am Handy (/party, /r/<code>).
// Genau ein Spiel pro Server, Spielstand in data/state.json.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { DATA_DIR, MAX_TEAMS } = require('./config');
const { send, readBody, cleanName, baseUrl } = require('./http');
const { listQuizzes, loadQuiz, defaultQuizId, questionCount } = require('./quizzes');
const { rankRows, distribution } = require('./scoring');
const hostpin = require('./hostpin');
const { currentUser } = require('./session');

const STATE_FILE = path.join(DATA_DIR, 'state.json');


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

// Beim Beenden sofort schreiben, damit ein noch ausstehendes save() nicht verloren geht
function saveNow() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
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
  return rankRows(rows);
}

function rankingWithMovement() {
  const now = ranking();
  if (state.round === 0) return now.map((r) => ({ ...r, move: 0 }));
  const before = Object.fromEntries(ranking(state.round).map((r) => [r.id, r.rank]));
  return now.map((r) => ({ ...r, move: before[r.id] ? before[r.id] - r.rank : 0 }));
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
}, 250).unref();

// ---------------------------------------------------------------- Antworten an Clients

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
    p.distribution = distribution(qq, state.answers[key(state.round, state.question)]);
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

// Moderation: angemeldet mit Moderator-Rechten oder PIN im Header (bzw. ?pin= beim QR-Bild)
function hostOk(req, pin) {
  const user = currentUser(req);
  if (user && user.is_host) return true;
  return pin ? hostpin.check(req, pin) : false;
}

const findTeam = (token) => (token ? state.teams.find((t) => t.token === token) : null);

function codeRound(code) {
  // Ein Rundencode ist nur gültig, solange diese Runde läuft
  const c = String(code || '').toUpperCase();
  return state.codes[state.round] === c && state.phase !== 'final' && state.phase !== 'standings' ? state.round : -1;
}

// Party-API; lässt die Anfrage unbeantwortet, wenn sie nicht zur Party gehört
async function handle(req, res, url) {
  const p = url.pathname;

  // ---- QR-Code der aktuellen Runde (nur für die Spielleitung)
  if (req.method === 'GET' && p === '/api/host/qr.svg') {
    if (hostOk(req, url.searchParams.get('pin')) !== true) return send(res, 403, 'forbidden', 'text/plain');
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
    const ok = hostOk(req, req.headers['x-host-pin']);
    if (ok === 'locked') return send(res, 429, { error: 'Zu viele falsche PINs. Bitte in 15 Minuten noch einmal.' });
    if (!ok) return send(res, 403, { error: 'Falscher PIN' });
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
}

const summary = () => `${quiz.id}: ${quiz.rounds.length} Runden, ${questionCount(quiz)} Fragen`;

module.exports = { handle, saveNow, summary };
