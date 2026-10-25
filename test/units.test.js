'use strict';

// Reine Logik ohne Server: Wertung, Datenbank-Migrationen, Quiz-Pool

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FIXTURE_QUIZZES } = require('./helpers');

process.env.QUIZ_DIR = FIXTURE_QUIZZES;
const { rankRows, distribution } = require('../lib/scoring');
const db = require('../lib/db');
const quizzes = require('../lib/quizzes');

test('rankRows: Punkte vor Zeit, Gleichstand teilt den Platz', () => {
  const rows = rankRows([
    { name: 'Langsam', score: 3, ms: 9000 },
    { name: 'Null', score: 0, ms: 0 },
    { name: 'Schnell', score: 3, ms: 4000 },
    { name: 'Bert', score: 1, ms: 2000 },
    { name: 'Anna', score: 1, ms: 2000 },
  ]);
  assert.deepEqual(rows.map((r) => [r.name, r.rank]), [['Schnell', 1], ['Langsam', 2], ['Anna', 3], ['Bert', 3], ['Null', 5]]);
});

test('distribution zählt Antworten je Option', () => {
  const q = { options: ['a', 'b', 'c'] };
  assert.deepEqual(distribution(q, { x: { choice: 2 }, y: { choice: 2 }, z: { choice: 0 }, w: { choice: 7 } }), [1, 0, 2]);
  assert.deepEqual(distribution(q, undefined), [0, 0, 0]);
});

test('Datenbank: Migrationen laufen einmal und in Reihenfolge', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quizart-db-')), 'test.db');
  const steps = ['CREATE TABLE a (x INTEGER)', 'ALTER TABLE a ADD COLUMN y TEXT'];
  let d = db.open(file, steps);
  d.prepare('INSERT INTO a (x, y) VALUES (1, ?)').run('eins');
  d.close();

  d = db.open(file, steps); // zweites Öffnen: nichts doppelt
  assert.equal(d.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '2');
  assert.equal(d.prepare('SELECT y FROM a').get().y, 'eins');
  d.close();

  // Fehlerhafte Migration wird zurückgerollt, Version bleibt
  assert.throws(() => db.open(file, [...steps, 'CREATE TABLE b (z); KAPUTT']), /Migration 3/);
  d = db.open(file, steps);
  assert.equal(d.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '2');
  assert.equal(d.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'b'").get().n, 0);
  d.close();

  assert.throws(() => db.open(file, steps.slice(0, 1)), /Version 2/);
});

test('Quiz-Pool: Liste, Laden, Fehler', () => {
  const list = quizzes.listQuizzes();
  assert.deepEqual(list.map((q) => [q.id, q.rounds, q.questions]), [['testquiz/short', 2, 3], ['zweites/mid', 1, 1]]);
  const qz = quizzes.loadQuiz('testquiz/short');
  assert.equal(qz.rounds[0].questions[0].correct, 1);
  assert.equal(qz.rounds[1].questions[0].points, 2);
  assert.equal(qz.rounds[0].questions[0].seconds, 5);
  assert.throws(() => quizzes.loadQuiz('../etc/short'), /gibt es nicht/);
  assert.equal(quizzes.defaultQuizId(), 'testquiz/short');
});
