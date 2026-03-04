import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TempDir } from "../harness/temp-dir.js";
import { ConfigSchema } from "../../src/config.js";
import { ContextEngine } from "../../src/engine/context-engine.js";

interface GoldenCheck {
  id: string;
  tool: "get_dependencies" | "find_importers" | "find_references" | "get_symbols";
  args: Record<string, unknown>;
  contains?: string[];
  notContains?: string[];
  containsSymbols?: string[];
  containsKinds?: string[];
}

interface GoldenSpec {
  checks: GoldenCheck[];
}

describe("python MCP golden outputs", () => {
  const dirs: TempDir[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      dir.cleanup();
    }
  });

  it("matches golden expectations for dependencies/importers/references/symbols", async () => {
    const tmp = TempDir.create("ce-py-golden");
    dirs.push(tmp);

    const fixtureDir = join(import.meta.dir, "..", "fixtures", "python", "solid-mcp-repo");
    const spec = JSON.parse(
      readFileSync(join(import.meta.dir, "python-mcp-golden.v1.json"), "utf-8"),
    ) as GoldenSpec;

    const config = ConfigSchema.parse({
      sources: [{ path: fixtureDir }],
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

    for (const check of spec.checks) {
      if (check.tool === "get_symbols") {
        const symbols = await engine.getSymbols({
          filePath: String(check.args.filePath ?? ""),
          limit: Number(check.args.limit ?? 100),
        });

        for (const expectedName of check.containsSymbols ?? []) {
          expect(symbols.some((symbol) => symbol.name === expectedName)).toBe(true);
        }

        for (const expectedKind of check.containsKinds ?? []) {
          expect(symbols.some((symbol) => symbol.kind === expectedKind)).toBe(true);
        }

        continue;
      }

      const text = await runTextTool(engine, check);

      for (const expected of check.contains ?? []) {
        expect(text).toContain(expected);
      }

      for (const excluded of check.notContains ?? []) {
        expect(text).not.toContain(excluded);
      }
    }

    await engine.close();
  });

  it("exposes python status KPIs and warm latency counters", async () => {
    const tmp = TempDir.create("ce-py-golden-status");
    dirs.push(tmp);

    const fixtureDir = join(import.meta.dir, "..", "fixtures", "python", "solid-mcp-repo");

    const config = ConfigSchema.parse({
      sources: [{ path: fixtureDir }],
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
    await engine.findImporters("pkg/base.py", { limit: 20 });
    await engine.findReferences("execute", { filePath: "pkg/base.py", limit: 20 });

    const status = await engine.status();

    expect((status.pyDependencyGraph?.internalResolutionRate ?? 0)).toBeGreaterThan(0.9);
    expect((status.pyReferenceBackends?.pythonStatic ?? 0) + (status.pyReferenceBackends?.pythonJedi ?? 0)).toBeGreaterThan(0);
    expect((status.queryLatencyMs?.getDependencies.count ?? 0)).toBeGreaterThan(0);
    expect((status.queryLatencyMs?.findImporters.count ?? 0)).toBeGreaterThan(0);
    expect((status.queryLatencyMs?.findReferences.count ?? 0)).toBeGreaterThan(0);

    await engine.close();
  });
});

async function runTextTool(engine: ContextEngine, check: GoldenCheck): Promise<string> {
  if (check.tool === "get_dependencies") {
    return engine.getDependencies(String(check.args.filePath ?? ""));
  }

  if (check.tool === "find_importers") {
    return engine.findImporters(String(check.args.target ?? ""), {
      limit: Number(check.args.limit ?? 100),
    });
  }

  if (check.tool === "find_references") {
    return engine.findReferences(String(check.args.symbol ?? ""), {
      filePath: check.args.filePath ? String(check.args.filePath) : undefined,
      includeDeclaration: check.args.includeDeclaration === undefined
        ? undefined
        : Boolean(check.args.includeDeclaration),
      limit: Number(check.args.limit ?? 100),
    });
  }

  throw new Error(`Unsupported golden tool: ${check.tool}`);
}
