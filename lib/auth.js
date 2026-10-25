'use strict';

// Anmeldung für die Online-Modi: Link per E-Mail, Google oder Facebook.
// Ein Konto kann mehrere Anmeldewege haben (identities); dieselbe bestätigte
// E-Mail-Adresse führt immer zum selben Konto.

const crypto = require('crypto');
const db = require('./db');
const runs = require('./runs');
const cfg = require('./config');
const { send, redirect, safeNext, readBody, cleanName, baseUrl, cookies, setCookie, sameOrigin } = require('./http');
const { guestId, currentUser, startSession, endSession, newToken, hash } = require('./session');

const LINK_MINUTES = 15;
const FB_API = 'https://graph.facebook.com/v21.0';
const PROVIDERS = {
  google: !!(cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET),
  facebook: !!(cfg.FACEBOOK_APP_ID && cfg.FACEBOOK_APP_SECRET),
};

// ---------------------------------------------------------------- Konten

function uniqueDefaultName(d) {
  for (;;) {
    const name = `Spieler-${crypto.randomInt(1000, 10000)}`;
    if (!d.prepare('SELECT 1 FROM users WHERE name = ?').get(name)) return name;
  }
}

// Konto zu einem Anmeldeweg finden oder anlegen; email nur übergeben, wenn der Anbieter sie bestätigt hat
function findOrCreateUser({ provider, uid, email }, now = Date.now()) {
  const d = db.get();
  const known = d.prepare('SELECT user_id FROM identities WHERE provider = ? AND provider_uid = ?').get(provider, uid);
  if (known) return known.user_id;
  d.exec('BEGIN');
  try {
    let user = email && d.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (!user) {
      const id = d.prepare('INSERT INTO users (email, name, created_at) VALUES (?, ?, ?)').run(email || null, uniqueDefaultName(d), now).lastInsertRowid;
      user = { id: Number(id) };
    }
    d.prepare('INSERT INTO identities (provider, provider_uid, user_id) VALUES (?, ?, ?)').run(provider, uid, user.id);
    d.exec('COMMIT');
    return user.id;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

// Sitzung starten und das gerade gespielte Gast-Ergebnis übernehmen; liefert das Ziel nach der Anmeldung
function finishLogin(req, res, userId, next) {
  startSession(req, res, userId);
  const solo = /^\/solo\/([\w-]+)$/.exec(safeNext(next));
  runs.claimGuestRun(userId, guestId(req, res, false), solo && solo[1]);
  const chosen = db.get().prepare('SELECT name_chosen FROM users WHERE id = ?').get(userId).name_chosen;
  return chosen ? safeNext(next) : `/konto?neu=1&next=${encodeURIComponent(safeNext(next))}`;
}

// ---------------------------------------------------------------- E-Mail-Link

// Einfache Begrenzung im Speicher: höchstens max Versuche je Schlüssel und Zeitfenster
const buckets = new Map();
function limited(key, max, windowMs, now = Date.now()) {
  const b = buckets.get(key);
  if (!b || b.until < now) { buckets.set(key, { n: 1, until: now + windowMs }); return false; }
  b.n++;
  return b.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.until < now) buckets.delete(k); }, 600 * 1000).unref();

const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

let transport = null;
async function sendMail(to, subject, text) {
  if (!cfg.SMTP_URL) {
    console.log(`[Mail an ${to}] ${subject}\n${text}\n`);
    return;
  }
  transport = transport || require('nodemailer').createTransport(cfg.SMTP_URL);
  await transport.sendMail({ from: cfg.MAIL_FROM, to, subject, text });
}

function validEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return e.length <= 254 && /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/.test(e) ? e : null;
}

