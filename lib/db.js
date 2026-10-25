'use strict';

// SQLite-Datenbank für die Online-Modi (Konten, Ergebnisse, Battles).
// Party braucht sie nicht: Die Datei wird erst beim ersten Zugriff angelegt.

const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { DATA_DIR } = require('./config');

// Jede Migration läuft genau einmal, in dieser Reihenfolge; nie nachträglich ändern, nur anhängen
const MIGRATIONS = [
  // 1: Durchgänge für Solo (später auch Battle); state enthält die gemischten Fragen und Antworten
  `CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    quiz_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    user_id INTEGER,
    guest_id TEXT,
    battle_id INTEGER,
    counts_for_board INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0,
    ms INTEGER NOT NULL DEFAULT 0,
    correct INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX runs_board ON runs (quiz_id, counts_for_board, finished_at);
  CREATE INDEX runs_user ON runs (user_id, quiz_id);
  CREATE INDEX runs_guest ON runs (guest_id, started_at);`,
];

function migrate(db, migrations) {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  const from = row ? Number(row.value) : 0;
  if (from > migrations.length) throw new Error(`Datenbank hat Version ${from}, dieser Server kennt nur ${migrations.length}.`);
  for (let v = from; v < migrations.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(migrations[v]);
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(v + 1));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${v + 1} fehlgeschlagen: ${e.message}`);
    }
  }
}

function open(file, migrations = MIGRATIONS) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  migrate(db, migrations);
  return db;
}

let shared = null;
const get = () => (shared = shared || open(path.join(DATA_DIR, 'quiz.db')));

function close() {
  if (shared) shared.close();
  shared = null;
}

module.exports = { open, migrate, get, close };
