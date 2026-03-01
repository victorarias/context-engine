import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TempDir } from "../harness/temp-dir.js";
import { ConfigSchema } from "../../src/config.js";
import { ContextEngine } from "../../src/engine/context-engine.js";
import { evaluateQueries, type LabeledQuery } from "../harness/ir-metrics.js";

interface BaselineMetrics {
  mrr: number;
  ndcgAt10: number;
  precisionAt5: number;
  recallAt10: number;
  maxDropPct: number;
}

describe("eval regression gate", () => {
  const dirs: TempDir[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      dir.cleanup();
    }
  });

  it("does not regress metrics beyond configured baseline drop", async () => {
    const tmp = TempDir.create("ce-eval-gate");
    dirs.push(tmp);

    const sourceDir = join(tmp.path, "repo", "src");
    mkdirSync(join(sourceDir, "auth"), { recursive: true });
    mkdirSync(join(sourceDir, "utils"), { recursive: true });

    writeFileSync(
      join(sourceDir, "auth", "login.ts"),
      "export function authenticateUser(email: string, password: string) { return !!email && !!password; }\n",
    );
    writeFileSync(
      join(sourceDir, "auth", "session.ts"),
      "export class SessionManager { issueToken(userId: string) { return `token-${userId}`; } }\n",
    );
    writeFileSync(
      join(sourceDir, "utils", "hash.ts"),
      "export const hashPassword = (value: string) => `hash:${value}`;\n",
    );

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

    const labels = JSON.parse(
      readFileSync(join(import.meta.dir, "golden-queries.json"), "utf-8"),
    ) as LabeledQuery[];

    const baseline = JSON.parse(
      readFileSync(join(import.meta.dir, "baseline-metrics.json"), "utf-8"),
    ) as BaselineMetrics;

    const resultsByQuery = new Map<string, Array<{ filePath: string; score: number }>>();

    for (const label of labels) {
      const results = await engine.search(label.query, { limit: 10 });
      resultsByQuery.set(
        label.query,
        results.map((result) => ({ filePath: result.filePath, score: result.score })),
      );
    }

    const metrics = evaluateQueries(labels, resultsByQuery);

    expect(metrics.mrr).toBeGreaterThanOrEqual(baseline.mrr * (1 - baseline.maxDropPct));
    expect(metrics.ndcgAt10).toBeGreaterThanOrEqual(baseline.ndcgAt10 * (1 - baseline.maxDropPct));
    expect(metrics.precisionAt5).toBeGreaterThanOrEqual(baseline.precisionAt5 * (1 - baseline.maxDropPct));
    expect(metrics.recallAt10).toBeGreaterThanOrEqual(baseline.recallAt10 * (1 - baseline.maxDropPct));

    await engine.close();
  });
});
