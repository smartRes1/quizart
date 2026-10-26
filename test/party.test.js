'use strict';

// Party-Modus über HTTP: ein komplettes Spiel von Beitritt bis Siegerehrung.
// Sichert ab, dass sich das Verhalten beim Umbau nicht ändert.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, waitFor } = require('./helpers');

test('Party: komplettes Spiel', async (t) => {
  const s = await startServer();
  t.after(() => s.stop());

  await t.test('Spielleitung braucht den PIN', async () => {
    const r = await s.get('/api/host/state', { 'X-Host-Pin': 'falsch' });
    assert.equal(r.status, 403);
    assert.equal((await s.get('/api/host/qr.svg?pin=falsch')).status, 403);
  });

  let h = (await s.host.get('state')).data;
  assert.equal(h.quizId, 'testquiz/short');
  assert.equal(h.phase, 'intro');
  assert.equal(h.canReload, true);
  const code = h.code;

  await t.test('QR-Code und Beitrittsseite', async () => {
    const qr = await s.get('/api/host/qr.svg?pin=4711');
    assert.equal(qr.status, 200);
    assert.match(qr.headers.get('content-type'), /svg/);
    const page = await s.get(`/r/${code}`);
    assert.equal(page.status, 200);
    assert.match(page.data, /joinForm/);
    assert.match((await s.get('/party')).data, /joinForm/);
    assert.match((await s.get('/')).data, /Wie heißt du/);
    assert.equal((await s.get('/gibtsnicht')).status, 404);
  });

  let alpha, beta;
  await t.test('Teams treten bei', async () => {
    assert.equal((await s.post('/api/join', { code: 'FALSCH', name: 'Alpha' })).status, 409);
    assert.equal((await s.post('/api/join', { code, name: 'A' })).status, 400);
    alpha = (await s.post('/api/join', { code, name: 'Alpha' })).data.token;
    assert.ok(alpha);
    assert.equal((await s.post('/api/join', { code, name: 'alpha' })).status, 409);
    beta = (await s.post('/api/join', { code, name: 'Beta' })).data.token;
    h = (await s.host.get('state')).data;
    assert.equal(h.playersInRound, 2);
  });

  await t.test('Quiz wechseln vor dem Start behält Teams und Code', async () => {
    const list = (await s.host.get('quizzes')).data;
    assert.deepEqual(list.map((q) => q.id), ['testquiz/short', 'zweites/mid']);
    let r = await s.host.post('select', { id: 'zweites/mid' });
    assert.equal(r.status, 200);
    assert.equal(r.data.state.roundCount, 1);
    r = await s.host.post('select', { id: 'testquiz/short' });
    assert.equal(r.data.state.code, code);
    assert.equal(r.data.state.playersInRound, 2);
    assert.equal((await s.host.post('select', { id: '../x/short' })).status, 400);
  });

  const team = async (token) => (await s.get(`/api/state?token=${encodeURIComponent(token)}`)).data;
  const answer = (token, round, question, choice) => s.post('/api/answer', { token, round, question, choice });

  await t.test('Runde 1, Frage 1: Auflösung, sobald alle geantwortet haben', async () => {
    h = (await s.host.post('next')).data;
    assert.equal(h.phase, 'question');
    const view = await team(alpha);
    assert.equal(view.question.text, 'Eins plus eins?');
    assert.equal(view.question.correct, undefined);
    await team(beta);
    assert.equal((await answer(alpha, 0, 0, 1)).status, 200);
    assert.equal((await answer(alpha, 0, 0, 2)).status, 409);
    assert.equal((await answer(beta, 0, 0, 0)).status, 200);
    h = await waitFor(async () => { const x = (await s.host.get('state')).data; return x.phase === 'reveal' && x; });
    assert.deepEqual(h.question.distribution, [1, 1, 0]);
    const a = await team(alpha);
    assert.equal(a.question.correct, 1);
    assert.equal(a.myAnswer, 1);
    assert.equal(a.question.distribution, undefined);
  });

  await t.test('Frage 2: Spielleitung löst vorzeitig auf, Zwischenergebnis', async () => {
    await s.host.post('next');
    await team(alpha);
    assert.equal((await answer(alpha, 0, 1, 0)).status, 200);
    h = (await s.host.post('next')).data;
    assert.equal(h.phase, 'reveal');
    assert.equal((await answer(beta, 0, 1, 0)).status, 409);
    h = (await s.host.post('next')).data;
    assert.equal(h.phase, 'standings');
    assert.deepEqual(h.ranking.map((r) => [r.name, r.score, r.rank]), [['Alpha', 2, 1], ['Beta', 0, 2]]);
    assert.equal(h.maxPoints, 2);
    assert.equal((await s.host.post('select', { id: 'zweites/mid' })).status, 409);
    assert.equal((await s.host.post('reload')).status, 409);
  });

  await t.test('Runde 2 mit doppelten Punkten, Siegerehrung', async () => {
    h = (await s.host.post('next')).data;
    assert.equal(h.phase, 'intro');
    assert.equal(h.roundIndex, 1);
    assert.equal(h.playersInRound, 2);
    await s.host.post('next');
    await team(alpha);
    await team(beta);
    await answer(alpha, 1, 0, 3);
    await answer(beta, 1, 0, 3);
    await waitFor(async () => (await s.host.get('state')).data.phase === 'reveal');
    h = (await s.host.post('next')).data;
    assert.equal(h.phase, 'final');
    assert.deepEqual(h.ranking.map((r) => [r.name, r.score]), [['Alpha', 4], ['Beta', 2]]);
    assert.equal(h.maxPoints, 4);
    const a = await team(alpha);
    assert.equal(a.me.rank, 1);
    assert.equal(a.ranking.find((r) => r.isMe).name, 'Alpha');
  });

  await t.test('Team entfernen', async () => {
    const id = h.teams.find((x) => x.name === 'Beta').id;
    h = (await s.host.post('kick', { id })).data;
    assert.equal(h.teams.length, 1);
    assert.equal((await team(beta)).team, null);
  });

  await t.test('Spielstand überlebt einen Neustart', async () => {
    // Kein Warten: save() schreibt verzögert, beim Beenden sichert der Server sofort
    await s.stop();
    const s2 = await startServer({ dataDir: s.dataDir });
    t.after(() => s2.stop());
    let x = (await s2.host.get('state')).data;
    assert.equal(x.phase, 'final');
    assert.deepEqual(x.ranking.map((r) => [r.name, r.score]), [['Alpha', 4]]);
    // Party allein legt keine Datenbank an
    assert.equal(fs.existsSync(path.join(s.dataDir, 'quiz.db')), false);

    x = (await s2.host.post('reset', { keepTeams: true, quiz: 'zweites/mid' })).data;
    assert.equal(x.quizId, 'zweites/mid');
    assert.equal(x.phase, 'intro');
    assert.deepEqual(x.teams.map((tm) => [tm.name, tm.inRound]), [['Alpha', false]]);
    assert.notEqual(x.code, code);
    assert.equal((await s2.host.post('reload')).status, 200);
  });
});
