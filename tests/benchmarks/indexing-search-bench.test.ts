import { afterEach, describe, expect, it } from "bun:test";
import { performance } from "node:perf_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TempDir } from "../harness/temp-dir.js";
import { ConfigSchema } from "../../src/config.js";
import { ContextEngine } from "../../src/engine/context-engine.js";

describe("benchmark suites", () => {
  const dirs: TempDir[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      dir.cleanup();
    }
  });

  it("indexes medium fixture corpus within latency budget", async () => {
    const tmp = TempDir.create("ce-bench-index");
    dirs.push(tmp);

    const sourceDir = join(tmp.path, "repo", "src");
    mkdirSync(sourceDir, { recursive: true });

    for (let i = 0; i < 200; i++) {
      writeFileSync(
        join(sourceDir, `file-${i}.ts`),
        `export function fn${i}(value: string) { return value + "-${i}"; }\n`,
      );
    }

    const config = ConfigSchema.parse({
      sources: [{ path: sourceDir }],
      dataDir: join(tmp.path, "data"),
      embedding: {
        provider: "local",
        localBackend: "mock",
        dimensions: 64,
      },
      watcher: { enabled: false },
    });

    const engine = await ContextEngine.create(config);

    const start = performance.now();
    await engine.index();
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(8000);

    const status = await engine.status();
    expect(status.repos[0].filesIndexed).toBe(200);

    await engine.close();
  });

  it("keeps semantic search under p95-style latency budget", async () => {
    const tmp = TempDir.create("ce-bench-search");
    dirs.push(tmp);

    const sourceDir = join(tmp.path, "repo", "src");
    mkdirSync(sourceDir, { recursive: true });

    for (let i = 0; i < 120; i++) {
      writeFileSync(
        join(sourceDir, `module-${i}.ts`),
        `export const token${i} = "auth-token-${i}";\n`,
      );
    }

    const config = ConfigSchema.parse({
      sources: [{ path: sourceDir }],
      dataDir: join(tmp.path, "data"),
      embedding: {
        provider: "local",
        localBackend: "mock",
        dimensions: 64,
      },
      watcher: { enabled: false },
    });

    const engine = await ContextEngine.create(config);
    await engine.index();

    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const query = `auth token ${i % 5}`;
      const start = performance.now();
      await engine.search(query, { limit: 10 });
      samples.push(performance.now() - start);
    }

    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95) - 1] ?? samples[samples.length - 1];

    expect(p95).toBeLessThan(250);

    const rssBytes = process.memoryUsage().rss;
    expect(rssBytes).toBeLessThan(1.5 * 1024 * 1024 * 1024);

    await engine.close();
  });
});
