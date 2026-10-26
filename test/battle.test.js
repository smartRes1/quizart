'use strict';

// Battle über HTTP: Einladung, zufälliger Gegner, Auswertung, Revanche, Ablauf, Konto löschen

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { startServer, login, play, FIXTURE_QUIZZES } = require('./helpers');

// Eigener Pool mit zwei kurzen Quizzen, damit Zufall und Revanche eine Auswahl haben
function pool() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quizart-battle-pool-'));
  fs.cpSync(FIXTURE_QUIZZES, dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'drittes'));
  fs.writeFileSync(path.join(dir, 'drittes', 'short.json'), JSON.stringify({
    title: 'Drittes Quiz',
    rounds: [{ name: 'Rechnen', questions: [{ q: 'Drei mal drei?', options: ['6', '9', '12'], correct: 'B' }] }],
  }));
  return dir;
}

test('Battle', async (t) => {
  const s = await startServer({ env: { QUIZ_DIR: pool() } });
  t.after(() => s.stop());
  const sql = (q, ...args) => {
    const d = new DatabaseSync(path.join(s.dataDir, 'quiz.db'));
    try { return d.prepare(q).all(...args); } finally { d.close(); }
  };

  const anna = s.browser(), bert = s.browser(), carl = s.browser(), dora = s.browser();
  await login(s, anna, 'anna@example.at', '/', 'Anna');
  await login(s, bert, 'bert@example.at', '/', 'Bert');
  await login(s, carl, 'carl@example.at', '/', 'Carl');
  await login(s, dora, 'dora@example.at', '/', 'Dora');

  let inv, code;
  await t.test('Einladung erstellen und zuerst selbst spielen', async () => {
    assert.equal((await s.post('/api/battle', { quizId: 'testquiz/short' })).status, 401);
    assert.equal((await anna.post('/api/battle', { quizId: 'gibts/short' })).status, 404);
    inv = (await anna.post('/api/battle', { quizId: 'testquiz/short' })).data;
    assert.equal(inv.status, 'open');
    assert.equal(inv.turn, true);
    assert.equal(inv.opponent, null);
    code = /\/b\/([A-Z0-9]{8})$/.exec(inv.inviteUrl)[1];
    assert.equal((await s.get(`/b/${code}`)).status, 200);
    assert.equal((await s.get(`/battle/${inv.id}`)).status, 200);

    const v = await play(anna, { runId: inv.me.runId }, 1);
    assert.equal(v.mode, 'battle');
    assert.equal(v.battleId, inv.id);
    assert.equal(v.board, undefined);
    const b = (await anna.get(`/api/battle/${inv.id}`)).data;
    assert.deepEqual([b.label, b.turn, b.me.score], ['Warte auf Gegner', false, 3]);
  });

  await t.test('Einladung ansehen und annehmen', async () => {
    let i = (await s.get(`/api/battle/invite/${code.toLowerCase()}`)).data;
    assert.deepEqual([i.from, i.state, i.loggedIn, i.quiz.title], ['Anna', 'open', false, 'Testquiz']);
    assert.equal((await s.post(`/api/battle/invite/${code}/accept`)).status, 401);
    assert.equal((await anna.post(`/api/battle/invite/${code}/accept`)).data.battleId, inv.id);
    assert.equal((await bert.post(`/api/battle/invite/${code}/accept`)).data.battleId, inv.id);
    assert.equal((await carl.post(`/api/battle/invite/${code}/accept`)).status, 409);
    i = (await carl.get(`/api/battle/invite/${code}`)).data;
    assert.equal(i.state, 'taken');
    assert.equal((await carl.get(`/api/battle/${inv.id}`)).status, 404);

    const b = (await bert.get(`/api/battle/${inv.id}`)).data;
    assert.equal(b.turn, true);
    // Gegner ist fertig, seine Punkte sieht man aber erst nach dem eigenen Spiel
    assert.deepEqual(b.opponent, { name: 'Anna', finished: true });
    // Beide spielen dieselben Fragen in derselben Reihenfolge
    const [r1, r2] = sql('SELECT state FROM runs WHERE battle_id = ? ORDER BY started_at, rowid', inv.id).map((r) => JSON.parse(r.state).questions);
    assert.deepEqual(r2, r1);
  });

  await t.test('Auswertung, wenn beide fertig sind', async () => {
    const b0 = (await bert.get(`/api/battle/${inv.id}`)).data;
    await play(bert, { runId: b0.me.runId });
    const b = (await anna.get(`/api/battle/${inv.id}`)).data;
    assert.deepEqual([b.status, b.result, b.label], ['done', 'lost', 'Verloren']);
    assert.deepEqual([b.me.score, b.opponent.score], [3, 4]);
    assert.deepEqual(b.review.map((q) => [q.me, q.opponent]), [[false, true], [true, true], [true, true]]);
    assert.equal(b.canRematch, true);
    const list = (await bert.get('/api/battles')).data;
    assert.deepEqual(list.map((x) => [x.id, x.label]), [[inv.id, 'Gewonnen']]);
    // Wer die Fragen aus dem Battle kennt, kommt damit nicht mehr in die Bestenliste
    assert.equal((await bert.post('/api/run/start', { quizId: 'testquiz/short' })).data.countsForBoard, false);
  });

  await t.test('Revanche mit einem Quiz, das beide noch nicht kennen', async () => {
    const r = (await anna.post(`/api/battle/${inv.id}/rematch`)).data;
    assert.equal((await bert.post(`/api/battle/${inv.id}/rematch`)).data.battleId, r.battleId);
    const b = (await bert.get(`/api/battle/${r.battleId}`)).data;
    assert.deepEqual([b.kind, b.status, b.quiz.id, b.turn, b.opponent.name], ['rematch', 'ready', 'drittes/short', true, 'Anna']);
    assert.equal((await anna.get(`/api/battle/${inv.id}`)).data.rematchId, r.battleId);
  });

  let carlsBattle;
  await t.test('Zufälliger Gegner', async () => {
    assert.equal((await carl.post('/api/battle/random', { duration: 'riesig' })).status, 400);
    carlsBattle = (await carl.post('/api/battle/random', { duration: 'short' })).data;
    assert.deepEqual([carlsBattle.kind, carlsBattle.status, carlsBattle.inviteUrl], ['random', 'open', undefined]);
    // Noch nicht gespielt: derselbe Aufruf führt zurück ins selbe Battle
    assert.equal((await carl.post('/api/battle/random', { duration: 'short' })).data.id, carlsBattle.id);
    await play(carl, { runId: carlsBattle.me.runId });

    // Anna kennt beide kurzen Quizze und wird nicht mit Carl gepaart
    const a = (await anna.post('/api/battle/random', { duration: 'short' })).data;
    assert.notEqual(a.id, carlsBattle.id);
    assert.equal(a.status, 'open');
    // Dora ist neu und bekommt Carls Battle
    const d = (await dora.post('/api/battle/random', { duration: 'short' })).data;
    assert.equal(d.id, carlsBattle.id);
    assert.deepEqual([d.status, d.opponent.name, d.opponent.finished, d.turn], ['ready', 'Carl', true, true]);
  });

  await t.test('Nach 7 Tagen abgelaufen: wer gespielt hat, gewinnt', async () => {
    sql('UPDATE battles SET expires_at = 1 WHERE id = ?', carlsBattle.id);
    const c = (await carl.get(`/api/battle/${carlsBattle.id}`)).data;
    assert.deepEqual([c.status, c.result, c.label], ['expired', 'won', 'Gewonnen']);
    const d = (await dora.get('/api/battles')).data.find((x) => x.id === carlsBattle.id);
    assert.equal(d.label, 'Verloren');
    // Abgelaufen ohne Gegner: kein Sieger
    const open = (await anna.get('/api/battles')).data.find((x) => x.kind === 'random');
    sql('UPDATE battles SET expires_at = 1 WHERE id = ?', open.id);
    assert.equal((await anna.get(`/api/battle/${open.id}`)).data.label, 'Abgelaufen');
  });

  await t.test('Höchstens 5 offene Battles ohne Gegner', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await carl.post('/api/battle', { quizId: 'zweites/mid' })).status, 200);
    assert.equal((await carl.post('/api/battle', { quizId: 'zweites/mid' })).status, 409);
    assert.equal((await carl.post('/api/battle/random', { duration: 'mid' })).status, 409);
  });

  await t.test('Konto löschen: offene Battles weg, laufende bleiben für den Gegner', async () => {
    assert.equal((await carl.post('/api/me/delete')).status, 200);
    assert.equal(sql("SELECT COUNT(*) AS n FROM battles WHERE kind = 'invite' AND quiz_id = 'zweites/mid'")[0].n, 0);
    const d = (await dora.get(`/api/battle/${carlsBattle.id}`)).data;
    assert.deepEqual([d.opponent.name, d.result], ['Gelöschter Spieler', 'lost']);
    assert.equal(d.canRematch, false);
  });
});
