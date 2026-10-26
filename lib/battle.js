'use strict';

// Battle: 1 gegen 1, abwechselnd. Jeder spielt seinen eigenen Durchgang mit denselben
// Fragen in derselben Reihenfolge, wann er Zeit hat; sind beide fertig, steht der Sieger fest.
// Gegner: per Einladungslink (/b/<code>), zufällig von der Plattform oder als Revanche.
// Status: open (noch kein Gegner) → ready (beide dabei) → done, oder expired nach 7 Tagen.

const crypto = require('crypto');
const db = require('./db');
const runs = require('./runs');
const quizzes = require('./quizzes');
const { PUBLIC_URL } = require('./config');
const { notify } = require('./mail');
const { send, readBody, baseUrl, sameOrigin } = require('./http');
const { currentUser } = require('./session');

const DAY = 24 * 3600 * 1000;
const EXPIRE_DAYS = 7;
// Höchstens so viele Battles ohne Gegner gleichzeitig je Spieler
const MAX_OPEN = 5;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const fail = (status, message) => Object.assign(new Error(message), { status });
const newCode = () => Array.from({ length: 8 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
const durationOf = (quizId) => quizId.split('/')[1];
const userName = (id) => (id ? (db.get().prepare('SELECT name FROM users WHERE id = ?').get(id) || {}).name : null);
const userEmail = (id) => (id ? (db.get().prepare('SELECT email FROM users WHERE id = ?').get(id) || {}).email : null);
const load = (id) => db.get().prepare('SELECT * FROM battles WHERE id = ?').get(Number(id)) || null;
const runInfo = (id) => (id ? db.get().prepare('SELECT id, score, ms, correct, finished_at FROM runs WHERE id = ?').get(id) : null);
const seatOf = (b, userId) => (b.player1 === userId ? 1 : b.player2 === userId ? 2 : 0);

// Zufälliges gültiges Quiz der Länge: am liebsten eines, das keiner der Spieler kennt
function pickQuiz(duration, userIds, exclude = null) {
  const pool = quizzes.listQuizzes().filter((q) => !q.error && q.duration === duration && q.id !== exclude);
  const fresh = (ids) => pool.filter((q) => ids.every((u) => !runs.hasPlayed(u, q.id)));
  const choice = [fresh(userIds), fresh(userIds.slice(0, 1)), pool].find((l) => l.length);
  if (!choice) throw fail(404, `Kein Quiz der Länge „${quizzes.DURATIONS[duration] || duration}“ im Pool.`);
  return choice[crypto.randomInt(choice.length)].id;
}

function countOpen(userId) {
  return db.get().prepare("SELECT COUNT(*) AS n FROM battles WHERE player1 = ? AND status = 'open' AND expires_at > ?").get(userId, Date.now()).n;
}

// Neues Battle; player1 spielt sofort, player2 (bei Revanche) bekommt seinen Durchgang gleich mit
function createBattle({ quizId, kind, player1, player2 = null, rematchOf = null }, now = Date.now()) {
  const d = db.get();
  const id = Number(d.prepare(`INSERT INTO battles (quiz_id, kind, invite_code, player1, player2, status, rematch_of, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(quizId, kind, kind === 'invite' ? newCode() : null, player1, player2,
    player2 ? 'ready' : 'open', rematchOf, now, now + EXPIRE_DAYS * DAY).lastInsertRowid);
  const run1 = runs.create({ quizId, mode: 'battle', userId: player1, battleId: id }, now);
  const run2 = player2 ? runs.create({ quizId, mode: 'battle', userId: player2, battleId: id, sameAs: run1 }, now) : null;
  d.prepare('UPDATE battles SET run1 = ?, run2 = ? WHERE id = ?').run(run1.id, run2 && run2.id, id);
  return load(id);
}

function join(b, userId, now = Date.now()) {
  const run2 = runs.create({ quizId: b.quiz_id, mode: 'battle', userId, battleId: b.id, sameAs: runs.load(b.run1) }, now);
  // Ab dem Annehmen haben beide wieder die volle Zeit
  db.get().prepare("UPDATE battles SET player2 = ?, run2 = ?, status = 'ready', expires_at = ? WHERE id = ?")
    .run(userId, run2.id, now + EXPIRE_DAYS * DAY, b.id);
  return load(b.id);
}

// Mehr Punkte gewinnt, bei Gleichstand die kürzere Zeit der richtigen Antworten; 0 = unentschieden
const compare = (a, b) => (a.score !== b.score ? (a.score > b.score ? 1 : 2) : a.ms !== b.ms ? (a.ms < b.ms ? 1 : 2) : 0);

// Wertet aus, sobald beide fertig sind oder die Zeit um ist; wird bei jedem Lesen und nach jedem fertigen Durchgang aufgerufen
function settle(b, now = Date.now()) {
  if (!b || b.status === 'done' || b.status === 'expired') return b;
  const r1 = runInfo(b.run1), r2 = runInfo(b.run2);
  let status, winner;
  if (r1 && r1.finished_at && r2 && r2.finished_at) [status, winner] = ['done', compare(r1, r2)];
  else if (now > b.expires_at) [status, winner] = ['expired', !b.run2 ? null : r1 && r1.finished_at ? 1 : r2 && r2.finished_at ? 2 : 0];
  else return b;
  db.get().prepare('UPDATE battles SET status = ?, winner = ?, finished_at = ? WHERE id = ?').run(status, winner, now, b.id);
  if (status === 'done') announce(load(b.id));
  return load(b.id);
}

function announce(b) {
  const link = PUBLIC_URL ? `\n\nZum Ergebnis: ${PUBLIC_URL}/battle/${b.id}` : '';
  for (const seat of [1, 2]) {
    const me = seat === 1 ? b.player1 : b.player2;
    const other = userName(seat === 1 ? b.player2 : b.player1) || 'Gelöschter Spieler';
    const verdict = b.winner === 0 ? `Unentschieden gegen ${other}.` : b.winner === seat ? `Du hast gegen ${other} gewonnen!` : `${other} hat diesmal gewonnen.`;
    notify(userEmail(me), `Duell-Ergebnis: ${verdict}`, `${verdict}${link}\n`);
  }
}

runs.onFinish((run, now) => { if (run.battle_id) settle(load(run.battle_id), now); });

function label(b, seat, mine) {
  if (b.status === 'done' || b.status === 'expired') {
    if (b.winner === null || b.winner === undefined) return 'Abgelaufen';
    return b.winner === 0 ? 'Unentschieden' : b.winner === seat ? 'Gewonnen' : 'Verloren';
  }
  return mine && mine.finished_at ? 'Warte auf Gegner' : 'Du bist dran';
}

// Sicht eines Spielers; die Punkte des Gegners erst, wenn man selbst fertig ist
function view(req, b, userId, { detail = false } = {}) {
  const seat = seatOf(b, userId);
  const mine = runInfo(seat === 1 ? b.run1 : b.run2);
  const theirs = runInfo(seat === 1 ? b.run2 : b.run1);
  const over = b.status === 'done' || b.status === 'expired';
  const showTheirs = over || (mine && mine.finished_at);
  const score = (r) => (r && r.finished_at ? { score: r.score, ms: r.ms, correct: r.correct } : {});
  const opponentId = seat === 1 ? b.player2 : b.player1;
  const quiz = quizzes.listQuizzes().find((q) => q.id === b.quiz_id);
  const p = {
    id: b.id,
    kind: b.kind,
    status: b.status,
    quiz: { id: b.quiz_id, title: quiz ? quiz.title : b.quiz_id, durationLabel: quizzes.DURATIONS[durationOf(b.quiz_id)], questions: quiz && quiz.questions },
    createdAt: b.created_at,
    expiresAt: b.expires_at,
    label: label(b, seat, mine),
    turn: !over && !(mine && mine.finished_at),
    me: { name: userName(userId), runId: mine && mine.id, finished: !!(mine && mine.finished_at), ...score(mine) },
    opponent: b.status === 'open' ? null
      : { name: userName(opponentId) || 'Gelöschter Spieler', finished: !!(theirs && theirs.finished_at), ...(showTheirs ? score(theirs) : {}) },
    result: over && b.winner !== null ? (b.winner === 0 ? 'draw' : b.winner === seat ? 'won' : 'lost') : null,
  };
  if (b.kind === 'invite' && b.status === 'open' && seat === 1) p.inviteUrl = `${baseUrl(req)}/b/${b.invite_code}`;
  if (detail) {
    const rematch = db.get().prepare('SELECT id FROM battles WHERE rematch_of = ?').get(b.id);
    p.rematchId = rematch ? rematch.id : null;
    p.canRematch = over && !!opponentId && !rematch;
    if (b.status === 'done') {
      const a = runs.load(mine.id).state, o = runs.load(theirs.id).state;
      p.review = a.questions.map((q, i) => ({ text: q.text, correct: q.options[q.correct], me: a.answers[i].ok, opponent: o.answers[i].ok }));
    }
  }
  return p;
}

function myBattles(userId, now = Date.now()) {
  const rows = db.get().prepare(`SELECT * FROM battles WHERE (player1 = ? OR player2 = ?) AND (status IN ('open', 'ready') OR created_at > ?)
    ORDER BY created_at DESC LIMIT 50`).all(userId, userId, now - 30 * DAY);
  return rows.map((b) => settle(b, now));
}

// Konto wird gelöscht: Battles ohne Gegner verschwinden, laufende bleiben für den Gegner
function forgetUser(userId) {
  const d = db.get();
  for (const b of d.prepare("SELECT id FROM battles WHERE player1 = ? AND player2 IS NULL").all(userId)) {
    d.prepare('DELETE FROM runs WHERE battle_id = ?').run(b.id);
    d.prepare('DELETE FROM battles WHERE id = ?').run(b.id);
  }
}

// ---------------------------------------------------------------- HTTP

async function handle(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith('/api/battle')) return;
  if (req.method === 'POST' && !sameOrigin(req)) return send(res, 403, { error: 'Anfrage von fremder Seite.' });
  const user = currentUser(req);
  const now = Date.now();

  // Einladung ansehen geht ohne Anmeldung, damit der Link zeigt, wer herausfordert
  const inv = /^\/api\/battle\/invite\/([A-Za-z0-9]{6,12})(\/accept)?$/.exec(p);
  if (inv) {
    let b = db.get().prepare('SELECT * FROM battles WHERE invite_code = ?').get(inv[1].toUpperCase());
    if (!b) return send(res, 404, { error: 'Diese Einladung gibt es nicht.' });
    b = settle(b, now);
    const seat = user ? seatOf(b, user.id) : 0;
    if (req.method === 'GET' && !inv[2]) {
      const quiz = quizzes.listQuizzes().find((q) => q.id === b.quiz_id);
      return send(res, 200, {
        from: userName(b.player1) || 'Gelöschter Spieler',
        quiz: { title: quiz ? quiz.title : b.quiz_id, durationLabel: quizzes.DURATIONS[durationOf(b.quiz_id)], questions: quiz && quiz.questions },
        state: seat ? 'mine' : b.status === 'open' ? 'open' : b.status === 'expired' ? 'expired' : 'taken',
        battleId: seat ? b.id : null,
        loggedIn: !!user,
      });
    }
    if (req.method !== 'POST' || !inv[2]) return;
    if (!user) return send(res, 401, { error: 'Bitte zuerst anmelden.' });
    if (seat) return send(res, 200, { battleId: b.id });
    if (b.status !== 'open') return send(res, 409, { error: b.status === 'expired' ? 'Diese Einladung ist abgelaufen.' : 'Diese Einladung hat schon jemand angenommen.' });
    if (!b.player1) return send(res, 410, { error: 'Diese Einladung gibt es nicht mehr.' });
    return send(res, 200, { battleId: join(b, user.id, now).id });
  }

  if (!user) return send(res, 401, { error: 'Bitte zuerst anmelden.' });

  if (req.method === 'GET' && p === '/api/battles') {
    return send(res, 200, myBattles(user.id, now).map((b) => view(req, b, user.id)));
  }

  if (req.method === 'POST' && (p === '/api/battle' || p === '/api/battle/random')) {
    const body = await readBody(req);
    if (countOpen(user.id) >= MAX_OPEN) {
      return send(res, 409, { error: `Du hast schon ${MAX_OPEN} Duelle ohne Gegner offen. Warte, bis jemand annimmt, oder spiel eines davon zu Ende.` });
    }
    try {
      if (p === '/api/battle') {
        const quizId = quizzes.loadQuiz(body.quizId).id;
        return send(res, 200, view(req, createBattle({ quizId, kind: 'invite', player1: user.id }, now), user.id));
      }
      const duration = String(body.duration || '');
      if (!quizzes.DURATIONS[duration]) return send(res, 400, { error: 'Ungültige Länge.' });
      // Ein eigenes, noch nicht fertig gespieltes Zufalls-Battle dieser Länge geht vor
      const own = db.get().prepare(`SELECT b.* FROM battles b JOIN runs r ON r.id = b.run1 WHERE b.kind = 'random' AND b.status = 'open'
        AND b.player1 = ? AND r.finished_at IS NULL AND b.quiz_id LIKE ? AND b.expires_at > ?`).get(user.id, `%/${duration}`, now);
      if (own) return send(res, 200, view(req, own, user.id));
      // Sonst das älteste offene eines anderen, dessen Quiz man noch nicht kennt
      const waiting = db.get().prepare(`SELECT * FROM battles WHERE kind = 'random' AND status = 'open' AND player1 IS NOT NULL
        AND player1 != ? AND quiz_id LIKE ? AND expires_at > ? ORDER BY created_at`).all(user.id, `%/${duration}`, now);
      const match = waiting.find((b) => !runs.hasPlayed(user.id, b.quiz_id));
      const b = match ? join(match, user.id, now) : createBattle({ quizId: pickQuiz(duration, [user.id]), kind: 'random', player1: user.id }, now);
      return send(res, 200, view(req, b, user.id));
    } catch (e) {
      if (!e.status && !/gibt es nicht/.test(e.message)) throw e;
      return send(res, e.status || 404, { error: e.message });
    }
  }

  const m = /^\/api\/battle\/(\d+)(\/rematch)?$/.exec(p);
  if (!m) return;
  const b = settle(load(m[1]), now);
  if (!b || !seatOf(b, user.id)) return send(res, 404, { error: 'Dieses Duell gibt es nicht.' });
  if (req.method === 'GET' && !m[2]) return send(res, 200, view(req, b, user.id, { detail: true }));
  if (req.method !== 'POST' || !m[2]) return;

  const existing = db.get().prepare('SELECT id FROM battles WHERE rematch_of = ?').get(b.id);
  if (existing) return send(res, 200, { battleId: existing.id });
  const opponent = seatOf(b, user.id) === 1 ? b.player2 : b.player1;
  if ((b.status !== 'done' && b.status !== 'expired') || !opponent) return send(res, 409, { error: 'Eine Revanche geht erst, wenn das Duell vorbei ist.' });
  let quizId;
  try {
    quizId = pickQuiz(durationOf(b.quiz_id), [user.id, opponent], b.quiz_id);
  } catch (e) {
    return send(res, e.status || 400, { error: e.message });
  }
  const r = createBattle({ quizId, kind: 'rematch', player1: user.id, player2: opponent, rematchOf: b.id }, now);
  notify(userEmail(opponent), `${user.name} fordert dich zur Revanche heraus`,
    `${user.name} will eine Revanche im Duell.${PUBLIC_URL ? `\n\nJetzt spielen: ${PUBLIC_URL}/battle/${r.id}` : ''}\n`);
  send(res, 200, { battleId: r.id });
}

module.exports = { handle, settle, forgetUser, pickQuiz, compare };
