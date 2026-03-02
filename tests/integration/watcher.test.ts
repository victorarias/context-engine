import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TempDir } from "../harness/temp-dir.js";
import { WorktreeWatcher } from "../../src/engine/watcher.js";
import { ConfigSchema } from "../../src/config.js";
import { ContextEngine } from "../../src/engine/context-engine.js";

describe("Worktree watcher", () => {
  const dirs: TempDir[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      dir.cleanup();
    }
  });

  it("debounces rapid changes and ignores safety-default paths", async () => {
    const dir = TempDir.create("ce-watcher");
    dirs.push(dir);

    mkdirSync(join(dir.path, "src"), { recursive: true });
    mkdirSync(join(dir.path, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(dir.path, ".git"), { recursive: true });
    mkdirSync(join(dir.path, "linked"), { recursive: true });

    const watchedFile = join(dir.path, "src", "live.ts");
    writeFileSync(watchedFile, "export const value = 'v1';\n");

    const callbackBatches: string[][] = [];

    const watcher = new WorktreeWatcher({
      roots: [dir.path],
      pollIntervalMs: 40,
      debounceMs: 120,
      onChange: (changes) => {
        callbackBatches.push(changes.map((change) => change.path));
      },
    });

    await watcher.start();

    for (let i = 0; i < 5; i++) {
      writeFileSync(watchedFile, `export const value = 'v${i + 2}';\n`);
    }

    await waitFor(() => callbackBatches.length >= 1, 2500);

    expect(callbackBatches.length).toBe(1);
    expect(callbackBatches[0].some((path) => path.endsWith("src/live.ts"))).toBe(true);

    const beforeIgnoredWrites = callbackBatches.length;

    writeFileSync(join(dir.path, "node_modules", "pkg", "ignored.js"), "module.exports = 1;\n");
    writeFileSync(join(dir.path, ".git", "config"), "[core]\n");
    writeFileSync(join(dir.path, "linked", ".git"), "gitdir: /tmp/repo/.git/worktrees/linked\n");

    await sleep(400);

    expect(callbackBatches.length).toBe(beforeIgnoredWrites);

    await watcher.stop();
  });

  it("reindexes automatically when watching is enabled", async () => {
    const dir = TempDir.create("ce-watcher-engine");
    dirs.push(dir);

    const sourceDir = join(dir.path, "repo", "src");
    mkdirSync(sourceDir, { recursive: true });

    const filePath = join(sourceDir, "watch.ts");
    writeFileSync(filePath, "export const token = 'before-watch-update';\n");

    const config = ConfigSchema.parse({
      sources: [{ path: sourceDir }],
      dataDir: join(dir.path, "data"),
      embedding: {
        provider: "local",
        localBackend: "mock",
        dimensions: 64,
      },
      watcher: {
        enabled: true,
        pollIntervalMs: 50,
        debounceMs: 100,
      },
    });

    const engine = await ContextEngine.create(config);
    await engine.index();
    await engine.startWatching({ pollIntervalMs: 50, debounceMs: 100 });

    writeFileSync(filePath, "export const token = 'after-watch-update-token';\n");

    await waitFor(async () => {
      const results = await engine.search("after-watch-update-token", { limit: 5 });
      return results.some((result) => result.content.includes("after-watch-update-token"));
    }, 4000);

    await engine.stopWatching();
    await engine.close();
  });

  it("refreshes dependency/importer graph under watcher updates", async () => {
    const dir = TempDir.create("ce-watcher-deps");
    dirs.push(dir);

    const sourceDir = join(dir.path, "repo", "src");
    mkdirSync(sourceDir, { recursive: true });

    const aPath = join(sourceDir, "a.ts");
    const bPath = join(sourceDir, "b.ts");

    writeFileSync(aPath, "export const greet = () => 'hi';\n");
    writeFileSync(bPath, "import { greet } from './a';\nexport const run = greet;\n");

    const config = ConfigSchema.parse({
      sources: [{ path: sourceDir }],
      dataDir: join(dir.path, "data"),
      embedding: {
        provider: "local",
        localBackend: "mock",
        dimensions: 64,
      },
      watcher: {
        enabled: true,
        pollIntervalMs: 50,
        debounceMs: 100,
      },
    });

    const engine = await ContextEngine.create(config);
    await engine.index();
    await engine.startWatching({ pollIntervalMs: 50, debounceMs: 100 });

    await waitFor(async () => {
      const importers = await engine.findImporters("a.ts");
      return importers.includes("b.ts");
    }, 4000);

    writeFileSync(bPath, "export const run = 'detached';\n");

    await waitFor(async () => {
      const importers = await engine.findImporters("a.ts");
      return !importers.includes("b.ts");
    }, 5000);

    await engine.stopWatching();
    await engine.close();
  });
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return;
    }

    await sleep(50);
  }

  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
