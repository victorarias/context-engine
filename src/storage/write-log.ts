import type { Database } from "bun:sqlite";

export type WriteOperation = "upsert" | "delete";

export interface WriteLogEntry {
  id: number;
  operation: WriteOperation;
  chunkIds: string[];
  lanceOk: boolean;
  sqliteOk: boolean;
  createdAt: string;
}

export interface ReconcileContext {
  entry: WriteLogEntry;
  markRecovered(): void;
  markRolledBack(): void;
}

export type ReconcileHandler = (context: ReconcileContext) => Promise<void>;

/**
 * Write-ahead log for dual-write operations between LanceDB and SQLite metadata.
 *
 * Lifecycle:
 *  1) beginIntent(operation, chunkIds)
 *  2) write to LanceDB, then markLanceOk(id)
 *  3) write metadata, then markSqliteOk(id)
 *  4) finalize(id)
 */
export class WriteAheadLog {
  constructor(private readonly db: Database) {}

  async beginIntent(operation: WriteOperation, chunkIds: string[]): Promise<number> {
    const result = this.db
      .query("INSERT INTO write_log(operation, chunk_ids, lance_ok, sqlite_ok) VALUES (?, ?, 0, 0)")
      .run(operation, JSON.stringify(chunkIds));

    return Number(result.lastInsertRowid);
  }

  async markLanceOk(id: number): Promise<void> {
    this.db.query("UPDATE write_log SET lance_ok = 1 WHERE id = ?").run(id);
  }

  async markSqliteOk(id: number): Promise<void> {
    this.db.query("UPDATE write_log SET sqlite_ok = 1 WHERE id = ?").run(id);
  }

  async finalize(id: number): Promise<void> {
    // Keep historical rows for observability. Marking both flags effectively means complete.
    this.db.query("UPDATE write_log SET lance_ok = 1, sqlite_ok = 1 WHERE id = ?").run(id);
  }

  async listPending(): Promise<WriteLogEntry[]> {
    const rows = this.db
      .query(
        `SELECT id, operation, chunk_ids, lance_ok, sqlite_ok, created_at
         FROM write_log
         WHERE lance_ok = 0 OR sqlite_ok = 0
         ORDER BY id ASC`,
      )
      .all() as Array<{
      id: number;
      operation: WriteOperation;
      chunk_ids: string;
      lance_ok: number;
      sqlite_ok: number;
      created_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      operation: row.operation,
      chunkIds: JSON.parse(row.chunk_ids),
      lanceOk: row.lance_ok === 1,
      sqliteOk: row.sqlite_ok === 1,
      createdAt: row.created_at,
    }));
  }

  async reconcile(handler: ReconcileHandler): Promise<void> {
    const pending = await this.listPending();

    for (const entry of pending) {
      let completed = false;
      let rolledBack = false;

      await handler({
        entry,
        markRecovered: () => {
          completed = true;
        },
        markRolledBack: () => {
          rolledBack = true;
        },
      });

      if (completed || rolledBack) {
        await this.finalize(entry.id);
      }
    }
  }
}
