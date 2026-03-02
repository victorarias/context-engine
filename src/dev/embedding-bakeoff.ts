#!/usr/bin/env bun

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ConfigSchema, type Config } from "../config.js";
import { ContextEngine } from "../engine/context-engine.js";

type QuerySpec = {
  query: string;
  relevant?: string[];
};

type CandidateSpec = {
  name: string;
  embedding: Record<string, unknown>;
};

type Args = {
  repo: string;
  queries: string;
  candidates: string;
  dataRoot: string;
  limit: number;
  out?: string;
  keepData: boolean;
};

type RankedResult = {
  filePath: string;
  score: number;
};

async function main() {
  const keepAlive = setInterval(() => {}, 1000);

  try {
    const args = parseArgs(process.argv.slice(2));
    if (process.env.DEBUG_EMBED_BAKEOFF === "1") {
      console.log("[bakeoff] args", args);
    }

    const queries = loadQueries(args.queries);
    const candidates = loadCandidates(args.candidates);

    if (process.env.DEBUG_EMBED_BAKEOFF === "1") {
      console.log("[bakeoff] loaded", { queries: queries.length, candidates: candidates.length });
    }

    mkdirSync(args.dataRoot, { recursive: true });

    const runs: Array<{
    name: string;
    dataDir: string;
    indexMs: number;
    searchMs: number;
    metrics?: EvalMetrics;
    top1ByQuery: Array<{ query: string; filePath: string | null; score: number | null }>;
  }> = [];

  for (const candidate of candidates) {
    if (process.env.DEBUG_EMBED_BAKEOFF === "1") {
      console.log("[bakeoff] candidate.start", candidate.name);
    }

    const dataDir = join(args.dataRoot, slug(candidate.name));
    if (!args.keepData) {
      rmSync(dataDir, { recursive: true, force: true });
    }

    const config = makeConfig(args.repo, dataDir, candidate.embedding);

    const engine = await ContextEngine.create(config);
    const indexStarted = Date.now();
    await engine.index();
    const indexMs = Date.now() - indexStarted;

    const resultsByQuery = new Map<string, RankedResult[]>();
    const top1ByQuery: Array<{ query: string; filePath: string | null; score: number | null }> = [];

    const searchStarted = Date.now();
    for (const q of queries) {
      const results = await engine.search(q.query, { limit: args.limit });
      const ranked = results.map((r) => ({ filePath: r.filePath, score: r.score }));
      resultsByQuery.set(q.query, ranked);

      top1ByQuery.push({
        query: q.query,
        filePath: ranked[0]?.filePath ?? null,
        score: ranked[0]?.score ?? null,
      });
    }
    const searchMs = Date.now() - searchStarted;

    const hasLabels = queries.every((q) => Array.isArray(q.relevant) && q.relevant.length > 0);
    const metrics = hasLabels ? evaluateQueries(queries as Array<QuerySpec & { relevant: string[] }>, resultsByQuery) : undefined;

    await engine.close();

    runs.push({
      name: candidate.name,
      dataDir,
      indexMs,
      searchMs,
      metrics,
      top1ByQuery,
    });

    if (process.env.DEBUG_EMBED_BAKEOFF === "1") {
      console.log("[bakeoff] candidate.done", candidate.name, { indexMs, searchMs });
    }
  }

  if (process.env.DEBUG_EMBED_BAKEOFF === "1") {
    console.log("[bakeoff] summary");
  }

  printSummary(runs, queries.length, args.limit);

    if (args.out) {
      writeFileSync(args.out, JSON.stringify({
        repo: args.repo,
        queries: args.queries,
        candidates: args.candidates,
        limit: args.limit,
        runs,
        generatedAt: new Date().toISOString(),
      }, null, 2));
      console.log(`\nWrote report: ${args.out}`);
    }
  } finally {
    clearInterval(keepAlive);
  }
}

function makeConfig(repoPath: string, dataDir: string, embedding: Record<string, unknown>): Config {
  return ConfigSchema.parse({
    sources: [{ path: repoPath }],
    dataDir,
    watcher: { enabled: false },
    embedding,
  });
}

function loadQueries(path: string): QuerySpec[] {
  const resolved = resolve(path);
  const raw = JSON.parse(readFileSync(resolved, "utf-8")) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error(`queries file must be an array: ${resolved}`);
  }

  const queries: QuerySpec[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    if (typeof obj.query !== "string" || !obj.query.trim()) continue;

    const relevant = Array.isArray(obj.relevant)
      ? obj.relevant.filter((v): v is string => typeof v === "string")
      : undefined;

    queries.push({ query: obj.query, relevant });
  }

  if (queries.length === 0) {
    throw new Error(`no valid queries found in ${resolved}`);
  }

  return queries;
}

