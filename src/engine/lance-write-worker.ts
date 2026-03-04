/**
 * Subprocess entry point for LanceDB vector writes.
 *
 * Runs in a child process so the Rust allocator's native memory is freed
 * when the process exits, keeping the parent's RSS low.
 *
 * Usage: bun run src/engine/lance-write-worker.ts <uri> <dimensions> <tableName> <rowsFilePath>
 */

import { readFileSync, unlinkSync } from "node:fs";
import { LanceVectorStore, type ChunkRow } from "../storage/index.js";

const BATCH_SIZE = 200;

const [uri, dimensionsStr, tableName, rowsFilePath] = process.argv.slice(2);

if (!uri || !dimensionsStr || !tableName || !rowsFilePath) {
  console.error("Usage: lance-write-worker <uri> <dimensions> <tableName> <rowsFilePath>");
  process.exit(1);
}

const dimensions = Number(dimensionsStr);
const ndjson = readFileSync(rowsFilePath, "utf-8");
const lines = ndjson.trimEnd().split("\n");

const store = new LanceVectorStore({ uri, tableName, vectorDimensions: dimensions });

for (let i = 0; i < lines.length; i++) {
  const row: ChunkRow = JSON.parse(lines[i]);
  store.bufferAddRaw(row);

  if ((i + 1) % BATCH_SIZE === 0) {
    await store.flushBuffer();
  }
}

await store.flushBuffer();
await store.optimize();
await store.close();

// Clean up temp file
try {
  unlinkSync(rowsFilePath);
} catch {
  // best-effort
}
