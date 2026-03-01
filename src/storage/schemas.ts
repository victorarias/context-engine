export const STORAGE_SCHEMA_VERSION = 1;

export const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS blobs (
    blob_hash TEXT PRIMARY KEY,
    chunk_ids TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS tree_entries (
    repo_id TEXT NOT NULL,
    worktree_id TEXT NOT NULL,
    path TEXT NOT NULL,
    blob_hash TEXT NOT NULL,
    PRIMARY KEY (worktree_id, path)
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_tree_entries_repo_id
  ON tree_entries(repo_id);
  `,
  `
  CREATE TABLE IF NOT EXISTS dirty_files (
    worktree_id TEXT NOT NULL,
    path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    chunk_ids TEXT NOT NULL,
    PRIMARY KEY (worktree_id, path)
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS symbols (
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    file_path TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    chunk_id TEXT NOT NULL,
    repo_id TEXT NOT NULL,
    PRIMARY KEY (name, file_path, start_line)
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_symbols_file_path ON symbols(file_path);
  `,
  `
  CREATE TABLE IF NOT EXISTS docs_chunks (
    url TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (url, chunk_index)
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_docs_chunks_url ON docs_chunks(url);
  `,
  `
  CREATE TABLE IF NOT EXISTS index_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS write_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation TEXT NOT NULL,
    chunk_ids TEXT NOT NULL,
    lance_ok INTEGER NOT NULL DEFAULT 0,
    sqlite_ok INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_write_log_pending
  ON write_log(lance_ok, sqlite_ok);
  `,
];

export const PRAGMAS: string[] = [
  "PRAGMA journal_mode = WAL;",
  "PRAGMA synchronous = NORMAL;",
  "PRAGMA foreign_keys = ON;",
  "PRAGMA temp_store = MEMORY;",
];
