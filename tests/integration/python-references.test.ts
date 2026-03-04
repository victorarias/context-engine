import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TempDir } from "../harness/temp-dir.js";
import { ConfigSchema } from "../../src/config.js";
import { ContextEngine } from "../../src/engine/context-engine.js";

describe("Python reference backends", () => {
  const dirs: TempDir[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      dir.cleanup();
    }
  });

  it("uses python-static backend for anchored python reference queries", async () => {
    const tmp = TempDir.create("ce-python-refs-static");
    dirs.push(tmp);

    const sourceDir = join(tmp.path, "repo", "src");
    mkdirSync(join(sourceDir, "pkg"), { recursive: true });

    writeFileSync(join(sourceDir, "pkg", "__init__.py"), "");
    writeFileSync(
      join(sourceDir, "pkg", "base.py"),
      `class BaseOp:\n    def execute(self, x):\n        return x\n`,
    );
    writeFileSync(
      join(sourceDir, "pkg", "runner.py"),
      `from .base import BaseOp\n\n\ndef run():\n    op = BaseOp()\n    return op.execute(123)\n`,
    );
    writeFileSync(
      join(sourceDir, "pkg", "child.py"),
      `from .base import BaseOp\n\n\nclass ChildOp(BaseOp):\n    def execute(self, x):\n        return x + 1\n`,
    );
    writeFileSync(
      join(sourceDir, "pkg", "notes.md"),
      "execute execute execute\n",
    );

    const config = ConfigSchema.parse({
      sources: [{ path: sourceDir }],
      dataDir: join(tmp.path, "data"),
      embedding: {
        provider: "local",
        localBackend: "mock",
        dimensions: 768,
      },
      python: {
        referencesBackend: "static",
      },
    });

    const engine = await ContextEngine.create(config);
    await engine.index();

    const refs = await engine.findReferences("execute", {
      filePath: "pkg/base.py",
      limit: 20,
    });

    expect(refs).toContain("Requested backend: python-static");
    expect(refs).toContain("Actual backend: python-static");
    expect(refs).toContain("pkg/runner.py");
    expect(refs).toContain("pkg/child.py");
    expect(refs).toContain("[override]");
    expect(refs).not.toContain("notes.md");

    await engine.close();
  });

  it("uses static-first policy for unanchored auto python queries", async () => {
    const tmp = TempDir.create("ce-python-refs-auto-unanchored");
    dirs.push(tmp);

    const sourceDir = join(tmp.path, "repo", "src");
    mkdirSync(join(sourceDir, "pkg"), { recursive: true });

    writeFileSync(join(sourceDir, "pkg", "base.py"), "class A:\n    def run(self):\n        return 1\n");
    writeFileSync(join(sourceDir, "pkg", "use.py"), "from .base import A\nA().run()\n");

    const config = ConfigSchema.parse({
      sources: [{ path: sourceDir }],
      dataDir: join(tmp.path, "data"),
      embedding: {
        provider: "local",
        localBackend: "mock",
        dimensions: 768,
      },
      python: {
        referencesBackend: "auto",
      },
    });

    const engine = await ContextEngine.create(config);
    await engine.index();

    const refs = await engine.findReferences("run", { limit: 20 });
    expect(refs).toContain("Requested backend: python-static");

    const status = await engine.status();
    expect(status.pyReferenceBackends?.pythonJedi ?? 0).toBe(0);

    await engine.close();
  });

  it("reports python reference backend usage in status", async () => {
    const tmp = TempDir.create("ce-python-refs-status");
    dirs.push(tmp);

    const sourceDir = join(tmp.path, "repo", "src");
    mkdirSync(join(sourceDir, "pkg"), { recursive: true });

    writeFileSync(join(sourceDir, "pkg", "base.py"), "class A:\n    def run(self):\n        return 1\n");
    writeFileSync(join(sourceDir, "pkg", "use.py"), "from .base import A\nA().run()\n");

    const config = ConfigSchema.parse({
      sources: [{ path: sourceDir }],
      dataDir: join(tmp.path, "data"),
      embedding: {
        provider: "local",
        localBackend: "mock",
        dimensions: 768,
      },
      python: {
        referencesBackend: "auto",
      },
    });

    const engine = await ContextEngine.create(config);
    await engine.index();

    await engine.findReferences("run", {
      filePath: "pkg/base.py",
      limit: 10,
    });

    const status = await engine.status();
    expect(status.pyReferenceBackends).toBeDefined();
    expect((status.pyReferenceBackends?.pythonStatic ?? 0) + (status.pyReferenceBackends?.pythonJedi ?? 0)).toBeGreaterThan(0);

    const backendTotals = (status.pyReferenceBackends?.pythonStatic ?? 0)
      + (status.pyReferenceBackends?.pythonJedi ?? 0)
      + (status.pyReferenceBackends?.heuristic ?? 0)
      + (status.pyReferenceBackends?.none ?? 0);
    expect(backendTotals).toBe(1);

    await engine.close();
  });
});
