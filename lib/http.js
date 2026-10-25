'use strict';

// Kleine HTTP-Helfer ohne Framework

const { PUBLIC_URL } = require('./config');

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(data);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.end();
}

// Nur Ziele auf dieser Seite, damit Anmelde-Links nicht auf fremde Seiten umleiten
function safeNext(next) {
  const n = String(next || '');
  return /^\/(?![\/\\])[\w\-\/?=&.%]*$/.test(n) ? n : '/';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 16 * 1024) { reject(new Error('zu groß')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('ungültiges JSON')); }
    });
    req.on('error', reject);
  });
}

function cleanName(name) {
  return String(name || '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
}

// Adresse, unter der der Server von außen erreichbar ist (für QR-Codes und Links)
function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Hängt ein Cookie an die Antwort; Secure, sobald der Server über https erreichbar ist
function setCookie(req, res, name, value, maxAgeSeconds) {
  const attrs = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (baseUrl(req).startsWith('https:')) attrs.push('Secure');
  const prev = res.getHeader('Set-Cookie') || [];
  res.setHeader('Set-Cookie', [...prev, attrs.join('; ')]);
}

// POSTs mit Cookie-Anmeldung nur von der eigenen Seite (Schutz gegen fremde Formulare)
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === (req.headers['x-forwarded-host'] || req.headers.host); } catch { return false; }
}

module.exports = { send, redirect, safeNext, readBody, cleanName, baseUrl, cookies, setCookie, sameOrigin };
