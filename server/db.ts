import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.VERCEL
  ? path.join('/tmp', 'kie-studio-data')
  : path.resolve(process.cwd(), '.data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

const DB_PATH = path.join(DATA_DIR, 'kie-studio-catalog.db');
export const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');

// Only public non-secret catalog & OpenAPI spec cache is persisted server-side.
// User API keys, balances, and generation/chat histories are NEVER stored on the server.
db.exec(`
  CREATE TABLE IF NOT EXISTS catalog_cache (
    id TEXT PRIMARY KEY,
    synced_at INTEGER NOT NULL,
    model_paths_json TEXT NOT NULL,
    pricing_rows_json TEXT NOT NULL,
    doc_entries_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS model_specs (
    doc_url TEXT PRIMARY KEY,
    model_id TEXT,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    spec_json TEXT NOT NULL,
    synced_at INTEGER NOT NULL
  );
`);
