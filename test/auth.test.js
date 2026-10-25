'use strict';

// Anmeldung per E-Mail-Link, Konto, Bestenliste und Übernahme eines Gast-Ergebnisses über HTTP

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { startServer, waitFor, mailLink } = require('./helpers');

const RIGHT = { 'Eins plus eins?': '2', 'Farbe des Himmels?': 'Blau', 'Doppelte Punkte?': 'Egal', 'Nur eine Frage?': 'Ja' };

// Spielt einen Durchgang zu Ende; wrong = Anzahl absichtlich falscher Antworten am Anfang
async function play(b, quizId, wrong = 0) {
  let v = (await b.post('/api/run/start', { quizId })).data;
  const id = v.id;
  while (v.phase !== 'final') {
    if (v.phase === 'question') {
      const right = v.question.options.indexOf(RIGHT[v.question.text]);
      const choice = wrong-- > 0 ? (right + 1) % v.question.options.length : right;
      v = (await b.post(`/api/run/${id}/answer`, { index: v.number - 1, choice })).data;
    } else {
      v = (await b.post(`/api/run/${id}/next`, { step: v.step })).data;
    }
  }
  return v;
}

async function login(s, b, email, next) {
  const r = await b.post('/auth/email', { email, next });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const token = await waitFor(() => mailLink(s.output(), email));
  return b.post('/auth/email/verify', { token });
}

