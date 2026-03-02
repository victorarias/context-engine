import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { MetadataStore, SymbolInfo, SymbolKind } from "../types.js";
import { MIGRATIONS, PRAGMAS, STORAGE_SCHEMA_VERSION } from "./schemas.js";

export interface SQLiteMetadataStoreOptions {
  path: string;
}

export class SQLiteMetadataStore implements MetadataStore {
  private readonly db: Database;

  constructor(options: SQLiteMetadataStoreOptions) {
    mkdirSync(dirname(options.path), { recursive: true });
    this.db = new Database(options.path, { create: true, strict: true });

    for (const pragma of PRAGMAS) {
      this.db.exec(pragma);
    }

    for (const migration of MIGRATIONS) {
      this.db.exec(migration);
    }

    this.db
      .query("INSERT OR IGNORE INTO schema_migrations(version) VALUES (?)")
      .run(STORAGE_SCHEMA_VERSION);
  }

  // Blob operations
  async getBlob(blobHash: string): Promise<{ chunkIds: string[] } | null> {
    const row = this.db
      .query("SELECT chunk_ids FROM blobs WHERE blob_hash = ?")
      .get(blobHash) as { chunk_ids: string } | null;

    if (!row) return null;
    return { chunkIds: JSON.parse(row.chunk_ids) };
  }

  async upsertBlob(blobHash: string, chunkIds: string[]): Promise<void> {
    this.db
      .query(
        `INSERT INTO blobs(blob_hash, chunk_ids)
         VALUES (?, ?)
         ON CONFLICT(blob_hash) DO UPDATE SET chunk_ids = excluded.chunk_ids`,
      )
      .run(blobHash, JSON.stringify(chunkIds));
  }

  async deleteBlob(blobHash: string): Promise<void> {
    this.db.query("DELETE FROM blobs WHERE blob_hash = ?").run(blobHash);
  }

  async countBlobReferences(blobHash: string): Promise<number> {
    const treeCountRow = this.db
      .query("SELECT COUNT(*) AS count FROM tree_entries WHERE blob_hash = ?")
      .get(blobHash) as { count: number };

    const dirtyCountRow = this.db
      .query("SELECT COUNT(*) AS count FROM dirty_files WHERE content_hash = ?")
      .get(blobHash) as { count: number };

    return treeCountRow.count + dirtyCountRow.count;
  }

  // Tree entry operations
  async getTreeEntries(worktreeId: string): Promise<Array<{ path: string; blobHash: string }>> {
    const rows = this.db
      .query("SELECT path, blob_hash FROM tree_entries WHERE worktree_id = ? ORDER BY path")
      .all(worktreeId) as Array<{ path: string; blob_hash: string }>;

    return rows.map((row) => ({ path: row.path, blobHash: row.blob_hash }));
  }

  async upsertTreeEntry(repoId: string, worktreeId: string, path: string, blobHash: string): Promise<void> {
    this.db
      .query(
        `INSERT INTO tree_entries(repo_id, worktree_id, path, blob_hash)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(worktree_id, path) DO UPDATE SET
           repo_id = excluded.repo_id,
           blob_hash = excluded.blob_hash`,
      )
      .run(repoId, worktreeId, path, blobHash);
  }

  async deleteTreeEntry(worktreeId: string, path: string): Promise<void> {
    this.db.query("DELETE FROM tree_entries WHERE worktree_id = ? AND path = ?").run(worktreeId, path);
  }

  async clearTreeEntries(worktreeId: string): Promise<void> {
    this.db.query("DELETE FROM tree_entries WHERE worktree_id = ?").run(worktreeId);
  }

  // Dirty file operations
  async getDirtyFiles(worktreeId: string): Promise<Array<{ path: string; contentHash: string; chunkIds: string[] }>> {
    const rows = this.db
      .query("SELECT path, content_hash, chunk_ids FROM dirty_files WHERE worktree_id = ? ORDER BY path")
      .all(worktreeId) as Array<{ path: string; content_hash: string; chunk_ids: string }>;

    return rows.map((row) => ({
      path: row.path,
      contentHash: row.content_hash,
      chunkIds: JSON.parse(row.chunk_ids),
    }));
  }

  async upsertDirtyFile(worktreeId: string, path: string, contentHash: string, chunkIds: string[]): Promise<void> {
    this.db
      .query(
        `INSERT INTO dirty_files(worktree_id, path, content_hash, chunk_ids)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(worktree_id, path) DO UPDATE SET
           content_hash = excluded.content_hash,
           chunk_ids = excluded.chunk_ids`,
      )
      .run(worktreeId, path, contentHash, JSON.stringify(chunkIds));
  }

  async deleteDirtyFile(worktreeId: string, path: string): Promise<void> {
    this.db.query("DELETE FROM dirty_files WHERE worktree_id = ? AND path = ?").run(worktreeId, path);
  }

