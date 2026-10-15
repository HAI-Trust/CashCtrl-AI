const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'cashctrl-ai.db');
const LEGACY_DB_PATH = path.join(DATA_DIR, 'hai-cashctrl.db');

let db;

function adoptLegacyDatabase() {
  if (fs.existsSync(DB_PATH) || !fs.existsSync(LEGACY_DB_PATH)) return;
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${LEGACY_DB_PATH}${suffix}`;
    if (!fs.existsSync(from)) continue;
    fs.renameSync(from, `${DB_PATH}${suffix}`);
  }
}

function initDb() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  adoptLegacyDatabase();

  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS review_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      journal_id INTEGER,
      period_start TEXT,
      period_end TEXT,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT,
      message TEXT NOT NULL,
      suggestion TEXT,
      entry_json TEXT,
      correction_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      cashctrl_journal_id INTEGER,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT,
      size INTEGER,
      extracted_json TEXT,
      logic TEXT,
      suggestion_json TEXT,
      status TEXT NOT NULL DEFAULT 'uploaded',
      cashctrl_file_id INTEGER,
      cashctrl_journal_id INTEGER,
      error_message TEXT,
      created_at TEXT NOT NULL,
      booked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS booking_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_norm TEXT,
      title TEXT,
      amount REAL,
      debit_id INTEGER,
      credit_id INTEGER,
      tax_id INTEGER,
      created_at TEXT NOT NULL
    );
  `);

  return db;
}

function getDb() {
  if (!db) {
    initDb();
  }
  return db;
}

function getSetting(key, fallback = null) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value == null ? null : String(value));
}

function getAllSettings() {
  const rows = getDb().prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function transaction(fn) {
  const database = getDb();
  database.exec('BEGIN');
  try {
    const result = fn();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function lastId(result) {
  return Number(result.lastInsertRowid);
}

module.exports = {
  DATA_DIR,
  DB_PATH,
  initDb,
  getDb,
  getSetting,
  setSetting,
  getAllSettings,
  transaction,
  lastId,
};