async function requestLink(req, res) {
  const body = await readBody(req);
  const email = validEmail(body.email);
  if (!email) return send(res, 400, { error: 'Bitte eine gültige E-Mail-Adresse eingeben.' });
  const now = Date.now();
  if (limited('mail:' + email, 3, 15 * 60 * 1000, now) || limited('ip:' + clientIp(req), 10, 15 * 60 * 1000, now) || limited('all', 300, 3600 * 1000, now)) {
    return send(res, 429, { error: 'Zu viele Versuche. Bitte in ein paar Minuten noch einmal.' });
  }
  const token = newToken(32);
  const d = db.get();
  d.prepare('DELETE FROM login_tokens WHERE expires_at < ?').run(now);
  d.prepare('INSERT INTO login_tokens (token_hash, email, next, expires_at) VALUES (?, ?, ?, ?)')
    .run(hash(token), email, safeNext(body.next), now + LINK_MINUTES * 60 * 1000);
  const link = `${baseUrl(req)}/login?token=${token}`;
  try {
    await sendMail(email, 'Dein Anmelde-Link für Quiz-Party',
      `Hallo!\n\nMit diesem Link meldest du dich bei Quiz-Party an:\n\n${link}\n\nDer Link gilt ${LINK_MINUTES} Minuten und nur einmal.\nWenn du das nicht warst, ignoriere diese E-Mail einfach.\n`);
  } catch (e) {
    console.error('E-Mail konnte nicht gesendet werden:', e.message);
    return send(res, 502, { error: 'Die E-Mail konnte nicht gesendet werden. Bitte später noch einmal.' });
  }
  send(res, 200, { ok: true, message: `Wir haben dir einen Link an ${email} geschickt. Er gilt ${LINK_MINUTES} Minuten.` });
}

// Der Link öffnet erst die Seite /login, die dann hier bestätigt. So verbrauchen
// Link-Vorschauen von Mailprogrammen (die nur GET machen) den Link nicht.
async function verifyLink(req, res) {
  const body = await readBody(req);
  const now = Date.now();
  const d = db.get();
  const row = d.prepare('SELECT * FROM login_tokens WHERE token_hash = ?').get(hash(body.token));
  if (!row || row.used_at || row.expires_at < now) {
    return send(res, 410, { error: 'Dieser Link ist abgelaufen oder wurde schon benutzt. Fordere einfach einen neuen an.' });
  }
  d.prepare('UPDATE login_tokens SET used_at = ? WHERE token_hash = ?').run(now, row.token_hash);
  const userId = findOrCreateUser({ provider: 'email', uid: row.email, email: row.email }, now);
  send(res, 200, { ok: true, next: finishLogin(req, res, userId, row.next) });
}

// ---------------------------------------------------------------- Google und Facebook

// Offene Anmeldungen: state → {provider, verifier, next}; dazu ein Cookie, das den state an diesen Browser bindet
const pending = new Map();
const OAUTH_MINUTES = 10;

const callbackUrl = (req, provider) => `${baseUrl(req)}/auth/${provider}/callback`;

function startOAuth(req, res, url, provider) {
  const state = newToken();
  const verifier = newToken(32);
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
  pending.set(state, { provider, verifier, next: safeNext(url.searchParams.get('next')), expires: now + OAUTH_MINUTES * 60 * 1000 });
  setCookie(req, res, 'ost', state, OAUTH_MINUTES * 60);
  const q = provider === 'google'
    ? {
        client_id: cfg.GOOGLE_CLIENT_ID, redirect_uri: callbackUrl(req, provider), response_type: 'code',
        scope: 'openid email profile', state, prompt: 'select_account',
        code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      }
    : { client_id: cfg.FACEBOOK_APP_ID, redirect_uri: callbackUrl(req, provider), response_type: 'code', scope: 'email,public_profile', state };
  const base = provider === 'google' ? 'https://accounts.google.com/o/oauth2/v2/auth' : 'https://www.facebook.com/v21.0/dialog/oauth';
  redirect(res, `${base}?${new URLSearchParams(q)}`);
}

async function getJson(url, init = {}) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error_description || (data.error && (data.error.message || data.error)) || `HTTP ${r.status}`);
  return data;
}

// Liefert {uid, email}; email nur, wenn der Anbieter sie bestätigt hat
async function profile(req, provider, code, verifier) {
  if (provider === 'google') {
    const tok = await getJson('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: cfg.GOOGLE_CLIENT_ID, client_secret: cfg.GOOGLE_CLIENT_SECRET,
        redirect_uri: callbackUrl(req, provider), grant_type: 'authorization_code', code_verifier: verifier,
      }),
    });
    const me = await getJson('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tok.access_token}` } });
    if (!me.sub) throw new Error('Google hat kein Konto geliefert.');
    return { uid: String(me.sub), email: me.email_verified ? validEmail(me.email) : null };
  }
  const tok = await getJson(`${FB_API}/oauth/access_token?${new URLSearchParams({
    client_id: cfg.FACEBOOK_APP_ID, client_secret: cfg.FACEBOOK_APP_SECRET, redirect_uri: callbackUrl(req, provider), code,
  })}`);
  const me = await getJson(`${FB_API}/me?${new URLSearchParams({ fields: 'id,email', access_token: tok.access_token })}`);
  if (!me.id) throw new Error('Facebook hat kein Konto geliefert.');
  // Facebook gibt nur bestätigte Adressen heraus; ohne Freigabe fehlt sie
  return { uid: String(me.id), email: validEmail(me.email) };
}