function loadCandidates(path: string): CandidateSpec[] {
  const resolved = resolve(path);
  const raw = JSON.parse(readFileSync(resolved, "utf-8")) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error(`candidates file must be an array: ${resolved}`);
  }

  const out: CandidateSpec[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    if (typeof obj.name !== "string" || !obj.name.trim()) continue;
    if (!obj.embedding || typeof obj.embedding !== "object" || Array.isArray(obj.embedding)) continue;

    out.push({
      name: obj.name,
      embedding: obj.embedding as Record<string, unknown>,
    });
  }

  if (out.length === 0) {
    throw new Error(`no valid candidates found in ${resolved}`);
  }

  return out;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {
    dataRoot: resolve(".context-engine", "bakeoff"),
    limit: 10,
    keepData: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    switch (token) {
      case "--repo":
        out.repo = resolve(argv[++i] ?? "");
        break;
      case "--queries":
        out.queries = resolve(argv[++i] ?? "");
        break;
      case "--candidates":
        out.candidates = resolve(argv[++i] ?? "");
        break;
      case "--data-root":
        out.dataRoot = resolve(argv[++i] ?? out.dataRoot!);
        break;
      case "--limit":
        out.limit = Number(argv[++i] ?? out.limit);
        break;
      case "--out":
        out.out = resolve(argv[++i] ?? "");
        break;
      case "--keep-data":
        out.keepData = true;
        break;
      default:
        if (token.startsWith("--")) {
          throw new Error(`Unknown flag: ${token}`);
        }
        break;
    }
  }

  if (!out.repo) throw new Error("Missing --repo <path>");
  if (!out.queries) throw new Error("Missing --queries <path>");
  if (!out.candidates) throw new Error("Missing --candidates <path>");

  return out as Args;
}

type EvalMetrics = {
  mrr: number;
  ndcgAt10: number;
  precisionAt5: number;
  recallAt10: number;
};

function evaluateQueries(
  labels: Array<{ query: string; relevant: string[] }>,
  resultsByQuery: Map<string, RankedResult[]>,
): EvalMetrics {
  let mrr = 0;
  let ndcg = 0;
  let p5 = 0;
  let r10 = 0;

  for (const label of labels) {
    const ranked = uniqueByFilePath(resultsByQuery.get(label.query) ?? []);
    mrr += reciprocalRank(ranked, label.relevant);
    ndcg += ndcgAtK(ranked, label.relevant, 10);
    p5 += precisionAtK(ranked, label.relevant, 5);
    r10 += recallAtK(ranked, label.relevant, 10);
  }

  const n = labels.length;
  return {
    mrr: mrr / n,
    ndcgAt10: ndcg / n,
    precisionAt5: p5 / n,
    recallAt10: r10 / n,
  };
}

function reciprocalRank(results: RankedResult[], relevant: string[]): number {
  const set = new Set(relevant);
  for (let i = 0; i < results.length; i++) {
    if (set.has(results[i].filePath)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

function precisionAtK(results: RankedResult[], relevant: string[], k: number): number {
  if (k <= 0) return 0;
  const set = new Set(relevant);
  const top = results.slice(0, k);
  if (top.length === 0) return 0;
  const hits = top.filter((result) => set.has(result.filePath)).length;
  return hits / k;
}

function recallAtK(results: RankedResult[], relevant: string[], k: number): number {
  if (relevant.length === 0) return 0;
  const set = new Set(relevant);
  const top = results.slice(0, k);
  const hits = top.filter((result) => set.has(result.filePath)).length;
  return hits / relevant.length;
}

function ndcgAtK(results: RankedResult[], relevant: string[], k: number): number {
  const set = new Set(relevant);
  const dcg = results
    .slice(0, k)
    .reduce((acc, result, idx) => {
      if (!set.has(result.filePath)) return acc;
      return acc + 1 / log2(idx + 2);
    }, 0);

  const idealHits = Math.min(k, relevant.length);
  const idcg = Array.from({ length: idealHits })
    .reduce((acc, _, idx) => acc + 1 / log2(idx + 2), 0);

  if (idcg === 0) return 0;
  return dcg / idcg;
}

function log2(value: number): number {
  return Math.log(value) / Math.log(2);
}

function uniqueByFilePath(results: RankedResult[]): RankedResult[] {
  const seen = new Set<string>();
  const out: RankedResult[] = [];

  for (const result of results) {
    if (seen.has(result.filePath)) continue;
    seen.add(result.filePath);
    out.push(result);
  }

  return out;
}

function printSummary(
  runs: Array<{
    name: string;
    indexMs: number;
    searchMs: number;
    metrics?: EvalMetrics;
    top1ByQuery: Array<{ query: string; filePath: string | null; score: number | null }>;
  }>,
  queryCount: number,
  limit: number,
) {
  console.log("\nEmbedding bakeoff results");
  console.log(`Queries: ${queryCount} (limit=${limit})`);

  for (const run of runs) {
    console.log(`\n=== ${run.name} ===`);
    console.log(`index: ${run.indexMs}ms`);
    console.log(`search: ${run.searchMs}ms`);

    if (run.metrics) {
      console.log(`mrr: ${run.metrics.mrr.toFixed(4)}`);
      console.log(`ndcg@10: ${run.metrics.ndcgAt10.toFixed(4)}`);
      console.log(`p@5: ${run.metrics.precisionAt5.toFixed(4)}`);
      console.log(`r@10: ${run.metrics.recallAt10.toFixed(4)}`);
    } else {
      console.log("metrics: skipped (queries missing `relevant` labels)");
    }

    console.log("top-1 by query:");
    for (const item of run.top1ByQuery) {
      const score = item.score === null ? "n/a" : item.score.toFixed(3);
      console.log(`- ${item.query} -> ${item.filePath ?? "(none)"} [${score}]`);
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`embedding-bakeoff failed: ${message}`);
  process.exit(1);
});
