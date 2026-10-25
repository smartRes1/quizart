'use strict';

// Durchgangs-Logik (Solo/Battle) mit eigener Uhr, ohne Server

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FIXTURE_QUIZZES } = require('./helpers');

process.env.QUIZ_DIR = FIXTURE_QUIZZES;
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'quizart-runs-'));
const runs = require('../lib/runs');
const { GRACE_MS } = runs;

// Wählt die richtige Antwort über den Text, weil die Reihenfolge je Durchgang gemischt ist
const RIGHT = { 'Eins plus eins?': '2', 'Farbe des Himmels?': 'Blau', 'Doppelte Punkte?': 'Egal' };
const rightIndex = (v) => v.question.options.indexOf(RIGHT[v.question.text]);
const wrongIndex = (v) => v.question.options.findIndex((o) => o !== RIGHT[v.question.text]);

test('kompletter Durchgang: Intro, Fragen, Rundenwechsel, Ergebnis', () => {
  let t = 1_000_000;
  const run = runs.create({ quizId: 'testquiz/short', guestId: 'g1' }, t);
  let v = runs.view(run, t);
  assert.equal(v.phase, 'intro');
  assert.equal(v.roundName, 'Runde Eins');
  assert.equal(v.roundQuestions, 2);
  assert.equal(v.question, undefined);

  runs.next(run, v.step, t);
  v = runs.view(run, (t += 100));
  assert.equal(v.phase, 'question');
  assert.equal(v.question.text, 'Eins plus eins?');
  assert.equal(v.question.correct, undefined, 'keine Lösung vor der Antwort');
  assert.equal(v.question.remainingMs, 5000);

  // Neu laden setzt die Zeit nicht zurück
  v = runs.view(runs.load(run.id), (t += 1200));
  assert.equal(v.question.remainingMs, 3800);

  const r1 = runs.load(run.id);
  runs.answer(r1, 0, rightIndex(v), t);
  v = runs.view(r1, t);
  assert.equal(v.phase, 'reveal');
  assert.equal(v.question.options[v.question.correct], '2');
  assert.equal(v.ms, 1200);
  assert.equal(v.score, 1);
  assert.throws(() => runs.answer(r1, 0, 0, t), { status: 409 });

  // Doppeltes Weiter mit demselben step überspringt keine Frage
  const step = v.step;
  runs.next(r1, step, t);
  runs.next(r1, step, t);
  v = runs.view(r1, (t += 10));
  assert.equal(v.phase, 'question');
  assert.equal(v.number, 2);

  // Zu spät: nach Frist + Spielraum gilt die Frage als falsch
  assert.throws(() => runs.answer(r1, 1, rightIndex(v), t + 5000 + GRACE_MS + 1), { status: 409, message: /Zeit/ });
  v = runs.view(r1, t + 5000 + GRACE_MS + 1);
  assert.equal(v.phase, 'reveal');
  assert.equal(v.myAnswer, null);
  assert.equal(v.last, false);

  // Neue Runde beginnt mit Intro
  runs.next(r1, v.step, (t += 6000));
  v = runs.view(r1, t);
  assert.equal(v.phase, 'intro');
  assert.equal(v.roundIndex, 1);
  runs.next(r1, v.step, t);
  v = runs.view(r1, t);
  assert.equal(v.question.points, 2);

  // Innerhalb des Spielraums noch angenommen, Zeit auf das Limit gekappt
  runs.answer(r1, 2, rightIndex(v), t + 5000 + GRACE_MS - 1);
  v = runs.view(r1, (t += 5400));
  assert.equal(v.ms, 5000);
  assert.equal(v.last, true);
  runs.next(r1, v.step, t);
  v = runs.view(r1, t);
  assert.equal(v.phase, 'final');
  assert.deepEqual([v.score, v.maxPoints, v.correct, v.total, v.ms], [3, 4, 2, 3, 6200]);
  assert.deepEqual(v.review.map((x) => x.ok), [true, false, true]);
  assert.equal(v.review[1].mine, null);

  const row = runs.load(run.id);
  assert.deepEqual([row.score, row.ms, row.correct, row.finished_at], [3, 6200, 2, t]);
  assert.equal(row.counts_for_board, 0);
});

test('falsche und ungültige Antworten', () => {
  const t = 2_000_000;
  const run = runs.create({ quizId: 'testquiz/short' }, t);
  runs.next(run, 0, t);
  const v = runs.view(run, t);
  assert.throws(() => runs.answer(run, 0, 7, t), { status: 400 });
  assert.throws(() => runs.answer(run, 1, 0, t), { status: 409 });
  runs.answer(run, 0, wrongIndex(v), t + 300);
  const after = runs.view(run, t + 300);
  assert.equal(after.score, 0);
  assert.notEqual(after.myAnswer, after.question.correct);
});

test('Antworten werden je Durchgang neu gemischt', () => {
  const seen = new Set();
  for (let i = 0; i < 30; i++) {
    const run = runs.create({ quizId: 'testquiz/short' });
    const q = run.state.questions[2];
    assert.equal(q.options[q.correct], 'Egal');
    seen.add(q.correct);
  }
  assert.ok(seen.size > 1);
});

test('unbekanntes Quiz', () => {
  assert.throws(() => runs.create({ quizId: 'gibts/short' }), /gibt es nicht/);
});
