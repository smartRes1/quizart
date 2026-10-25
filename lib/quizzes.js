'use strict';

// Fragen-Pool: data/quizzes/<thema>/<short|mid|long>.json laden, prüfen und auflisten

const fs = require('fs');
const path = require('path');
const { QUIZ_DIR } = require('./config');

const LETTERS = ['A', 'B', 'C', 'D'];
const DURATIONS = { short: 'Kurz', mid: 'Mittel', long: 'Lang' };
// Erlaubte Spieldauer in Minuten je Länge
const DURATION_FITS = { short: (m) => m >= 2 && m <= 6, mid: (m) => m >= 7 && m <= 15, long: (m) => m > 15 };
// Schätzung pro Frage: Fragezeit + Auflösung/Funfact, pro Runde: Intro + Zwischenergebnis
const REVEAL_SECONDS = 20;
const ROUND_SECONDS = 45;

function loadQuestions(file) {
  const raw = fs.readFileSync(file, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${path.relative(QUIZ_DIR, file)} ist kein gültiges JSON: ${e.message}`);
  }
  const errors = [];
  if (!Array.isArray(data.rounds) || data.rounds.length === 0) errors.push('Es gibt keine "rounds".');
  (data.rounds || []).forEach((r, ri) => {
    const where = `Runde ${ri + 1}`;
    if (!r.name) errors.push(`${where}: "name" fehlt.`);
    if (!Array.isArray(r.questions) || r.questions.length === 0) errors.push(`${where}: keine Fragen.`);
    (r.questions || []).forEach((q, qi) => {
      const w = `${where}, Frage ${qi + 1}`;
      if (!q.q) errors.push(`${w}: Fragetext "q" fehlt.`);
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) {
        errors.push(`${w}: "options" braucht 2 bis 4 Antworten.`);
      } else {
        const idx = LETTERS.indexOf(String(q.correct || '').trim().toUpperCase());
        if (idx < 0 || idx >= q.options.length) errors.push(`${w}: "correct" muss einer der Buchstaben ${LETTERS.slice(0, q.options.length).join('/')} sein.`);
      }
    });
  });
  if (errors.length) throw new Error(errors.join('\n'));
  const settings = Object.assign({ secondsPerQuestion: 25, pointsPerCorrect: 1 }, data.settings || {});
  return {
    title: data.title || 'Quiz',
    settings,
    rounds: data.rounds.map((r) => ({
      name: r.name,
      subtitle: r.subtitle || '',
      questions: r.questions.map((q) => ({
        q: q.q,
        options: q.options.map(String),
        correct: LETTERS.indexOf(String(q.correct).trim().toUpperCase()),
        fact: q.fact || '',
        points: Number.isFinite(q.points) ? q.points : settings.pointsPerCorrect,
        seconds: Number.isFinite(q.seconds) ? q.seconds : settings.secondsPerQuestion,
      })),
    })),
  };
}

const questionCount = (qz) => qz.rounds.reduce((s, r) => s + r.questions.length, 0);

function estimateMinutes(qz) {
  const secs = qz.rounds.reduce((s, r) => s + ROUND_SECONDS + r.questions.reduce((t, q) => t + q.seconds + REVEAL_SECONDS, 0), 0);
  return Math.round(secs / 60);
}

// Alle Quizze im Pool, auch fehlerhafte (mit `error`), damit das Menü zeigt, was nicht passt
function listQuizzes() {
  let topics = [];
  try {
    topics = fs.readdirSync(QUIZ_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^[\w-]+$/.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch {}
  const list = [];
  for (const topic of topics) {
    for (const duration of Object.keys(DURATIONS)) {
      const file = path.join(QUIZ_DIR, topic, `${duration}.json`);
      if (!fs.existsSync(file)) continue;
      const item = { id: `${topic}/${duration}`, topic, duration, durationLabel: DURATIONS[duration] };
      try {
        const qz = loadQuestions(file);
        Object.assign(item, { title: qz.title, rounds: qz.rounds.length, questions: questionCount(qz), minutes: estimateMinutes(qz) });
      } catch (e) {
        item.error = e.message;
      }
      list.push(item);
    }
  }
  return list;
}

function loadQuiz(id) {
  const m = /^([\w-]+)\/(short|mid|long)$/.exec(String(id || ''));
  const file = m && path.join(QUIZ_DIR, m[1], `${m[2]}.json`);
  if (!file || !fs.existsSync(file)) throw new Error(`Quiz „${id}“ gibt es nicht.`);
  return { ...loadQuestions(file), id };
}

function defaultQuizId() {
  const first = listQuizzes().find((q) => !q.error);
  if (!first) throw new Error(`Kein gültiges Quiz in ${QUIZ_DIR} gefunden (erwartet: <thema>/short.json, mid.json oder long.json).`);
  return first.id;
}

// npm run check: Pool prüfen und ausgeben; liefert den Exit-Code
function checkPool() {
  const list = listQuizzes();
  if (!list.length) console.log(`Keine Quizze in ${QUIZ_DIR} gefunden.`);
  for (const q of list) {
    if (q.error) { console.log(`✗ ${q.id}\n  ${q.error.replace(/\n/g, '\n  ')}`); continue; }
    const fit = DURATION_FITS[q.duration](q.minutes) ? '' : `  ⚠ passt nicht zu „${q.durationLabel}“`;
    console.log(`✓ ${q.id}: ${q.rounds} Runde(n), ${q.questions} Fragen, ca. ${q.minutes} Min${fit}`);
  }
  return list.length && list.every((q) => !q.error) ? 0 : 1;
}

module.exports = { LETTERS, DURATIONS, loadQuestions, questionCount, estimateMinutes, listQuizzes, loadQuiz, defaultQuizId, checkPool };
