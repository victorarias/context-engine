import { afterEach, describe, expect, it } from "bun:test";
import { performance } from "node:perf_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TempDir } from "../harness/temp-dir.js";
import { ConfigSchema } from "../../src/config.js";
import { ContextEngine } from "../../src/engine/context-engine.js";

describe("python MCP latency budgets", () => {
  const dirs: TempDir[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      dir.cleanup();
    }
  });

  it("keeps warm p95 for deps/importers/references within roadmap budgets", async () => {
    const tmp = TempDir.create("ce-py-latency");
    dirs.push(tmp);

    const sourceDir = join(tmp.path, "repo", "src");
    mkdirSync(join(sourceDir, "pkg"), { recursive: true });

    writeFileSync(join(sourceDir, "pkg", "__init__.py"), "");
    writeFileSync(join(sourceDir, "pkg", "base.py"), "class Base:\n    def execute(self, value):\n        return value\n");

    for (let i = 0; i < 90; i++) {
      writeFileSync(
        join(sourceDir, "pkg", `consumer_${i}.py`),
        `from .base import Base\n\ndef run_${i}():\n    return Base().execute(${i})\n`,
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
      python: {
        referencesBackend: "static",
      },
    });

    const engine = await ContextEngine.create(config);
    await engine.index();

    await engine.getDependencies("pkg/base.py");
    await engine.findImporters("pkg/base.py", { limit: 200 });
    await engine.findReferences("execute", {
      filePath: "pkg/base.py",
      limit: 200,
    });

    const depSamples: number[] = [];
    const importerSamples: number[] = [];
    const referenceSamples: number[] = [];

    for (let i = 0; i < 25; i++) {
      let startedAt = performance.now();
      await engine.getDependencies("pkg/base.py");
      depSamples.push(performance.now() - startedAt);

      startedAt = performance.now();
      await engine.findImporters("pkg/base.py", { limit: 200 });
      importerSamples.push(performance.now() - startedAt);

      startedAt = performance.now();
      await engine.findReferences("execute", {
        filePath: "pkg/base.py",
        limit: 200,
      });
      referenceSamples.push(performance.now() - startedAt);
    }

    const p95Deps = percentile95(depSamples);
    const p95Importers = percentile95(importerSamples);
    const p95References = percentile95(referenceSamples);

    const maxGetDependenciesMs = 50;
    const maxFindImportersMs = 250;
    const maxFindReferencesMs = 400;

    expect(p95Deps).toBeLessThan(maxGetDependenciesMs);
    expect(p95Importers).toBeLessThan(maxFindImportersMs);
    expect(p95References).toBeLessThan(maxFindReferencesMs);

    const status = await engine.status();
    expect(status.queryLatencyMs?.getDependencies.p95 ?? Infinity).toBeLessThanOrEqual(maxGetDependenciesMs);
    expect(status.queryLatencyMs?.findImporters.p95 ?? Infinity).toBeLessThanOrEqual(maxFindImportersMs);
    expect(status.queryLatencyMs?.findReferences.p95 ?? Infinity).toBeLessThanOrEqual(maxFindReferencesMs);

    await engine.close();
  }, 30_000);
});

function percentile95(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.95));
  return sorted[index] ?? sorted[sorted.length - 1] ?? 0;
}