  async clearDirtyFiles(worktreeId: string): Promise<void> {
    this.db.query("DELETE FROM dirty_files WHERE worktree_id = ?").run(worktreeId);
  }

  async getKnownWorktreeIds(): Promise<string[]> {
    const rows = this.db
      .query(
        `SELECT DISTINCT worktree_id AS id FROM tree_entries
         UNION
         SELECT DISTINCT worktree_id AS id FROM dirty_files
         ORDER BY id`,
      )
      .all() as Array<{ id: string }>;

    return rows.map((row) => row.id).filter(Boolean);
  }

  // Documentation operations
  async upsertDocChunks(url: string, title: string, chunks: string[]): Promise<void> {
    const deleteStmt = this.db.query("DELETE FROM docs_chunks WHERE url = ?");
    const insertStmt = this.db.query(
      `INSERT INTO docs_chunks(url, chunk_index, title, content)
       VALUES (?, ?, ?, ?)`,
    );

    const tx = this.db.transaction((entries: string[]) => {
      deleteStmt.run(url);
      for (let i = 0; i < entries.length; i++) {
        insertStmt.run(url, i, title, entries[i]);
      }
    });

    tx(chunks);
  }

  async deleteDocChunks(url: string): Promise<void> {
    this.db.query("DELETE FROM docs_chunks WHERE url = ?").run(url);
  }

  async searchDocChunks(
    query: string,
    limit: number,
  ): Promise<Array<{ url: string; title: string; content: string; chunkIndex: number }>> {
    const normalized = `%${query.toLowerCase()}%`;

    const rows = this.db
      .query(
        `SELECT url, title, content, chunk_index
         FROM docs_chunks
         WHERE LOWER(content) LIKE ? OR LOWER(title) LIKE ? OR LOWER(url) LIKE ?
         ORDER BY updated_at DESC, url ASC, chunk_index ASC
         LIMIT ?`,
      )
      .all(normalized, normalized, normalized, Math.max(1, limit)) as Array<{
      url: string;
      title: string;
      content: string;
      chunk_index: number;
    }>;

    return rows.map((row) => ({
      url: row.url,
      title: row.title,
      content: row.content,
      chunkIndex: row.chunk_index,
    }));
  }

  // Symbol operations
  async getSymbols(query: {
    name?: string;
    filePath?: string;
    kind?: SymbolKind;
    repoId?: string;
    limit?: number;
  }): Promise<SymbolInfo[]> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (query.name) {
      where.push("LOWER(name) LIKE ?");
      params.push(`%${query.name.toLowerCase()}%`);
    }
    if (query.filePath) {
      where.push("file_path = ?");
      params.push(query.filePath);
    }
    if (query.kind) {
      where.push("kind = ?");
      params.push(query.kind);
    }
    if (query.repoId) {
      where.push("repo_id = ?");
      params.push(query.repoId);
    }

    const limit = Math.max(1, Math.min(500, Math.floor(query.limit ?? 200)));

    const sql = `
      SELECT name, kind, file_path, start_line, end_line, repo_id
      FROM symbols
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY name, file_path, start_line
      LIMIT ?
    `;

    const rows = this.db.query(sql).all(...params, limit) as Array<{
      name: string;
      kind: SymbolKind;
      file_path: string;
      start_line: number;
      end_line: number;
      repo_id: string;
    }>;

    return rows.map((row) => ({
      name: row.name,
      kind: row.kind,
      filePath: row.file_path,
      startLine: row.start_line,
      endLine: row.end_line,
      repoId: row.repo_id,
    }));
  }

  async upsertSymbols(symbols: SymbolInfo[]): Promise<void> {
    const stmt = this.db.query(
      `INSERT INTO symbols(name, kind, file_path, start_line, end_line, chunk_id, repo_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name, file_path, start_line) DO UPDATE SET
         kind = excluded.kind,
         end_line = excluded.end_line,
         chunk_id = excluded.chunk_id,
         repo_id = excluded.repo_id`,
    );

    const tx = this.db.transaction((entries: SymbolInfo[]) => {
      for (const entry of entries) {
        stmt.run(
          entry.name,
          entry.kind,
          entry.filePath,
          entry.startLine,
          entry.endLine,
          `${entry.filePath}:${entry.startLine}-${entry.endLine}`,
          entry.repoId,
        );
      }
    });

    tx(symbols);
  }

  async deleteSymbolsByFile(filePath: string): Promise<void> {
    this.db.query("DELETE FROM symbols WHERE file_path = ?").run(filePath);
  }

  // Index state
  async getIndexState(key: string): Promise<string | null> {
    const row = this.db.query("SELECT value FROM index_state WHERE key = ?").get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  async setIndexState(key: string, value: string): Promise<void> {
    this.db
      .query(
        `INSERT INTO index_state(key, value)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  /** Exposed for advanced modules (write-ahead log, diagnostics). */
  getDatabase(): Database {
    return this.db;
  }
}
