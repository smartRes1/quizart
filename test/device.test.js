'use strict';

// Anmeldung nur mit Namen, weiteres Gerät per QR-Code, Moderator per PIN

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, nameLogin, play } = require('./helpers');

test('Anmeldung mit Namen und per QR-Code', async (t) => {
  // Ohne SMTP_URL und MAIL_LOG gibt es keine E-Mail-Anmeldung; ohne HOST_PIN eine zufällige PIN
  const s = await startServer({ env: { MAIL_LOG: '', HOST_PIN: '' } });
  t.after(() => s.stop());

  await t.test('E-Mail ist ausgeschaltet', async () => {
    assert.deepEqual((await s.get('/api/me')).data.providers, { name: true, email: false, google: false, facebook: false });
    assert.equal((await s.post('/auth/email', { email: 'a@example.at' })).status, 404);
  });

  const anna = s.browser();
  await t.test('Konto nur mit Namen, Gast-Ergebnis wird übernommen', async () => {
    const guest = await play(anna, { quizId: 'testquiz/short' });
    assert.equal((await anna.post('/auth/name', { name: 'A' })).status, 400);
    const r = await nameLogin(anna, 'Anna', `/solo/${guest.id}`);
    assert.equal(r.data.next, `/solo/${guest.id}`);
    // Ohne anderen Anmeldeweg gilt die Sitzung ein Jahr
    assert.match(r.headers.get('set-cookie'), /sid=[\w-]+;.*Max-Age=31536000/);
    const me = (await anna.get('/api/me')).data.user;
    assert.deepEqual([me.name, me.nameChosen, me.email, me.logins], ['Anna', true, null, []]);
    assert.equal((await anna.get(`/api/run/${guest.id}`)).data.countsForBoard, true);
    assert.equal((await s.browser().post('/auth/name', { name: 'anna' })).status, 409);
  });

  await t.test('Weiteres Gerät per QR-Code, nur einmal', async () => {
    assert.equal((await s.post('/api/me/link')).status, 401);
    const link = (await anna.post('/api/me/link')).data;
    assert.match(link.svg, /^<svg/);
    const token = /\/login\?geraet=([\w-]+)$/.exec(link.url)[1];
    assert.equal((await s.get(`/login?geraet=${token}`)).status, 200);
    const phone = s.browser();
    const r = await phone.post('/auth/device', { token });
    assert.equal(r.status, 200);
    assert.equal((await phone.get('/api/me')).data.user.name, 'Anna');
    assert.equal((await s.browser().post('/auth/device', { token })).status, 410);
    // Ein neuer Code macht den alten ungültig
    const old = /geraet=([\w-]+)$/.exec((await anna.post('/api/me/link')).data.url)[1];
    await anna.post('/api/me/link');
    assert.equal((await s.browser().post('/auth/device', { token: old })).status, 410);
  });

  await t.test('Moderator per PIN', async () => {
    const pin = fs.readFileSync(path.join(s.dataDir, 'host-pin'), 'utf8').trim();
    assert.match(pin, /^\d{6}$/);
    assert.ok(s.output().includes(`Moderator-PIN (nicht weitergeben): ${pin}`));
    // Direkt am Beamer mit PIN im Header
    assert.equal((await s.get('/api/host/state', { 'X-Host-PIN': pin })).status, 200);
    // Konto ohne Rechte: keine Moderation
    assert.equal((await anna.get('/api/host/state')).status, 403);
    assert.equal((await s.post('/api/me/host', { pin })).status, 401);
    assert.equal((await anna.post('/api/me/host', { pin: '000000' === pin ? '111111' : '000000' })).status, 403);
    const me = (await anna.post('/api/me/host', { pin })).data.user;
    assert.equal(me.isHost, true);
    // Als Moderator angemeldet geht es ohne PIN, auch auf dem zweiten Gerät desselben Kontos
    assert.equal((await anna.get('/api/host/state')).status, 200);
    assert.equal((await anna.get('/api/host/qr.svg')).status, 200);
    assert.equal((await anna.post('/api/me/host', { off: true })).data.user.isHost, false);
    assert.equal((await anna.get('/api/host/state')).status, 403);
  });

  await t.test('Zu viele falsche PINs sperren', async () => {
    let last;
    for (let i = 0; i < 12; i++) last = await s.get('/api/host/state', { 'X-Host-PIN': 'x' + i });
    assert.equal(last.status, 429);
    const pin = fs.readFileSync(path.join(s.dataDir, 'host-pin'), 'utf8').trim();
    // Gesperrt ist gesperrt, auch mit der richtigen PIN
    assert.equal((await anna.post('/api/me/host', { pin })).status, 429);
  });
});
