// scout — the read-through cache. Every fetched page is stored as markdown so
// re-reads are free and your whole reading history is searchable (FTS5).
// node:sqlite, zero external dependencies.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.SCOUT_DB || './.scout/cache.db';
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS pages (
  url          TEXT PRIMARY KEY,
  final_url    TEXT,
  title        TEXT,
  description  TEXT,
  markdown     TEXT,
  content_type TEXT,
  status       INTEGER,
  html_bytes   INTEGER,
  md_bytes     INTEGER,
  fetched_at   TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  url UNINDEXED, title, markdown, tokenize = 'porter unicode61'
);
`);

export const get = (sql, ...a) => db.prepare(sql).get(...a);
export const all = (sql, ...a) => db.prepare(sql).all(...a);
export const run = (sql, ...a) => db.prepare(sql).run(...a);
export { DB_PATH };
