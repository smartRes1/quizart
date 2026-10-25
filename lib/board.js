'use strict';

// Bestenliste je Quiz: der erste fertige Solo-Durchgang jedes angemeldeten Spielers

const db = require('./db');
const quizzes = require('./quizzes');
const { rankRows } = require('./scoring');
const { send } = require('./http');
const { currentUser } = require('./session');

function entries(quizId) {
  const rows = db.get().prepare(`SELECT r.user_id AS userId, u.name, r.score, r.ms, r.correct, r.finished_at AS finishedAt
    FROM runs r JOIN users u ON u.id = r.user_id
    WHERE r.quiz_id = ? AND r.counts_for_board = 1 AND r.finished_at IS NOT NULL`).all(quizId);
  return rankRows(rows.map((r) => ({ ...r })));
}

// Platz eines Spielers, z. B. für das Ergebnis direkt nach dem Spielen
function position(quizId, userId) {
  const rows = entries(quizId);
  const me = rows.find((r) => r.userId === userId);
  return me ? { rank: me.rank, of: rows.length } : null;
}

async function handle(req, res, url) {
  if (req.method !== 'GET' || url.pathname !== '/api/board') return;
  const quiz = quizzes.listQuizzes().find((q) => q.id === url.searchParams.get('quiz') && !q.error);
  if (!quiz) return send(res, 404, { error: 'Dieses Quiz gibt es nicht.' });
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 50, 1), 200);
  const user = currentUser(req);
  const rows = entries(quiz.id).map(({ userId, ...r }) => ({ ...r, isMe: !!user && userId === user.id }));
  send(res, 200, {
    quiz: { id: quiz.id, title: quiz.title, durationLabel: quiz.durationLabel, questions: quiz.questions },
    total: rows.length,
    top: rows.slice(0, limit),
    me: rows.find((r) => r.isMe) || null,
  });
}

module.exports = { handle, entries, position };
