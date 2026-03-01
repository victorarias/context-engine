import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { SQLiteMetadataStore } from "../../src/storage/metadata-store.js";
import { TempDir } from "../harness/temp-dir.js";

describe("SQLiteMetadataStore", () => {
  const dirs: TempDir[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0, dirs.length)) {
      dir.cleanup();
    }
  });

  function createStore() {
    const dir = TempDir.create("ce-metadata");
    dirs.push(dir);
    return new SQLiteMetadataStore({ path: join(dir.path, "metadata.db") });
  }

  it("stores and retrieves blobs", async () => {
    const store = createStore();

    await store.upsertBlob("blob1", ["c1", "c2"]);
    const blob = await store.getBlob("blob1");

    expect(blob).not.toBeNull();
    expect(blob?.chunkIds).toEqual(["c1", "c2"]);

    await store.deleteBlob("blob1");
    expect(await store.getBlob("blob1")).toBeNull();

    await store.close();
  });

  it("counts blob references across tree and dirty overlays", async () => {
    const store = createStore();

    await store.upsertTreeEntry("repo1", "wt-main", "src/a.ts", "blobA");
    await store.upsertTreeEntry("repo1", "wt-feature", "src/a.ts", "blobA");
    await store.upsertDirtyFile("wt-main", "src/a.ts", "blobDirty", ["c1"]);

    expect(await store.countBlobReferences("blobA")).toBe(2);
    expect(await store.countBlobReferences("blobDirty")).toBe(1);

    await store.deleteTreeEntry("wt-feature", "src/a.ts");
    expect(await store.countBlobReferences("blobA")).toBe(1);

    await store.close();
  });

  it("stores worktree tree entries independently", async () => {
    const store = createStore();

    await store.upsertTreeEntry("repo1", "wt-main", "src/a.ts", "blobA");
    await store.upsertTreeEntry("repo1", "wt-feature", "src/a.ts", "blobB");

    const main = await store.getTreeEntries("wt-main");
    const feature = await store.getTreeEntries("wt-feature");

    expect(main).toEqual([{ path: "src/a.ts", blobHash: "blobA" }]);
    expect(feature).toEqual([{ path: "src/a.ts", blobHash: "blobB" }]);

    await store.close();
  });

  it("stores dirty file overlays per worktree", async () => {
    const store = createStore();

    await store.upsertDirtyFile("wt-main", "src/auth.ts", "hash1", ["d1", "d2"]);
    await store.upsertDirtyFile("wt-main", "src/session.ts", "hash2", ["d3"]);

    const dirty = await store.getDirtyFiles("wt-main");
    expect(dirty.length).toBe(2);
    expect(dirty[0].path).toBe("src/auth.ts");
    expect(dirty[0].chunkIds).toEqual(["d1", "d2"]);

    await store.deleteDirtyFile("wt-main", "src/auth.ts");
    const afterDelete = await store.getDirtyFiles("wt-main");
    expect(afterDelete.length).toBe(1);

    await store.close();
  });

  it("stores and filters symbols", async () => {
    const store = createStore();

    await store.upsertSymbols([
      {
        name: "authenticateUser",
        kind: "function",
        filePath: "src/auth/login.ts",
        startLine: 10,
        endLine: 42,
        repoId: "repo1",
      },
      {
        name: "SessionManager",
        kind: "class",
        filePath: "src/auth/session.ts",
        startLine: 3,
        endLine: 120,
        repoId: "repo1",
      },
    ]);

    const byName = await store.getSymbols({ name: "auth" });
    expect(byName.length).toBe(1);
    expect(byName[0].name).toBe("authenticateUser");

    const byKind = await store.getSymbols({ kind: "class" });
    expect(byKind.length).toBe(1);
    expect(byKind[0].name).toBe("SessionManager");

    await store.deleteSymbolsByFile("src/auth/login.ts");
    const remaining = await store.getSymbols({});
    expect(remaining.length).toBe(1);

    await store.close();
  });

  it("stores and searches documentation chunks", async () => {
    const store = createStore();

    await store.upsertDocChunks("https://example.com/guide", "Guide", [
      "Authentication setup instructions",
      "Session token refresh details",
    ]);

    const hits = await store.searchDocChunks("token refresh", 5);
    expect(hits.length).toBe(1);
    expect(hits[0].url).toBe("https://example.com/guide");
    expect(hits[0].title).toBe("Guide");

    await store.deleteDocChunks("https://example.com/guide");
    const empty = await store.searchDocChunks("token", 5);
    expect(empty.length).toBe(0);

    await store.close();
  });

  it("stores and retrieves index state", async () => {
    const store = createStore();

    await store.setIndexState("repo:main:lastIndexed", "abc123");
    expect(await store.getIndexState("repo:main:lastIndexed")).toBe("abc123");

    await store.setIndexState("repo:main:lastIndexed", "def456");
    expect(await store.getIndexState("repo:main:lastIndexed")).toBe("def456");

    await store.close();
  });
});
