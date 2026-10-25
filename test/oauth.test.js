'use strict';

// Google- und Facebook-Anmeldung im selben Prozess; die Antworten der Anbieter werden vorgetäuscht

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { FIXTURE_QUIZZES } = require('./helpers');

Object.assign(process.env, {
  QUIZ_DIR: FIXTURE_QUIZZES,
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'quizart-oauth-')),
  PUBLIC_URL: '',
  GOOGLE_CLIENT_ID: 'gid-123', GOOGLE_CLIENT_SECRET: 'gsecret',
  FACEBOOK_APP_ID: 'fb-456', FACEBOOK_APP_SECRET: 'fsecret',
});
const auth = require('../lib/auth');
const { send } = require('../lib/http');

// Vorgetäuschte Anbieter: Code → Profil
const PROFILES = {
  'g-code-1': { sub: 'g-111', email: 'clara@example.at', email_verified: true },
  'g-code-2': { sub: 'g-222', email: 'dora@example.at', email_verified: false },
  'f-code-1': { id: 'f-333', email: 'clara@example.at' },
};
const seen = [];
const realFetch = global.fetch;
global.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  if (u.host === 'oauth2.googleapis.com') {
    const body = new URLSearchParams(init.body);
    seen.push({ google: Object.fromEntries(body) });
    return PROFILES[body.get('code')] ? json(200, { access_token: 'gtok:' + body.get('code') }) : json(400, { error: 'invalid_grant' });
  }
  if (u.host === 'openidconnect.googleapis.com') return json(200, PROFILES[init.headers.Authorization.split(':')[1]]);
  if (u.host === 'graph.facebook.com' && u.pathname.endsWith('/oauth/access_token')) {
    seen.push({ facebook: Object.fromEntries(u.searchParams) });
    return json(200, { access_token: 'ftok:' + u.searchParams.get('code') });
  }
  if (u.host === 'graph.facebook.com' && u.pathname.endsWith('/me')) return json(200, PROFILES[u.searchParams.get('access_token').split(':')[1]]);
  return realFetch(url, init);
};

test('Anmeldung über Google und Facebook', async (t) => {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    await auth.handle(req, res, url);
    if (!res.writableEnded) send(res, 404, {});
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  const cookiesOf = (r) => Object.fromEntries(r.headers.getSetCookie().map((c) => c.split(';')[0].split('=')));
  const go = (p, cookie) => realFetch(base + p, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });

  // Kompletter Ablauf: Weiterleitung zum Anbieter, zurück mit Code, Sitzung
  async function signIn(provider, code, next = '/solo') {
    const start = await go(`/auth/${provider}?next=${encodeURIComponent(next)}`);
    assert.equal(start.status, 302);
    const to = new URL(start.headers.get('location'));
    const ost = cookiesOf(start).ost;
    assert.equal(to.searchParams.get('state'), ost);
    assert.equal(to.searchParams.get('redirect_uri'), `${base}/auth/${provider}/callback`);
    const back = await go(`/auth/${provider}/callback?code=${code}&state=${ost}`, `ost=${ost}`);
    return { to, back, sid: cookiesOf(back).sid };
  }
  const me = async (sid) => (await (await go('/api/me', `sid=${sid}`)).json()).user;

  await t.test('Google mit PKCE', async () => {
    const { to, back, sid } = await signIn('google', 'g-code-1');
    assert.equal(to.host, 'accounts.google.com');
    assert.equal(to.searchParams.get('client_id'), 'gid-123');
    assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
    const verifier = seen.at(-1).google.code_verifier;
    assert.equal(require('crypto').createHash('sha256').update(verifier).digest('base64url'), to.searchParams.get('code_challenge'));
    assert.equal(back.status, 302);
    assert.equal(back.headers.get('location'), '/konto?neu=1&next=%2Fsolo');
    const u = await me(sid);
    assert.deepEqual([u.email, u.logins], ['clara@example.at', ['google']]);
  });

  await t.test('Facebook mit derselben E-Mail landet im selben Konto', async () => {
    const { to, sid } = await signIn('facebook', 'f-code-1');
    assert.equal(to.host, 'www.facebook.com');
    assert.equal(seen.at(-1).facebook.client_secret, 'fsecret');
    assert.deepEqual((await me(sid)).logins, ['facebook', 'google']);
  });

  await t.test('Unbestätigte E-Mail wird nicht übernommen', async () => {
    const u = await me((await signIn('google', 'g-code-2')).sid);
    assert.equal(u.email, null);
  });

  await t.test('Falscher state, fehlendes Cookie, Abbruch, Fehler beim Anbieter', async () => {
    const start = await go('/auth/google');
    const ost = cookiesOf(start).ost;
    let r = await go(`/auth/google/callback?code=g-code-1&state=${ost}`);
    assert.match(r.headers.get('location'), /^\/login\?fehler=/);
    assert.equal(cookiesOf(r).sid, undefined);
    // Ein state gilt nur einmal, auch wenn der erste Versuch scheiterte
    r = await go(`/auth/google/callback?code=g-code-1&state=${ost}`, `ost=${ost}`);
    assert.match(decodeURIComponent(r.headers.get('location')), /abgelaufen/);

    const s2 = cookiesOf(await go('/auth/google')).ost;
    r = await go(`/auth/google/callback?error=access_denied&state=${s2}`, `ost=${s2}`);
    assert.match(decodeURIComponent(r.headers.get('location')), /abgebrochen/);

    const s3 = cookiesOf(await go('/auth/google')).ost;
    r = await go(`/auth/google/callback?code=falsch&state=${s3}`, `ost=${s3}`);
    assert.match(decodeURIComponent(r.headers.get('location')), /nicht geklappt/);

    // Ziel außerhalb der Seite wird verworfen
    const evil = await go('/auth/google?next=' + encodeURIComponent('https://boese.example'));
    const s4 = cookiesOf(evil).ost;
    r = await go(`/auth/google/callback?code=g-code-1&state=${s4}`, `ost=${s4}`);
    assert.equal(r.headers.get('location'), '/konto?neu=1&next=%2F');
  });
});
