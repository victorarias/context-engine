import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { SQLiteMetadataStore } from "../../src/storage/metadata-store.js";
import { LanceVectorStore } from "../../src/storage/vector-store.js";
import { checkStorageConsistency } from "../../src/storage/consistency-checker.js";
import { TempDir } from "../harness/temp-dir.js";

describe("checkStorageConsistency", () => {
  const dirs: TempDir[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      dir.cleanup();
    }
  });

  async function setup() {
    const dir = TempDir.create("ce-consistency");
    dirs.push(dir);

    const metadata = new SQLiteMetadataStore({ path: join(dir.path, "metadata.db") });
    const vectors = new LanceVectorStore({ uri: join(dir.path, "lancedb") });

    return { metadata, vectors };
  }

  it("reports consistent storage when metadata and vectors match", async () => {
    const { metadata, vectors } = await setup();

    await vectors.upsert(
      [new Float32Array([1, 0, 0, 0])],
      [
        {
          id: "chunk-1",
          content: "hello",
          filePath: "a.ts",
          startLine: 1,
          endLine: 1,
          language: "ts",
          repoId: "repo",
        },
      ],
    );
    await metadata.upsertBlob("blob-1", ["chunk-1"]);

    const report = await checkStorageConsistency(vectors, metadata);
    expect(report.consistent).toBe(true);
    expect(report.missingVectors).toEqual([]);
    expect(report.orphanVectors).toEqual([]);

    await vectors.close();
    await metadata.close();
  });

  it("detects missing and orphan vectors", async () => {
    const { metadata, vectors } = await setup();

    // Referenced in metadata but not in vectors
    await metadata.upsertBlob("blob-missing", ["chunk-missing"]);

    // Present in vectors but not in metadata
    await vectors.upsert(
      [new Float32Array([0, 1, 0, 0])],
      [
        {
          id: "chunk-orphan",
          content: "orphan",
          filePath: "b.ts",
          startLine: 1,
          endLine: 1,
          language: "ts",
          repoId: "repo",
        },
      ],
    );

    const report = await checkStorageConsistency(vectors, metadata);

    expect(report.consistent).toBe(false);
    expect(report.missingVectors).toEqual(["chunk-missing"]);
    expect(report.orphanVectors).toEqual(["chunk-orphan"]);

    await vectors.close();
    await metadata.close();
  });
});
