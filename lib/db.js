'use strict';

// SQLite-Datenbank für die Online-Modi (Konten, Ergebnisse, Battles).
// Party braucht sie nicht: Die Datei wird erst beim ersten Zugriff angelegt.

const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { DATA_DIR } = require('./config');

// Jede Migration läuft genau einmal, in dieser Reihenfolge; nie nachträglich ändern, nur anhängen
const MIGRATIONS = [];

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
