import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { Chunk, VectorStore } from "../../src/types.js";
import { LanceVectorStore } from "../../src/storage/vector-store.js";
import { MockVectorStore } from "../harness/mocks.js";
import { TempDir } from "../harness/temp-dir.js";

describe("VectorStore contract", () => {
  const dirs: TempDir[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      dir.cleanup();
    }
  });

  runVectorStoreContract("mock", async () => new MockVectorStore());

  runVectorStoreContract("lancedb", async () => {
    const dir = TempDir.create("ce-contract-lance");
    dirs.push(dir);
    return new LanceVectorStore({ uri: join(dir.path, "lancedb"), vectorDimensions: 4 });
  });
});

function runVectorStoreContract(name: string, createStore: () => Promise<VectorStore>) {
  describe(name, () => {
    it("upserts, searches, filters, and deletes consistently", async () => {
      const store = await createStore();

      const chunks: Chunk[] = [
        {
          id: "chunk-auth",
          content: "authenticate user",
          filePath: "src/auth.ts",
          startLine: 1,
          endLine: 2,
          language: "typescript",
          repoId: "repo-1",
          worktreeId: "wt-main",
          blobHash: "blob-auth",
        },
        {
          id: "chunk-session",
          content: "session token manager",
          filePath: "src/session.ts",
          startLine: 1,
          endLine: 2,
          language: "typescript",
          repoId: "repo-2",
          worktreeId: "wt-feature",
          blobHash: "blob-session",
        },
      ];

      await store.upsert(
        [
          new Float32Array([1, 0, 0, 0]),
          new Float32Array([0, 1, 0, 0]),
        ],
        chunks,
      );

      const ranked = await store.search(new Float32Array([0.9, 0.1, 0, 0]), { limit: 10 });
      expect(ranked.length).toBe(2);
      expect(ranked[0].chunkId).toBe("chunk-auth");

      const filtered = await store.search(new Float32Array([0.1, 0.9, 0, 0]), {
        limit: 10,
        filter: { repoId: "repo-2", worktreeId: "wt-feature" },
      });

      expect(filtered.length).toBe(1);
      expect(filtered[0].chunk.filePath).toBe("src/session.ts");

      await store.delete(["chunk-auth"]);
      const afterDelete = await store.search(new Float32Array([1, 0, 0, 0]), { limit: 10 });

      expect(afterDelete.some((entry) => entry.chunkId === "chunk-auth")).toBe(false);

      await store.close();
    });
  });
}
