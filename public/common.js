// Gemeinsame Helfer der Online-Seiten (Solo, später Battle, Match)
'use strict';

const LETTERS = ['A', 'B', 'C', 'D'];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// localStorage kann gesperrt sein (privater Modus, Einstellungen)
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// Wirft nur bei fehlender Verbindung; HTTP-Fehler kommen als ok: false zurück
async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const seconds = (ms) => (ms / 1000).toLocaleString('de-AT', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' s';

// Zeitbalken einer Frage; läuft bis zur Serverzeit-Frist (deadline in lokaler Uhrzeit)
function runTimer(bar, deadline, durationMs) {
  const step = () => {
    if (!bar.isConnected) return;
    const left = Math.max(0, deadline - Date.now());
    bar.style.width = (100 * left / durationMs) + '%';
    if (left > 0) requestAnimationFrame(step);
  };
  step();
}