async function finishOAuth(req, res, url, provider) {
  const state = url.searchParams.get('state') || '';
  const p = pending.get(state);
  // Jeder state gilt genau einmal, auch wenn dieser Versuch scheitert
  pending.delete(state);
  const fail = (msg) => redirect(res, `/login?fehler=${encodeURIComponent(msg)}`);
  setCookie(req, res, 'ost', '', 0);
  if (!p || p.provider !== provider || p.expires < Date.now() || cookies(req).ost !== state) {
    return fail('Die Anmeldung ist abgelaufen. Bitte noch einmal versuchen.');
  }
  if (url.searchParams.get('error') || !url.searchParams.get('code')) return fail('Die Anmeldung wurde abgebrochen.');
  let who;
  try {
    who = await profile(req, provider, url.searchParams.get('code'), p.verifier);
  } catch (e) {
    console.error(`Anmeldung über ${provider} fehlgeschlagen:`, e.message);
    return fail('Die Anmeldung hat nicht geklappt. Bitte noch einmal versuchen.');
  }
  const userId = findOrCreateUser({ provider, uid: who.uid, email: who.email });
  redirect(res, finishLogin(req, res, userId, p.next));
}

// ---------------------------------------------------------------- Konto

function me(req) {
  const user = currentUser(req);
  const out = { providers: { email: true, ...PROVIDERS }, user: null };
  if (user) {
    const ids = db.get().prepare('SELECT provider FROM identities WHERE user_id = ? ORDER BY provider').all(user.id).map((r) => r.provider);
    out.user = { name: user.name, email: user.email, nameChosen: !!user.name_chosen, logins: ids };
  }
  return out;
}

async function rename(req, res, user) {
  const body = await readBody(req);
  const name = cleanName(body.name);
  if (name.length < 2) return send(res, 400, { error: 'Der Name braucht mindestens 2 Zeichen.' });
  const taken = db.get().prepare('SELECT id FROM users WHERE name = ? AND id != ?').get(name, user.id);
  if (taken) return send(res, 409, { error: 'Diesen Namen hat schon jemand. Bitte einen anderen wählen.' });
  db.get().prepare('UPDATE users SET name = ?, name_chosen = 1 WHERE id = ?').run(name, user.id);
  req.user = undefined;
  send(res, 200, me(req));
}

// Konto löschen: Anmeldewege und Sitzungen weg, Ergebnisse verlieren den Bezug und verschwinden aus der Bestenliste
function deleteAccount(req, res, user) {
  const d = db.get();
  d.exec('BEGIN');
  try {
    d.prepare('UPDATE runs SET user_id = NULL, guest_id = NULL, counts_for_board = 0 WHERE user_id = ?').run(user.id);
    d.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  setCookie(req, res, 'sid', '', 0);
  req.user = null;
  send(res, 200, { ok: true });
}

// ---------------------------------------------------------------- HTTP

async function handle(req, res, url) {
  const p = url.pathname;
  const m = /^\/auth\/(google|facebook)(\/callback)?$/.exec(p);
  if (req.method === 'GET' && m) {
    if (!PROVIDERS[m[1]]) return send(res, 404, { error: 'Diese Anmeldung ist hier nicht eingerichtet.' });
    return m[2] ? finishOAuth(req, res, url, m[1]) : startOAuth(req, res, url, m[1]);
  }

  if (req.method === 'GET' && p === '/api/me') return send(res, 200, me(req));

  if (req.method !== 'POST' || !(p.startsWith('/auth/') || p.startsWith('/api/me'))) return;
  if (!sameOrigin(req)) return send(res, 403, { error: 'Anfrage von fremder Seite.' });

  if (p === '/auth/email') return requestLink(req, res);
  if (p === '/auth/email/verify') return verifyLink(req, res);
  if (p === '/auth/logout') { endSession(req, res); return send(res, 200, { ok: true }); }

  const user = currentUser(req);
  if (p === '/api/me' || p === '/api/me/delete') {
    if (!user) return send(res, 401, { error: 'Bitte zuerst anmelden.' });
    return p === '/api/me' ? rename(req, res, user) : deleteAccount(req, res, user);
  }
}

module.exports = { handle, findOrCreateUser, PROVIDERS };
