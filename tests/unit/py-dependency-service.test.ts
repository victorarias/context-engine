import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TempDir } from "../harness/temp-dir.js";
import { PyDependencyService } from "../../src/engine/py-dependency-service.js";

describe("PyDependencyService", () => {
  const dirs: TempDir[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      dir.cleanup();
    }
  });

  it("resolves relative imports and builds reverse importers", async () => {
    const tmp = TempDir.create("py-deps-service");
    dirs.push(tmp);

    const root = join(tmp.path, "repo", "src");
    mkdirSync(join(root, "pkg", "core", "schema"), { recursive: true });

    writeFileSync(join(root, "pkg", "__init__.py"), "");
    writeFileSync(join(root, "pkg", "core", "__init__.py"), "");
    writeFileSync(join(root, "pkg", "core", "schema", "__init__.py"), "from .memory_node import MemoryNode\n");
    writeFileSync(join(root, "pkg", "core", "schema", "memory_node.py"), "class MemoryNode: pass\n");
    writeFileSync(
      join(root, "pkg", "app.py"),
      `from .core.schema.memory_node import MemoryNode
from pathlib import Path
from pydantic import BaseModel
`,
    );

    const svc = new PyDependencyService([root]);
    await svc.warmup();

    svc.rebuild([
      "pkg/__init__.py",
      "pkg/core/__init__.py",
      "pkg/core/schema/__init__.py",
      "pkg/core/schema/memory_node.py",
      "pkg/app.py",
    ]);

    const appEdges = svc.getFileEdges("pkg/app.py");
    expect(appEdges.some((edge) => edge.resolvedTarget === "pkg/core/schema/memory_node.py")).toBe(true);
    expect(appEdges.some((edge) => edge.rawSpecifier === "pathlib")).toBe(true);

    const importers = svc.findImporters("pkg/core/schema/memory_node.py", { limit: 20 });
    expect(importers).toContain("pkg/app.py");
    expect(importers).toContain("pkg/core/schema/__init__.py");

    const stats = svc.getStats();
    expect(stats.filesIndexed).toBe(5);
    expect(stats.edgesTotal).toBeGreaterThan(0);
  });

  it("handles namespace packages (PEP 420) without __init__.py", async () => {
    const tmp = TempDir.create("py-deps-namespace");
    dirs.push(tmp);

    const root = join(tmp.path, "repo");
    mkdirSync(join(root, "ns_pkg", "tools"), { recursive: true });

    writeFileSync(join(root, "ns_pkg", "tools", "util.py"), "VALUE = 1\n");
    writeFileSync(
      join(root, "ns_pkg", "app.py"),
      "from ns_pkg import tools\nfrom ns_pkg.tools import util\nimport ns_pkg.tools.util\n",
    );

    const svc = new PyDependencyService([root]);
    await svc.warmup();
    svc.rebuild([
      "ns_pkg/tools/util.py",
      "ns_pkg/app.py",
    ]);

    const appEdges = svc.getFileEdges("ns_pkg/app.py");
    expect(appEdges.some((edge) => edge.rawSpecifier === "ns_pkg.tools" && edge.resolvedTarget === "ns_pkg/tools")).toBe(true);
    expect(appEdges.some((edge) => edge.rawSpecifier === "ns_pkg.tools.util" && edge.resolvedTarget === "ns_pkg/tools/util.py")).toBe(true);

    const nsImporters = svc.findImporters("ns_pkg/tools", { limit: 10 });
    expect(nsImporters).toContain("ns_pkg/app.py");
  });

  it("resolves imports via sys.path literal hints", async () => {
    const tmp = TempDir.create("py-deps-syspath");
    dirs.push(tmp);

    const root = join(tmp.path, "repo", "src");
    mkdirSync(join(root, "lib"), { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });

    writeFileSync(join(root, "lib", "helpers.py"), "VALUE = 1\n");
    writeFileSync(
      join(root, "scripts", "main.py"),
      `import sys
sys.path.append("../lib")
import helpers
`,
    );

    const svc = new PyDependencyService([root]);
    await svc.warmup();
    svc.rebuild([
      "lib/helpers.py",
      "scripts/main.py",
    ]);

    const edges = svc.getFileEdges("scripts/main.py");
    expect(edges.some((edge) => edge.rawSpecifier === "helpers" && edge.resolvedTarget === "lib/helpers.py")).toBe(true);
    expect(edges.some((edge) => edge.rawSpecifier === "helpers" && edge.unresolvedReason?.includes("sys.path hint"))).toBe(true);
  });

  it("marks conditional imports with downgraded confidence", async () => {
    const tmp = TempDir.create("py-deps-conditional");
    dirs.push(tmp);

    const root = join(tmp.path, "repo");
    mkdirSync(join(root, "pkg"), { recursive: true });

    writeFileSync(join(root, "pkg", "__init__.py"), "");
    writeFileSync(
      join(root, "pkg", "app.py"),
      `try:
    import uvloop
except ImportError:
    import asyncio
`,
    );

    const svc = new PyDependencyService([root]);
    await svc.warmup();
    svc.rebuild([
      "pkg/__init__.py",
      "pkg/app.py",
    ]);

    const edges = svc.getFileEdges("pkg/app.py");
    const uvloopEdge = edges.find((edge) => edge.rawSpecifier === "uvloop");
    const asyncioEdge = edges.find((edge) => edge.rawSpecifier === "asyncio");

    expect(uvloopEdge?.confidence).toBe("low");
    expect(uvloopEdge?.unresolvedReason?.includes("conditional import context")).toBe(true);

    expect(asyncioEdge?.confidence).toBe("low");
    expect(asyncioEdge?.unresolvedReason?.includes("conditional import context")).toBe(true);
  });

  it("supports dotted-module lookup for importer queries", async () => {
    const tmp = TempDir.create("py-deps-service-dotted");
    dirs.push(tmp);

    const root = join(tmp.path, "repo");
    mkdirSync(join(root, "demo", "sub"), { recursive: true });

    writeFileSync(join(root, "demo", "__init__.py"), "");
    writeFileSync(join(root, "demo", "sub", "__init__.py"), "");
    writeFileSync(join(root, "demo", "sub", "mod.py"), "CONST = 1\n");
    writeFileSync(join(root, "demo", "main.py"), "from .sub.mod import CONST\n");

    const svc = new PyDependencyService([root]);
    await svc.warmup();
    svc.rebuild([
      "demo/__init__.py",
      "demo/sub/__init__.py",
      "demo/sub/mod.py",
      "demo/main.py",
    ]);

    const dotted = svc.findImporters("demo.sub.mod", { limit: 10 });
    expect(dotted).toContain("demo/main.py");
  });
});
