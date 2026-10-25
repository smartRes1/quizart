'use strict';

// Startet server.js als eigenen Prozess mit leerem Datenordner und den Test-Quizzen.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FIXTURE_QUIZZES = path.join(__dirname, 'fixtures', 'quizzes');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startServer({ dataDir, env = {} } = {}) {
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'quizart-test-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, QUIZ_DIR: FIXTURE_QUIZZES, HOST_PIN: '4711', PUBLIC_URL: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Nach kill() ist exitCode null und nur signalCode gesetzt
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (exited()) throw new Error(`Server beendet:\n${output}`);
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) break;
    } catch {}
    await sleep(50);
  }

  async function request(method, p, body, headers = {}) {
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch {}
    return { status: res.status, data, headers: res.headers };
  }

  return {
    base,
    dataDir: dir,
    output: () => output,
    get: (p, headers) => request('GET', p, undefined, headers),
    post: (p, body = {}, headers) => request('POST', p, body, headers),
    host: {
      get: (action) => request('GET', `/api/host/${action}`, undefined, { 'X-Host-Pin': '4711' }),
      post: (action, body = {}) => request('POST', `/api/host/${action}`, body, { 'X-Host-Pin': '4711' }),
    },
    async stop() {
      if (exited()) return;
      const done = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await done;
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Wartet, bis fn() einen truthy Wert liefert
async function waitFor(fn, { timeout = 3000, interval = 50 } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor: Zeitüberschreitung');
    await sleep(interval);
  }
}

module.exports = { startServer, sleep, waitFor, FIXTURE_QUIZZES };
