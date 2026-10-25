'use strict';

// Solo als Gast über HTTP: Quiz wählen, durchspielen, fremde Durchgänge bleiben verborgen

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const RIGHT = { 'Eins plus eins?': '2', 'Farbe des Himmels?': 'Blau', 'Doppelte Punkte?': 'Egal' };

test('Solo als Gast', async (t) => {
  const s = await startServer();
  t.after(() => s.stop());

  await t.test('Seiten und Quiz-Liste', async () => {
    assert.match((await s.get('/solo')).data, /Wähle dein Quiz/);
    assert.match((await s.get('/solo/abcdefghijklmnop')).data, /Wähle dein Quiz/);
    assert.equal((await s.get('/common.js')).status, 200);
    assert.match((await s.get('/common.css')).headers.get('content-type'), /text\/css/);
    const list = (await s.get('/api/quizzes')).data;
    assert.deepEqual(list.map((q) => q.id), ['testquiz/short', 'zweites/mid']);
    assert.equal(list[0].error, undefined);
  });

  let cookie, run;
  await t.test('Start legt ein Gast-Cookie an', async () => {
    assert.equal((await s.post('/api/run/start', { quizId: '../x/short' })).status, 404);
    const r = await s.post('/api/run/start', { quizId: 'testquiz/short' });
    assert.equal(r.status, 200);
    const set = r.headers.get('set-cookie');
    assert.match(set, /gid=[\w-]+; Path=\/; HttpOnly; SameSite=Lax/);
    assert.doesNotMatch(set, /Secure/);
    cookie = set.split(';')[0];
    run = r.data;
    assert.equal(run.phase, 'intro');
    // Mit Cookie bleibt es beim selben Gast
    const again = await s.post('/api/run/start', { quizId: 'zweites/mid' }, { Cookie: cookie });
    assert.equal(again.headers.get('set-cookie'), null);
  });

  await t.test('Fremde sehen den Durchgang nicht', async () => {
    assert.equal((await s.get(`/api/run/${run.id}`)).status, 404);
    assert.equal((await s.get(`/api/run/${run.id}`, { Cookie: 'gid=fremderGastAbcdefgh' })).status, 404);
    assert.equal((await s.post(`/api/run/${run.id}/next`, { step: 0 }, { Cookie: cookie, Origin: 'https://boese.example' })).status, 403);
  });

  await t.test('Durchspielen bis zum Ergebnis', async () => {
    const as = (p, body) => s.post(`/api/run/${run.id}/${p}`, body, { Cookie: cookie });
    let v = run;
    while (v.phase !== 'final') {
      if (v.phase === 'question') {
        v = (await as('answer', { index: v.number - 1, choice: v.question.options.indexOf(RIGHT[v.question.text]) })).data;
        assert.equal(v.phase, 'reveal');
        assert.equal(v.myAnswer, v.question.correct);
      } else {
        v = (await as('next', { step: v.step })).data;
      }
    }
    assert.deepEqual([v.score, v.maxPoints, v.correct], [4, 4, 3]);
    assert.equal((await as('answer', { index: 2, choice: 0 })).status, 409);
    const fetched = (await s.get(`/api/run/${run.id}`, { Cookie: cookie })).data;
    assert.equal(fetched.phase, 'final');
  });
});
