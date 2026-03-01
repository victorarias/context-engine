import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import type { Connection, Table } from "@lancedb/lancedb";
import type {
  Chunk,
  VectorSearchOptions,
  VectorSearchResult,
  VectorStore,
} from "../types.js";

export interface LanceVectorStoreOptions {
  /** Directory where LanceDB files are stored */
  uri: string;
  /** Table name to use for chunk vectors */
  tableName?: string;
  /** Expected vector dimensions for this table */
  vectorDimensions?: number;
}

interface ChunkRow {
  id: string;
  vector: number[];
  content: string;
  filePath: string;
  startLine: number;
  endLine: number;
  symbolName: string;
  symbolKind: string;
  language: string;
  repoId: string;
  worktreeId: string;
  blobHash: string;
}

const REQUIRED_COLUMNS: Array<{ name: string; valueSql: string }> = [
  { name: "worktreeId", valueSql: "'default-worktree'" },
  { name: "blobHash", valueSql: "''" },
];

export class LanceVectorStore implements VectorStore {
  private readonly options: Required<LanceVectorStoreOptions>;
  private connection: Connection | null = null;
  private table: Table | null = null;

  constructor(options: LanceVectorStoreOptions) {
    this.options = {
      tableName: "chunks",
      vectorDimensions: 128,
      ...options,
    };
  }

  async upsert(vectors: Float32Array[], chunks: Chunk[]): Promise<void> {
    if (vectors.length !== chunks.length) {
      throw new Error(`Vector/chunk mismatch: ${vectors.length} vectors for ${chunks.length} chunks`);
    }

    if (chunks.length === 0) return;

    const table = await this.getTable();
    const ids = chunks.map((chunk) => chunk.id);

    // remove existing rows for same IDs first (idempotent upsert)
    await this.delete(ids);

    const rows: ChunkRow[] = chunks.map((chunk, index) => ({
      id: chunk.id,
      vector: Array.from(vectors[index]),
      content: chunk.content,
      filePath: chunk.filePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      symbolName: chunk.symbolName ?? "",
      symbolKind: chunk.symbolKind ?? "",
      language: chunk.language,
      repoId: chunk.repoId,
      worktreeId: chunk.worktreeId ?? "default-worktree",
      blobHash: chunk.blobHash ?? "",
    }));

    await table.add(rows, { mode: "append" });
  }

  async search(query: Float32Array, options: VectorSearchOptions): Promise<VectorSearchResult[]> {
    const table = await this.getTable();

    let q = table.vectorSearch(Array.from(query)).limit(options.limit);

    if (options.filter && Object.keys(options.filter).length > 0) {
      q = q.where(buildSqlFilter(options.filter));
    }

    const rows = await q.toArray() as Array<ChunkRow & { _distance?: number }>;

    return rows.map((row) => {
      const distance = row._distance ?? 1;
      // convert distance to similarity-like score [0,1]
      const score = 1 / (1 + distance);

      return {
        chunkId: row.id,
        score,
        chunk: {
          id: row.id,
          content: row.content,
          filePath: row.filePath,
          startLine: row.startLine,
          endLine: row.endLine,
          symbolName: row.symbolName ? row.symbolName : undefined,
          symbolKind: row.symbolKind
            ? (row.symbolKind as Chunk["symbolKind"])
            : undefined,
          language: row.language,
          repoId: row.repoId,
          worktreeId: row.worktreeId,
          blobHash: row.blobHash,
        },
      };
    });
  }

  async delete(chunkIds: string[]): Promise<void> {
    if (chunkIds.length === 0) return;

    const table = await this.getTable();
    const predicate = `id IN (${chunkIds.map((id) => `'${escapeSql(id)}'`).join(", ")})`;
    await table.delete(predicate);
  }

  async count(): Promise<number> {
    const table = await this.getTable();
    return table.countRows();
  }

  /** Diagnostic helper used by consistency checks. */
  async listChunkIds(): Promise<string[]> {
    const table = await this.getTable();
    const rows = await table.query().select(["id"]).toArray() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  async close(): Promise<void> {
    this.table?.close();
    this.table = null;

    this.connection?.close();
    this.connection = null;
  }

  private async getTable(): Promise<Table> {
    if (this.table) return this.table;

    mkdirSync(dirname(this.options.uri), { recursive: true });
    this.connection = await lancedb.connect(this.options.uri);

    const existing = await this.connection.tableNames();
    if (existing.includes(this.options.tableName)) {
      this.table = await this.connection.openTable(this.options.tableName);
      await this.ensureTableSchema(this.table);
      return this.table;
    }

    // LanceDB createTable requires initial data; bootstrap with one row then delete it.
    const bootstrapId = "__bootstrap__";
    this.table = await this.connection.createTable(this.options.tableName, [
      {
        id: bootstrapId,
        vector: new Array(this.options.vectorDimensions).fill(0),
        content: "",
        filePath: "",
        startLine: 0,
        endLine: 0,
        symbolName: "",
        symbolKind: "",
        language: "",
        repoId: "",
        worktreeId: "",
        blobHash: "",
      },
    ]);

    await this.table.delete(`id = '${bootstrapId}'`);
    return this.table;
  }

  private async ensureTableSchema(table: Table): Promise<void> {
    const schema = await table.schema() as { fields?: Array<{ name?: string }> };
    const existing = new Set((schema.fields ?? []).map((field) => field.name).filter(Boolean) as string[]);

    const missing = REQUIRED_COLUMNS.filter((column) => !existing.has(column.name));
    if (missing.length === 0) {
      return;
    }

    await table.addColumns(missing);
  }
}

function buildSqlFilter(filter: Record<string, unknown>): string {
  const clauses = Object.entries(filter)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      if (value === null) {
        return `${key} IS NULL`;
      }

      if (Array.isArray(value)) {
        const list = value.map((v) => `'${escapeSql(String(v))}'`).join(", ");
        return `${key} IN (${list})`;
      }

      if (typeof value === "number" || typeof value === "boolean") {
        return `${key} = ${value}`;
      }

      return `${key} = '${escapeSql(String(value))}'`;
    });

  if (clauses.length === 0) {
    return "1 = 1";
  }

  return clauses.join(" AND ");
}

function escapeSql(value: string): string {
  return value.replaceAll("'", "''");
}