test('Anmeldung, Konto und Bestenliste', async (t) => {
  const s = await startServer();
  t.after(() => s.stop());

  await t.test('Seiten', async () => {
    for (const p of ['/login', '/konto', '/bestenliste', '/datenschutz', '/impressum']) {
      assert.equal((await s.get(p)).status, 200, p);
    }
    const me = (await s.get('/api/me')).data;
    assert.deepEqual(me, { providers: { email: true, google: false, facebook: false }, user: null });
    assert.equal((await s.get('/auth/google')).status, 404);
  });

  const anna = s.browser();
  let guestResult;
  await t.test('Gast spielt, meldet sich an, Ergebnis kommt in die Bestenliste', async () => {
    guestResult = await play(anna, 'testquiz/short', 1);
    assert.equal(guestResult.guest, true);
    assert.equal(guestResult.claimable, true);
    assert.equal((await s.get('/api/board?quiz=testquiz/short')).data.total, 0);

    assert.equal((await anna.post('/auth/email', { email: 'kein-mail' })).status, 400);
    assert.equal((await anna.post('/auth/email', { email: 'anna@example.at' }, { Origin: 'https://boese.example' })).status, 403);
    const r = await login(s, anna, 'Anna@Example.at', `/solo/${guestResult.id}`);
    assert.equal(r.status, 200);
    // Neues Konto: zuerst den Namen wählen, danach zurück zum Ergebnis
    assert.equal(r.data.next, `/konto?neu=1&next=${encodeURIComponent('/solo/' + guestResult.id)}`);
    assert.ok(anna.jar.get('sid'));

    let me = (await anna.get('/api/me')).data.user;
    assert.match(me.name, /^Spieler-\d{4}$/);
    assert.equal(me.email, 'anna@example.at');
    assert.equal(me.nameChosen, false);
    assert.deepEqual(me.logins, ['email']);
    assert.equal((await anna.post('/api/me', { name: 'A' })).status, 400);
    me = (await anna.post('/api/me', { name: 'Anna' })).data.user;
    assert.deepEqual([me.name, me.nameChosen], ['Anna', true]);

    const v = (await anna.get(`/api/run/${guestResult.id}`)).data;
    assert.equal(v.countsForBoard, true);
    assert.deepEqual(v.board, { rank: 1, of: 1 });
    const board = (await s.get('/api/board?quiz=testquiz/short')).data;
    assert.deepEqual(board.top.map((x) => [x.name, x.score, x.rank, x.isMe]), [['Anna', 3, 1, false]]);
    assert.equal(board.quiz.title, 'Testquiz');
  });

  await t.test('Link gilt nur einmal und nur 15 Minuten', async () => {
    const token = mailLink(s.output(), 'Anna@Example.at') || mailLink(s.output(), 'anna@example.at');
    const other = s.browser();
    assert.equal((await other.post('/auth/email/verify', { token })).status, 410);
    // Link per Datenbank altern lassen
    await other.post('/auth/email', { email: 'alt@example.at' });
    const old = await waitFor(() => mailLink(s.output(), 'alt@example.at'));
    const d = new DatabaseSync(path.join(s.dataDir, 'quiz.db'));
    d.prepare('UPDATE login_tokens SET expires_at = 0').run();
    d.close();
    assert.equal((await other.post('/auth/email/verify', { token: old })).status, 410);
    // Höchstens drei Links je Adresse in 15 Minuten
    await other.post('/auth/email', { email: 'alt@example.at' });
    await other.post('/auth/email', { email: 'alt@example.at' });
    assert.equal((await other.post('/auth/email', { email: 'alt@example.at' })).status, 429);
  });

  await t.test('Nur der erste Versuch zählt', async () => {
    const again = await play(anna, 'testquiz/short');
    assert.equal(again.countsForBoard, false);
    assert.equal(again.score, 4);
    assert.equal(again.board, undefined);
    assert.equal((await s.get('/api/board?quiz=testquiz/short')).data.top[0].score, 3);

    // Erster Versuch eines anderen Quiz, abgebrochen: Neustart führt zurück in denselben Durchgang
    const first = (await anna.post('/api/run/start', { quizId: 'zweites/mid' })).data;
    assert.equal(first.countsForBoard, true);
    const resumed = (await anna.post('/api/run/start', { quizId: 'zweites/mid' })).data;
    assert.equal(resumed.id, first.id);
  });

  const bert = s.browser();
  await t.test('Zweites Konto, Namen sind eindeutig, Rangliste', async () => {
    await login(s, bert, 'bert@example.at');
    assert.equal((await bert.post('/api/me', { name: 'anna' })).status, 409);
    await bert.post('/api/me', { name: 'Bert' });
    const v = await play(bert, 'testquiz/short');
    assert.deepEqual(v.board, { rank: 1, of: 2 });
    const board = (await bert.get('/api/board?quiz=testquiz/short')).data;
    assert.deepEqual(board.top.map((x) => [x.name, x.rank, x.isMe]), [['Bert', 1, true], ['Anna', 2, false]]);
    assert.equal(board.me.name, 'Bert');
    // Fremde Durchgänge bleiben verborgen, auch für Angemeldete
    assert.equal((await bert.get(`/api/run/${guestResult.id}`)).status, 404);
    assert.equal((await s.get('/api/board?quiz=gibts/short')).status, 404);
  });

  await t.test('Abmelden und Konto löschen', async () => {
    // Bereits gespielte Gast-Ergebnisse sind keine zweite Chance: nicht der erste Versuch
    const c = s.browser();
    await play(c, 'testquiz/short');
    const v = await play(c, 'testquiz/short');
    assert.equal(v.claimable, false);

    assert.equal((await bert.post('/auth/logout')).status, 200);
    assert.equal((await bert.get('/api/me')).data.user, null);
    assert.equal((await bert.post('/api/me', { name: 'X' })).status, 401);

    assert.equal((await anna.post('/api/me/delete')).status, 200);
    assert.equal((await anna.get('/api/me')).data.user, null);
    const board = (await s.get('/api/board?quiz=testquiz/short')).data;
    assert.deepEqual(board.top.map((x) => x.name), ['Bert']);
    // Neu anmelden mit derselben Adresse ergibt ein frisches Konto
    await login(s, anna, 'anna@example.at');
    assert.equal((await anna.get('/api/me')).data.user.nameChosen, false);
  });
});
