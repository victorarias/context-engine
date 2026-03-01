import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TempDir } from "../harness/temp-dir.js";
import { LanceVectorStore } from "../../src/storage/vector-store.js";
import { ConfigSchema } from "../../src/config.js";
import { ContextEngine } from "../../src/engine/context-engine.js";

describe("regression archive", () => {
  const dirs: TempDir[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      dir.cleanup();
    }
  });

  it("vector search tolerates undefined filter values", async () => {
    const dir = TempDir.create("ce-reg-filter");
    dirs.push(dir);

    const store = new LanceVectorStore({ uri: join(dir.path, "lancedb"), vectorDimensions: 4 });

    await store.upsert(
      [new Float32Array([1, 0, 0, 0])],
      [
        {
          id: "chunk-a",
          content: "auth",
          filePath: "src/auth.ts",
          startLine: 1,
          endLine: 1,
          language: "typescript",
          repoId: "repo",
          worktreeId: "wt-main",
          blobHash: "blob-1",
        },
      ],
    );

    const results = await store.search(new Float32Array([1, 0, 0, 0]), {
      limit: 5,
      filter: { worktreeId: undefined },
    });

    expect(results.length).toBe(1);

    await store.close();
  });

  it("scanner+engine do not index linked worktree .git files", async () => {
    const dir = TempDir.create("ce-reg-dotgit");
    dirs.push(dir);

    const srcDir = join(dir.path, "repo", "src");
    mkdirSync(srcDir, { recursive: true });
    mkdirSync(join(dir.path, "repo", "linked-worktree"), { recursive: true });

    writeFileSync(join(srcDir, "main.ts"), "export const ok = true;\n");
    writeFileSync(
      join(dir.path, "repo", "linked-worktree", ".git"),
      "gitdir: /tmp/repo/.git/worktrees/linked\n",
    );

    const config = ConfigSchema.parse({
      sources: [{ path: join(dir.path, "repo") }],
      dataDir: join(dir.path, "data"),
      embedding: {
        provider: "local",
        localBackend: "mock",
        dimensions: 64,
      },
      watcher: { enabled: false },
    });

    const engine = await ContextEngine.create(config);
    await engine.index();

    const files = await engine.findFiles(".git");
    expect(files.some((path) => path.endsWith("/.git"))).toBe(false);

    await engine.close();
  });
});
