'use strict';

// Durchgang eines einzelnen Spielers (Solo, später Battle), vom Server getaktet:
// Die Zeit läuft ab dem ersten Abholen einer Frage, die Lösung kommt erst nach der Antwort.
// Ablauf je Durchgang: intro (pro Runde) → question → reveal → … → final.

const crypto = require('crypto');
const db = require('./db');
const quizzes = require('./quizzes');
const { send, readBody, cookies, setCookie, sameOrigin } = require('./http');

// Spielraum für die Netzwerk-Laufzeit, bevor eine Antwort als zu spät gilt
const GRACE_MS = 500;
const GUEST_COOKIE = 'gid';
const GUEST_MAX_AGE = 365 * 24 * 3600;
// Gast-Durchgänge zählen nirgends und werden nach zwei Tagen gelöscht
const GUEST_RUN_TTL = 2 * 24 * 3600 * 1000;

const newId = () => crypto.randomBytes(16).toString('base64url');

function shuffled(n) {
  const a = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Fragen des Quiz als feste Kopie mit eigener Antwort-Reihenfolge, damit der Durchgang
// auch dann gleich bleibt, wenn die Quiz-Datei später geändert wird
function snapshot(quiz) {
  const questions = [];
  quiz.rounds.forEach((r, ri) => r.questions.forEach((q) => {
    const order = shuffled(q.options.length);
    questions.push({
      round: ri,
      text: q.q,
      options: order.map((i) => q.options[i]),
      correct: order.indexOf(q.correct),
      fact: q.fact,
      points: q.points,
      seconds: q.seconds,
    });
  }));
  return {
    title: quiz.title,
    rounds: quiz.rounds.map((r) => ({ name: r.name, subtitle: r.subtitle })),
    questions,
    i: 0,
    phase: 'intro',
    step: 0,
    servedAt: questions.map(() => null),
    answers: questions.map(() => null),
  };
}

function create({ quizId, mode = 'solo', guestId = null, userId = null, countsForBoard = false }, now = Date.now()) {
  const quiz = quizzes.loadQuiz(quizId);
  const run = { id: newId(), quiz_id: quiz.id, mode, user_id: userId, guest_id: guestId, counts_for_board: countsForBoard ? 1 : 0, state: snapshot(quiz), started_at: now };
  db.get().prepare(`INSERT INTO runs (id, quiz_id, mode, user_id, guest_id, counts_for_board, state, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(run.id, run.quiz_id, mode, userId, guestId, run.counts_for_board, JSON.stringify(run.state), now);
  return run;
}

function load(id) {
  const row = db.get().prepare('SELECT * FROM runs WHERE id = ?').get(String(id));
  if (!row) return null;
  return { ...row, state: JSON.parse(row.state) };
}

function save(run) {
  db.get().prepare('UPDATE runs SET state = ?, score = ?, ms = ?, correct = ?, finished_at = ? WHERE id = ?')
    .run(JSON.stringify(run.state), run.score || 0, run.ms || 0, run.correct || 0, run.finished_at || null, run.id);
}

const deadline = (st) => st.servedAt[st.i] + st.questions[st.i].seconds * 1000;

// Zeit abgelaufen ohne Antwort: Frage gilt als falsch beantwortet
function expire(st, now) {
  if (st.phase === 'question' && st.servedAt[st.i] && now > deadline(st) + GRACE_MS) {
    st.answers[st.i] = { choice: null, ms: null, ok: false };
    st.phase = 'reveal';
    st.step++;
    return true;
  }
  return false;
}

function totals(st) {
  let score = 0, ms = 0, correct = 0;
  st.answers.forEach((a, i) => {
    if (a && a.ok) { score += st.questions[i].points; ms += a.ms; correct++; }
  });
  return { score, ms, correct };
}

const maxPoints = (st) => st.questions.reduce((s, q) => s + q.points, 0);

// Aktueller Schritt für den Spieler; das erste Abholen einer Frage startet ihre Zeit
function view(run, now = Date.now()) {
  const st = run.state;
  let changed = expire(st, now);
  if (st.phase === 'question' && !st.servedAt[st.i]) { st.servedAt[st.i] = now; changed = true; }
  if (changed) save(run);

  const q = st.questions[st.i];
  const p = {
    id: run.id,
    quizId: run.quiz_id,
    mode: run.mode,
    title: st.title,
    phase: st.phase,
    step: st.step,
    total: st.questions.length,
    number: st.i + 1,
    roundIndex: q.round,
    roundCount: st.rounds.length,
    roundName: st.rounds[q.round].name,
    roundSubtitle: st.rounds[q.round].subtitle,
    roundQuestions: st.questions.filter((x) => x.round === q.round).length,
    score: totals(st).score,
    maxPoints: maxPoints(st),
    countsForBoard: !!run.counts_for_board,
  };
  if (st.phase === 'question' || st.phase === 'reveal') {
    p.question = { text: q.text, options: q.options, points: q.points, durationMs: q.seconds * 1000 };
    if (st.phase === 'question') p.question.remainingMs = Math.max(0, deadline(st) - now);
    else {
      const a = st.answers[st.i];
      Object.assign(p.question, { correct: q.correct, fact: q.fact });
      p.myAnswer = a.choice;
      p.ms = a.ms;
      p.last = st.i === st.questions.length - 1;
    }
  }
  if (st.phase === 'final') {
    Object.assign(p, totals(st), {
      finishedAt: run.finished_at,
      review: st.questions.map((x, i) => ({
        text: x.text,
        correct: x.options[x.correct],
        mine: st.answers[i].choice === null ? null : x.options[st.answers[i].choice],
        ok: st.answers[i].ok,
        ms: st.answers[i].ms,
      })),
    });
  }
  return p;
}

function answer(run, index, choice, now = Date.now()) {
  const st = run.state;
  expire(st, now);
  if (st.phase !== 'question' || index !== st.i || !st.servedAt[st.i]) {
    save(run);
    const e = new Error(st.phase === 'reveal' && index === st.i ? 'Die Zeit ist abgelaufen.' : 'Diese Frage ist nicht mehr offen.');
    e.status = 409;
    throw e;
  }
  const q = st.questions[st.i];
  if (!Number.isInteger(choice) || choice < 0 || choice >= q.options.length) {
    const e = new Error('Ungültige Antwort.');
    e.status = 400;
    throw e;
  }
  const ms = Math.min(now - st.servedAt[st.i], q.seconds * 1000);
  st.answers[st.i] = { choice, ms, ok: choice === q.correct };
  st.phase = 'reveal';
  st.step++;
  save(run);
}

// Weiter zum nächsten Schritt; step schützt vor doppeltem Weiterschalten (Doppelklick, zwei Tabs)
function next(run, step, now = Date.now()) {
  const st = run.state;
  expire(st, now);
  if (step !== st.step) return save(run);
  if (st.phase === 'intro') st.phase = 'question';
  else if (st.phase === 'reveal') {
    if (st.i === st.questions.length - 1) {
      st.phase = 'final';
      Object.assign(run, totals(st), { finished_at: now });
    } else {
      st.i++;
      st.phase = st.questions[st.i].round !== st.questions[st.i - 1].round ? 'intro' : 'question';
    }
  } else return save(run);
  st.step++;
  save(run);
}

// ---------------------------------------------------------------- HTTP

let lastCleanup = 0;
function cleanup(now) {
  if (now - lastCleanup < 3600 * 1000) return;
  lastCleanup = now;
  db.get().prepare('DELETE FROM runs WHERE user_id IS NULL AND battle_id IS NULL AND started_at < ?').run(now - GUEST_RUN_TTL);
}

// Gäste erkennt der Server an einem zufälligen Cookie; wer keins hat, bekommt eins
function guestId(req, res, create) {
  let gid = cookies(req)[GUEST_COOKIE];
  if (gid && /^[\w-]{16,64}$/.test(gid)) return gid;
  if (!create) return null;
  gid = newId();
  setCookie(req, res, GUEST_COOKIE, gid, GUEST_MAX_AGE);
  return gid;
}

const owns = (run, gid) => run && gid && run.guest_id === gid;

async function handle(req, res, url) {
  const p = url.pathname;

  if (req.method === 'GET' && p === '/api/quizzes') {
    return send(res, 200, quizzes.listQuizzes().filter((q) => !q.error));
  }

  if (!p.startsWith('/api/run/')) return;
  if (req.method === 'POST' && !sameOrigin(req)) return send(res, 403, { error: 'Anfrage von fremder Seite.' });

  if (req.method === 'POST' && p === '/api/run/start') {
    const body = await readBody(req);
    const now = Date.now();
    cleanup(now);
    let run;
    try {
      run = create({ quizId: body.quizId, guestId: guestId(req, res, true) }, now);
    } catch (e) {
      return send(res, 404, { error: e.message });
    }
    return send(res, 200, view(run, now));
  }

  const m = /^\/api\/run\/([\w-]{10,40})(\/answer|\/next)?$/.exec(p);
  if (!m) return;
  const run = load(m[1]);
  if (!owns(run, guestId(req, res, false))) return send(res, 404, { error: 'Diesen Durchgang gibt es nicht.' });

  if (req.method === 'GET' && !m[2]) return send(res, 200, view(run));
  if (req.method !== 'POST' || !m[2]) return;
  const body = await readBody(req);
  try {
    if (m[2] === '/answer') answer(run, Number(body.index), Number(body.choice));
    else next(run, Number(body.step));
  } catch (e) {
    if (!e.status) throw e;
    return send(res, e.status, { error: e.message, state: view(run) });
  }
  send(res, 200, view(run));
}

module.exports = { handle, create, load, view, answer, next, GRACE_MS };
