import { SQLiteMetadataStore } from "./metadata-store.js";
import { LanceVectorStore } from "./vector-store.js";

export interface ConsistencyReport {
  consistent: boolean;
  referencedChunkIds: number;
  vectorChunkIds: number;
  missingVectors: string[];
  orphanVectors: string[];
}

/**
 * Validate consistency between SQLite metadata references and LanceDB vector rows.
 *
 * - missingVectors: referenced by metadata but absent from LanceDB
 * - orphanVectors: present in LanceDB but absent from metadata
 */
export async function checkStorageConsistency(
  vectorStore: LanceVectorStore,
  metadataStore: SQLiteMetadataStore,
): Promise<ConsistencyReport> {
  const db = metadataStore.getDatabase();

  const referenced = new Set<string>();

  const blobRows = db.query("SELECT chunk_ids FROM blobs").all() as Array<{ chunk_ids: string }>;
  for (const row of blobRows) {
    for (const id of JSON.parse(row.chunk_ids) as string[]) {
      referenced.add(id);
    }
  }

  const dirtyRows = db.query("SELECT chunk_ids FROM dirty_files").all() as Array<{ chunk_ids: string }>;
  for (const row of dirtyRows) {
    for (const id of JSON.parse(row.chunk_ids) as string[]) {
      referenced.add(id);
    }
  }

  const vectorIds = new Set(await vectorStore.listChunkIds());

  const missingVectors = Array.from(referenced).filter((id) => !vectorIds.has(id)).sort();
  const orphanVectors = Array.from(vectorIds).filter((id) => !referenced.has(id)).sort();

  return {
    consistent: missingVectors.length === 0 && orphanVectors.length === 0,
    referencedChunkIds: referenced.size,
    vectorChunkIds: vectorIds.size,
    missingVectors,
    orphanVectors,
  };
}
