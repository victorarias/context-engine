import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { LanceVectorStore } from "../../src/storage/vector-store.js";
import { TempDir } from "../harness/temp-dir.js";
import type { Chunk } from "../../src/types.js";

describe("LanceVectorStore", () => {
  const dirs: TempDir[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0, dirs.length)) {
      dir.cleanup();
    }
  });

  async function createStore() {
    const dir = TempDir.create("ce-lance");
    dirs.push(dir);
    const store = new LanceVectorStore({ uri: join(dir.path, "lancedb"), vectorDimensions: 4 });
    return store;
  }

  it("upserts and searches vectors", async () => {
    const store = await createStore();

    const chunks: Chunk[] = [
      {
        id: "chunk-auth",
        content: "authenticate user with password hash",
        filePath: "src/auth/login.ts",
        startLine: 1,
        endLine: 10,
        language: "typescript",
        repoId: "repo1",
      },
      {
        id: "chunk-logger",
        content: "log request and response",
        filePath: "src/utils/logger.ts",
        startLine: 1,
        endLine: 10,
        language: "typescript",
        repoId: "repo1",
      },
    ];

    const vectors = [
      new Float32Array([1, 0, 0, 0]),
      new Float32Array([0, 1, 0, 0]),
    ];

    await store.upsert(vectors, chunks);

    const results = await store.search(new Float32Array([0.9, 0.1, 0, 0]), {
      limit: 2,
    });

    expect(results.length).toBe(2);
    expect(results[0].chunkId).toBe("chunk-auth");
    expect(results[0].score).toBeGreaterThan(results[1].score);

    await store.close();
  });

  it("applies scalar filters", async () => {
    const store = await createStore();

    await store.upsert(
      [
        new Float32Array([1, 0, 0, 0]),
        new Float32Array([0, 1, 0, 0]),
      ],
      [
        {
          id: "repo1-a",
          content: "repo1 content",
          filePath: "a.ts",
          startLine: 1,
          endLine: 2,
          language: "typescript",
          repoId: "repo1",
        },
        {
          id: "repo2-b",
          content: "repo2 content",
          filePath: "b.ts",
          startLine: 1,
          endLine: 2,
          language: "typescript",
          repoId: "repo2",
        },
      ],
    );

    const filtered = await store.search(new Float32Array([1, 0, 0, 0]), {
      limit: 10,
      filter: { repoId: "repo2" },
    });

    expect(filtered.length).toBe(1);
    expect(filtered[0].chunk.repoId).toBe("repo2");

    await store.close();
  });

  it("deletes chunk ids", async () => {
    const store = await createStore();

    await store.upsert(
      [new Float32Array([1, 0, 0, 0])],
      [
        {
          id: "to-delete",
          content: "x",
          filePath: "x.ts",
          startLine: 1,
          endLine: 1,
          language: "typescript",
          repoId: "repo1",
        },
      ],
    );

    expect(await store.count()).toBe(1);
    await store.delete(["to-delete"]);
    expect(await store.count()).toBe(0);

    await store.close();
  });
});
