/**
 * Memory profiling script for context-engine.
 *
 * Tracks heap usage at each stage of the engine lifecycle to identify
 * what's consuming memory and whether it grows unboundedly.
 *
 * Usage: bun run src/dev/memory-profile.ts <repo-path> [--onnx]
 */

import { ContextEngine } from "../engine/context-engine.js";
import { loadConfig } from "../config.js";
import { resolve } from "node:path";
import { readdirSync, statSync } from "node:fs";

const targetDir = process.argv[2] ?? process.cwd();
const useOnnx = process.argv.includes("--onnx");
const absTarget = resolve(targetDir);

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function snap(label: string): void {
  if (typeof Bun !== "undefined") {
    Bun.gc(true);
  }
  const mem = process.memoryUsage();
  console.log(
    `[MEM] ${label.padEnd(45)} | rss=${mb(mem.rss).padStart(10)} | heap=${mb(mem.heapUsed).padStart(10)} | external=${mb(mem.external).padStart(10)} | arrayBuf=${mb(mem.arrayBuffers).padStart(10)} | native≈${mb(mem.rss - mem.heapUsed - mem.external).padStart(10)}`,
  );
}

function dirSize(dir: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        total += dirSize(full);
      } else if (entry.isFile()) {
        total += statSync(full).size;
      }
    }
  } catch { /* ignore */ }
  return total;
}

function lanceFragmentCount(dataDir: string): number {
  try {
    const lancePath = resolve(dataDir, "lancedb/chunks.lance/data");
    return readdirSync(lancePath).filter(f => f.endsWith(".lance")).length;
  } catch {
    return 0;
  }
}

async function main() {
  console.log(`\nProfiling context-engine against: ${absTarget}`);
  console.log(`Embedding backend: ${useOnnx ? "onnx" : "mock"}\n`);
  console.log("=".repeat(150));

  snap("0. baseline (before anything)");

  const config = loadConfig(absTarget);
  config.embedding.localBackend = useOnnx ? "onnx" : "mock";
  config.watcher.enabled = false;

  snap("1. config loaded");

  const engine = await ContextEngine.create(config);
  snap("2. engine.create() complete");

  // First index (fresh, no prior data)
  console.log(`\nFirst index of ${absTarget}...\n`);
  const indexStart = Date.now();

  const memInterval = setInterval(() => {
    const mem = process.memoryUsage();
    const elapsed = ((Date.now() - indexStart) / 1000).toFixed(1);
    const frags = lanceFragmentCount(config.dataDir);
    process.stdout.write(
      `\r  [${elapsed}s] rss=${mb(mem.rss).padStart(9)} heap=${mb(mem.heapUsed).padStart(9)} ext=${mb(mem.external).padStart(9)} arrBuf=${mb(mem.arrayBuffers).padStart(9)} frags=${String(frags).padStart(4)}   `,
    );
  }, 500);

  await engine.index(config.sources.map((s) => s.path));
  clearInterval(memInterval);
  console.log("");

  const indexMs = Date.now() - indexStart;
  const frags1 = lanceFragmentCount(config.dataDir);
  const lanceSize1 = dirSize(resolve(config.dataDir, "lancedb"));
  snap(`3. first index done (${(indexMs / 1000).toFixed(1)}s)`);
  console.log(`   lance: ${frags1} fragments, ${mb(lanceSize1)} on disk`);

  await new Promise((r) => setTimeout(r, 2000));
  snap("4. 2s settle after first index");

  // Second index (should be incremental / no-op)
  await engine.index(config.sources.map((s) => s.path));
  const frags2 = lanceFragmentCount(config.dataDir);
  const lanceSize2 = dirSize(resolve(config.dataDir, "lancedb"));
  snap("5. second index (no-op)");
  console.log(`   lance: ${frags2} fragments, ${mb(lanceSize2)} on disk`);

  // Third index
  await engine.index(config.sources.map((s) => s.path));
  const frags3 = lanceFragmentCount(config.dataDir);
  const lanceSize3 = dirSize(resolve(config.dataDir, "lancedb"));
  snap("6. third index (no-op)");
  console.log(`   lance: ${frags3} fragments, ${mb(lanceSize3)} on disk`);

  // Searches
  for (let i = 0; i < 5; i++) {
    await engine.search(`query number ${i}`, { limit: 5 });
  }
  snap("7. after 5 searches");

  for (let i = 0; i < 20; i++) {
    await engine.search(`query number ${i + 5}`, { limit: 5 });
  }
  snap("8. after 25 total searches");

  // Close
  await engine.close();
  snap("9. after engine.close()");

  await new Promise((r) => setTimeout(r, 2000));
  snap("10. 2s after close (final settle)");

  console.log("\n" + "=".repeat(150));
  console.log("Done.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
