import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { MetadataStore } from "../../src/types.js";
import { SQLiteMetadataStore } from "../../src/storage/metadata-store.js";
import { MockMetadataStore } from "../harness/mocks.js";
import { TempDir } from "../harness/temp-dir.js";

describe("MetadataStore contract", () => {
  const dirs: TempDir[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      dir.cleanup();
    }
  });

  runMetadataStoreContract("mock", async () => new MockMetadataStore());

  runMetadataStoreContract("sqlite", async () => {
    const dir = TempDir.create("ce-contract-meta");
    dirs.push(dir);
    return new SQLiteMetadataStore({ path: join(dir.path, "metadata.db") });
  });
});

function runMetadataStoreContract(name: string, createStore: () => Promise<MetadataStore>) {
  describe(name, () => {
    it("supports blob/tree/dirty/symbol/docs/state operations", async () => {
      const store = await createStore();

      await store.upsertBlob("blob-1", ["c1", "c2"]);
      expect((await store.getBlob("blob-1"))?.chunkIds).toEqual(["c1", "c2"]);

      await store.upsertTreeEntry("repo-1", "wt-main", "src/a.ts", "blob-1");
      await store.upsertDirtyFile("wt-main", "src/a.ts", "blob-dirty", ["d1"]);

      expect(await store.countBlobReferences("blob-1")).toBe(1);
      expect(await store.countBlobReferences("blob-dirty")).toBe(1);

      const tree = await store.getTreeEntries("wt-main");
      expect(tree).toEqual([{ path: "src/a.ts", blobHash: "blob-1" }]);

      const dirty = await store.getDirtyFiles("wt-main");
      expect(dirty.length).toBe(1);
      expect(dirty[0].chunkIds).toEqual(["d1"]);

      await store.upsertSymbols([
        {
          name: "authenticate",
          kind: "function",
          filePath: "src/a.ts",
          startLine: 1,
          endLine: 3,
          repoId: "repo-1",
        },
      ]);
      expect((await store.getSymbols({ name: "auth" })).length).toBe(1);

      await store.upsertDocChunks("https://example.com", "Example", [
        "Getting started with authentication",
        "Session tokens and refresh",
      ]);
      const docs = await store.searchDocChunks("refresh", 5);
      expect(docs.length).toBe(1);
      expect(docs[0].url).toBe("https://example.com");

      await store.setIndexState("k", "v");
      expect(await store.getIndexState("k")).toBe("v");

      await store.deleteDirtyFile("wt-main", "src/a.ts");
      await store.deleteTreeEntry("wt-main", "src/a.ts");
      await store.deleteBlob("blob-1");
      await store.deleteDocChunks("https://example.com");
      await store.deleteSymbolsByFile("src/a.ts");

      expect(await store.getBlob("blob-1")).toBeNull();
      expect((await store.getTreeEntries("wt-main")).length).toBe(0);
      expect((await store.getDirtyFiles("wt-main")).length).toBe(0);
      expect((await store.searchDocChunks("refresh", 5)).length).toBe(0);
      expect((await store.getSymbols({ name: "auth" })).length).toBe(0);

      await store.close();
    });
  });
}
