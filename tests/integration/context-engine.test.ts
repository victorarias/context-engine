import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TempDir } from "../harness/temp-dir.js";
import { ConfigSchema } from "../../src/config.js";
import { ContextEngine } from "../../src/engine/context-engine.js";
import { LanceVectorStore } from "../../src/storage/vector-store.js";
import { SQLiteMetadataStore } from "../../src/storage/metadata-store.js";
import { WriteAheadLog } from "../../src/storage/write-log.js";

describe("ContextEngine", () => {
  const dirs: TempDir[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      dir.cleanup();
    }
  });

  it("indexes files and serves semantic search + file tools", async () => {
    const tmp = TempDir.create("ce-engine");
    dirs.push(tmp);

    const sourceDir = join(tmp.path, "repo", "src");
    mkdirSync(sourceDir, { recursive: true });

    writeFileSync(
      join(sourceDir, "auth.ts"),
      `export function authenticateUser(email: string, password: string) {
  return email.length > 0 && password.length > 0;
}
`,
    );

    writeFileSync(
      join(sourceDir, "session.ts"),
      `export class SessionManager {
  createSession(userId: string) {
    return { userId, token: 'abc' };
  }
}
`,
    );

    const config = ConfigSchema.parse({
      sources: [{ path: sourceDir }],
      dataDir: join(tmp.path, "data"),
      embedding: {
        provider: "local",
        localBackend: "mock",
        dimensions: 768,
      },
    });

    const engine = await ContextEngine.create(config);
    await engine.index();

    const files = await engine.findFiles("*.ts");
    expect(files.length).toBe(2);

    const symbols = await engine.getSymbols({ name: "SessionManager" });
    expect(symbols.length).toBeGreaterThan(0);

    const summary = await engine.getFileSummary(files.find((f) => f.endsWith("session.ts"))!);
    expect(summary).toContain("File summary for");
    expect(summary).toContain("[file]");
    expect(summary).toContain("[index]");
    expect(summary).toContain("[symbols]");
    expect(summary).toContain("File:");
    expect(summary).toContain("Language: typescript");
    expect(summary).toContain("Index state: indexed");
    expect(summary).toContain("Symbols source: indexed");
    expect(summary).toContain("Symbols:");

    const results = await engine.search("authenticate user", { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.filePath.endsWith("auth.ts"))).toBe(true);

    await engine.close();
  });

  it("falls back to live file structure when indexed metadata is missing", async () => {
    const tmp = TempDir.create("ce-engine-summary-fallback");
    dirs.push(tmp);

    const sourceDir = join(tmp.path, "repo", "src");
    mkdirSync(sourceDir, { recursive: true });

    writeFileSync(
      join(sourceDir, "delivery.go"),
      `// DeliveryManager handles Telegram message delivery.
package telegram

import (
  "context"
  "net/http"
)

type DeliveryManager struct{}

func (m *DeliveryManager) SendNow(ctx context.Context) error {
  _ = http.MethodPost
  return nil
}
`,
    );

    const config = ConfigSchema.parse({
      sources: [{ path: sourceDir }],
      dataDir: join(tmp.path, "data"),
      embedding: {
        provider: "local",
        localBackend: "mock",
        dimensions: 768,
      },
    });

    const engine = await ContextEngine.create(config);
    await engine.index();

    const metadataStore = (engine as any).metadataStore as SQLiteMetadataStore;
    const worktreeId = (engine as any).primaryWorktreeId as string;
    const entries = await metadataStore.getTreeEntries(worktreeId);
    const entry = entries.find((item) => item.path === "delivery.go");

    expect(entry).toBeDefined();

    await metadataStore.deleteBlob(entry!.blobHash);
    await metadataStore.deleteSymbolsByFile("delivery.go");

    const summary = await engine.getFileSummary("delivery.go");
    expect(summary).toContain("File summary for delivery.go");
    expect(summary).toContain("[file]");
    expect(summary).toContain("[index]");
    expect(summary).toContain("[context]");
    expect(summary).toContain("[imports]");
    expect(summary).toContain("[derived]");
    expect(summary).toContain("[symbols]");
    expect(summary).toContain("Language: go");
    expect(summary).toContain("Index state: manifest-only");
    expect(summary).toContain("Chunks: 0");
    expect(summary).toContain("Symbols: 0");
    expect(summary).toContain("Package: telegram");
    expect(summary).toContain("Doc: DeliveryManager handles Telegram message delivery.");
    expect(summary).toContain("Imports (up to 8):");
    expect(summary).toContain("- context");
    expect(summary).toContain("- net/http");
    expect(summary).toContain("Index note:");
    expect(summary).toContain("Derived chunks:");
    expect(summary).toContain("Derived symbols:");
    expect(summary).toContain("Symbols source: derived");
    expect(summary).toContain("DeliveryManager");
    expect(summary).toContain("SendNow");

    await engine.close();
  });

  it("supports semantic_search language/path filters to avoid noisy docs", async () => {
    const tmp = TempDir.create("ce-engine-search-filters");
    dirs.push(tmp);

    const sourceDir = join(tmp.path, "repo", "src");
    mkdirSync(join(sourceDir, "server", "conversation"), { recursive: true });
    mkdirSync(join(sourceDir, "docs", "codex-transcripts"), { recursive: true });

    writeFileSync(
      join(sourceDir, "server", "conversation", "service.go"),
      `package conversation

func SendMessageV2(userID string, text string) string {
  return userID + ":" + text
}
`,
    );

    writeFileSync(
      join(sourceDir, "docs", "codex-transcripts", "session.md"),
      `# Transcript

This transcript repeatedly discusses SendMessageV2 behavior and rollout notes.
`,
    );

    const config = ConfigSchema.parse({
      sources: [{ path: sourceDir }],
      dataDir: join(tmp.path, "data"),
      embedding: {
        provider: "local",
        localBackend: "mock",
        dimensions: 768,
      },
    });

    const engine = await ContextEngine.create(config);
    await engine.index();

    const goOnly = await engine.search("SendMessageV2", { limit: 10, language: "go" });
    expect(goOnly.length).toBeGreaterThan(0);
    expect(goOnly.every((result) => result.filePath.endsWith(".go"))).toBe(true);

    const patternOnly = await engine.search("SendMessageV2", { limit: 10, filePattern: "*.go" });
    expect(patternOnly.length).toBeGreaterThan(0);
    expect(patternOnly.every((result) => result.filePath.endsWith(".go"))).toBe(true);

    const codeOnly = await engine.search("SendMessageV2", { limit: 10, codeOnly: true });
    expect(codeOnly.length).toBeGreaterThan(0);
    expect(codeOnly.every((result) => !result.filePath.endsWith(".md"))).toBe(true);

    await engine.close();
  });

  it("classifies TypeScript node_modules dependencies as external", async () => {
    const tmp = TempDir.create("ce-engine-ts-node-modules");
    dirs.push(tmp);

    const sourceDir = join(tmp.path, "repo", "src");
    mkdirSync(join(sourceDir, "node_modules", "@scope", "pkg"), { recursive: true });

    writeFileSync(
      join(sourceDir, "node_modules", "@scope", "pkg", "index.d.ts"),
      "export declare function fromPkg(): string;\n",
    );

    writeFileSync(
      join(sourceDir, "util.ts"),
      "export const localValue = 1;\n",
    );

    writeFileSync(
      join(sourceDir, "app.ts"),
      `import { fromPkg } from "@scope/pkg";
import { localValue } from "./util";

export const run = () => String(fromPkg()) + "-" + String(localValue);
`,
    );

    const config = ConfigSchema.parse({
      sources: [{ path: sourceDir }],
      dataDir: join(tmp.path, "data"),
      embedding: {
        provider: "local",
        localBackend: "mock",
        dimensions: 768,
      },
    });

    const engine = await ContextEngine.create(config);
    await engine.index();

    const deps = await engine.getDependencies("app.ts");
    expect(deps).toContain("Dependency groups (heuristic):");
    expect(deps).toMatch(/Internal \(\d+\): .*util\.ts/);
    expect(deps).toMatch(/External \(\d+\): .*@scope\/pkg/);
    expect(deps).not.toMatch(/Internal \(\d+\): .*@scope\/pkg/);

    await engine.close();
  });

  it("resolves Python dependencies/importers with stdlib classification", async () => {
    const tmp = TempDir.create("ce-engine-py-deps");
    dirs.push(tmp);

    const sourceDir = join(tmp.path, "repo", "src");
    mkdirSync(join(sourceDir, "reme", "core", "schema"), { recursive: true });

    writeFileSync(join(sourceDir, "reme", "__init__.py"), "");
    writeFileSync(join(sourceDir, "reme", "core", "__init__.py"), "from .schema import MemoryNode\n");
    writeFileSync(join(sourceDir, "reme", "core", "schema", "__init__.py"), "from .memory_node import MemoryNode\n");
    writeFileSync(
      join(sourceDir, "reme", "core", "schema", "memory_node.py"),
      "class MemoryNode:\n    pass\n",
    );
    writeFileSync(
      join(sourceDir, "reme", "app.py"),
      `import sys
from pathlib import Path
from .core.schema.memory_node import MemoryNode
from pydantic import BaseModel

class App(BaseModel):
  node: MemoryNode

  def run(self):
    return self.node

print(Path('.'))
`,
    );

    const config = ConfigSchema.parse({
      sources: [{ path: sourceDir }],
      dataDir: join(tmp.path, "data"),
      embedding: {
        provider: "local",
        localBackend: "mock",
        dimensions: 768,
      },
    });

    const engine = await ContextEngine.create(config);
    await engine.index();

    const deps = await engine.getDependencies("reme/app.py");
    expect(deps).toContain("Dependencies for reme/app.py (python-semantic):");
    expect(deps).toContain("reme/core/schema/memory_node.py");
    expect(deps).toContain("Stdlib");
    expect(deps).toContain("sys");
    expect(deps).toContain("pathlib");
    expect(deps).toContain("pydantic");

    const importers = await engine.findImporters("reme/core/schema/memory_node.py");
    expect(importers).toContain("reme/app.py");
    expect(importers).toContain("reme/core/schema/__init__.py");

    const status = await engine.status();
    expect(status.capabilities?.pyDependencies).toBe("tree-sitter-resolver");
    expect((status.pyDependencyGraph?.filesIndexed ?? 0) > 0).toBe(true);

    const methodSymbols = await engine.getSymbols({ name: "run", kind: "method", limit: 10 });
    expect(methodSymbols.some((entry) => entry.filePath.endsWith("reme/app.py"))).toBe(true);

    await engine.close();
  });

  it("handles namespace package imports (PEP 420) and multiline __all__", async () => {
    const tmp = TempDir.create("ce-engine-py-namespace");
    dirs.push(tmp);

    const sourceDir = join(tmp.path, "repo", "src");
    mkdirSync(join(sourceDir, "ns_pkg", "tools"), { recursive: true });

    writeFileSync(
      join(sourceDir, "ns_pkg", "tools", "util.py"),
      `VALUE = 1
__all__ = [
  "VALUE",
]
`,
    );

    writeFileSync(
      join(sourceDir, "ns_pkg", "app.py"),
      `from ns_pkg import tools
from ns_pkg.tools import util
import ns_pkg.tools.util
`,
    );

    const config = ConfigSchema.parse({
      sources: [{ path: sourceDir }],
      dataDir: join(tmp.path, "data"),
      embedding: {
        provider: "local",
        localBackend: "mock",
        dimensions: 768,
      },
    });

    const engine = await ContextEngine.create(config);
    await engine.index();

    const deps = await engine.getDependencies("ns_pkg/app.py");
    expect(deps).toContain("Dependencies for ns_pkg/app.py (python-semantic):");
    expect(deps).toContain("ns_pkg/tools");
    expect(deps).toContain("ns_pkg/tools/util.py");
    expect(deps).toContain("Internal");

    const importers = await engine.findImporters("ns_pkg/tools");
    expect(importers).toContain("ns_pkg/app.py");

    const summary = await engine.getFileSummary("ns_pkg/tools/util.py");
    expect(summary).toContain("variable __all__");

    await engine.close();
  });

  it("resolves sys.path-assisted imports and flags conditional imports", async () => {
    const tmp = TempDir.create("ce-engine-py-syspath");
    dirs.push(tmp);

    const sourceDir = join(tmp.path, "repo", "src");
    mkdirSync(join(sourceDir, "lib"), { recursive: true });
    mkdirSync(join(sourceDir, "scripts"), { recursive: true });

    writeFileSync(join(sourceDir, "lib", "helpers.py"), "VALUE = 1\n");
    writeFileSync(
      join(sourceDir, "scripts", "main.py"),
      `import sys
sys.path.append("../lib")

try:
  import uvloop
except ImportError:
  import asyncio

import helpers
`,
    );

    const config = ConfigSchema.parse({
      sources: [{ path: sourceDir }],
      dataDir: join(tmp.path, "data"),
      embedding: {
        provider: "local",
        localBackend: "mock",
        dimensions: 768,
      },
    });

    const engine = await ContextEngine.create(config);
    await engine.index();

    const deps = await engine.getDependencies("scripts/main.py");
    expect(deps).toContain("lib/helpers.py");
    expect(deps).toContain("conditional import context");

    await engine.close();
  });

  it("filters self/non-code importer noise by default", async () => {
    const tmp = TempDir.create("ce-engine-importer-noise");
    dirs.push(tmp);

    const sourceDir = join(tmp.path, "repo", "src");
    mkdirSync(join(sourceDir, "pkg"), { recursive: true });

    writeFileSync(join(sourceDir, "pkg", "__init__.py"), "from .core import Core\n");
    writeFileSync(join(sourceDir, "pkg", "core.py"), "class Core: pass\n");
    writeFileSync(join(sourceDir, "README.md"), "from pkg import Core\n");

    const config = ConfigSchema.parse({
      sources: [{ path: sourceDir }],
      dataDir: join(tmp.path, "data"),
      embedding: {
        provider: "local",
        localBackend: "mock",
        dimensions: 768,
      },
    });

    const engine = await ContextEngine.create(config);
    await engine.index();

    const importers = await engine.findImporters("pkg/__init__.py");
    expect(importers).not.toContain("\n- pkg/__init__.py");
    expect(importers).not.toContain("\n- README.md");

    await engine.close();
  });

  it("normalizes src/ prefixed paths for python importer/reference queries", async () => {
    const tmp = TempDir.create("ce-engine-src-prefix");
    dirs.push(tmp);

    const sourceDir = join(tmp.path, "repo");
    mkdirSync(join(sourceDir, "reme", "core", "op"), { recursive: true });

    writeFileSync(join(sourceDir, "reme", "__init__.py"), "");
    writeFileSync(join(sourceDir, "reme", "core", "__init__.py"), "");
    writeFileSync(join(sourceDir, "reme", "core", "op", "base.py"), "class Base:\n    def execute(self):\n        return 1\n");
    writeFileSync(join(sourceDir, "reme", "core", "op", "impl.py"), "from .base import Base\nclass Impl(Base):\n    def execute(self):\n        return 2\n");

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

    const importers = await engine.findImporters("src/reme/core/op/base.py");
    expect(importers).toContain("reme/core/op/impl.py");

    const refs = await engine.findReferences("execute", {
      filePath: "src/reme/core/op/base.py",
      limit: 10,
    });
    expect(refs).not.toContain("Python file not found on disk");
    expect(refs).toContain("reme/core/op/impl.py");

    const missingImporters = await engine.findImporters("src/reme/core/op/implx.py");
    expect(missingImporters).toContain("Hint: Did you mean");

    await engine.close();
  });

  it("hydrates TS dependency graph from existing metadata on restart", async () => {
    const tmp = TempDir.create("ce-engine-ts-hydrate");
    dirs.push(tmp);

    const sourceDir = join(tmp.path, "repo", "src");
    mkdirSync(sourceDir, { recursive: true });

    writeFileSync(
      join(sourceDir, "a.ts"),
      `export function hello() { return "hi"; }
`,
    );
    writeFileSync(
      join(sourceDir, "b.ts"),
      `import { hello } from "./a";
export const value = hello();
`,
    );

    const config = ConfigSchema.parse({
      sources: [{ path: sourceDir }],
      dataDir: join(tmp.path, "data"),
      embedding: {
        provider: "local",
        localBackend: "mock",
        dimensions: 768,
      },
    });

    const engine1 = await ContextEngine.create(config);
    await engine1.index();
    await engine1.close();

    const engine2 = await ContextEngine.create(config);

    const status = await engine2.status();
    expect(status.tsDependencyGraph?.filesIndexed ?? 0).toBeGreaterThan(0);

    const refs = await engine2.findReferences("hello", {
      filePath: "a.ts",
      limit: 10,
    });

    expect(refs).toContain("Requested backend: tsserver");
    expect(refs).toContain("Actual backend: tsserver");
    expect(refs).toContain("b.ts:2:22");

    await engine2.close();
  });

  it("resolves TypeScript references with compiler backend", async () => {
    const tmp = TempDir.create("ce-engine-ts-refs");
    dirs.push(tmp);

    const sourceDir = join(tmp.path, "repo", "src");
    mkdirSync(sourceDir, { recursive: true });

    writeFileSync(
      join(sourceDir, "a.ts"),
      `export function greet(name: string) {
  return ` + "`hi ${name}`" + `;
}

export function localCall() {
  return greet("local");
}
`,
    );

    writeFileSync(
      join(sourceDir, "b.ts"),
      `import { greet } from "./a";

export function remoteCall() {
  return greet("remote");
}
`,
    );

    const config = ConfigSchema.parse({
      sources: [{ path: sourceDir }],
      dataDir: join(tmp.path, "data"),
      embedding: {
        provider: "local",
        localBackend: "mock",
        dimensions: 768,
      },
    });

    const engine = await ContextEngine.create(config);
    await engine.index();

    const refs = await engine.findReferences("greet", {
      filePath: "a.ts",
      limit: 20,
    });

    expect(refs).toContain("Requested backend: tsserver");
    expect(refs).toContain("Actual backend: tsserver");
    expect(refs).toContain("a.ts:6:10");
    expect(refs).toContain("b.ts:4:10");

    await engine.close();
  });

  it("resolves tsconfig extends/paths/project-references dependencies", async () => {
    const tmp = TempDir.create("ce-engine-tsconfig-fixtures");
    dirs.push(tmp);

    const repoDir = join(tmp.path, "repo");
    mkdirSync(join(repoDir, "shared"), { recursive: true });
    mkdirSync(join(repoDir, "packages", "lib", "src"), { recursive: true });
    mkdirSync(join(repoDir, "packages", "app", "src"), { recursive: true });

    writeFileSync(
      join(repoDir, "tsconfig.base.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          baseUrl: ".",
          paths: {
            "@shared/*": ["shared/*"],
            "@lib/*": ["packages/lib/src/*"],
          },
        },
      }, null, 2),
    );

    writeFileSync(
      join(repoDir, "packages", "lib", "tsconfig.json"),
      JSON.stringify({
        extends: "../../tsconfig.base.json",
        compilerOptions: {
          composite: true,
          rootDir: "src",
          outDir: "dist",
        },
        include: ["src/**/*"],
      }, null, 2),
    );

    writeFileSync(
      join(repoDir, "packages", "app", "tsconfig.json"),
      JSON.stringify({
        extends: "../../tsconfig.base.json",
        references: [{ path: "../lib" }],
        compilerOptions: {
          rootDir: "src",
          outDir: "dist",
        },
        include: ["src/**/*"],
      }, null, 2),
    );

    writeFileSync(join(repoDir, "shared", "math.ts"), "export const plus = (a: number, b: number) => a + b;\n");
    writeFileSync(
      join(repoDir, "packages", "lib", "src", "add.ts"),
      "import { plus } from '@shared/math';\nexport const add = plus;\n",
    );
    writeFileSync(
      join(repoDir, "packages", "app", "src", "run.ts"),
      "import { add } from '@lib/add';\nexport const run = () => add(1, 2);\n",
    );
    writeFileSync(
      join(repoDir, "packages", "app", "src", "broken.ts"),
      "import { missing } from './missing';\nexport const nope = missing;\n",
    );

    const config = ConfigSchema.parse({
      sources: [{ path: repoDir }],
      dataDir: join(tmp.path, "data"),
      embedding: {
        provider: "local",
        localBackend: "mock",
        dimensions: 768,
      },
    });

    const engine = await ContextEngine.create(config);
    await engine.index();

    const appDeps = await engine.getDependencies("packages/app/src/run.ts");
    expect(appDeps).toContain("packages/lib/src/add.ts");

    const libDeps = await engine.getDependencies("packages/lib/src/add.ts");
    expect(libDeps).toContain("shared/math.ts");

    const brokenDeps = await engine.getDependencies("packages/app/src/broken.ts");
    expect(brokenDeps).toContain("unresolved: module could not be resolved");

    await engine.close();
  });

  it("finds go importers when go.mod lives in a subdirectory", async () => {
    const tmp = TempDir.create("ce-engine-go-submodule");
    dirs.push(tmp);

    const repoDir = join(tmp.path, "repo");
    const serverDir = join(repoDir, "server");
    const llmDir = join(serverDir, "internal", "llm");
    const conversationDir = join(serverDir, "internal", "conversation");

    mkdirSync(llmDir, { recursive: true });
    mkdirSync(conversationDir, { recursive: true });

    writeFileSync(join(serverDir, "go.mod"), "module example.com/subrepo\n\ngo 1.22\n");
    writeFileSync(join(llmDir, "service.go"), "package llm\n\nfunc New() int { return 1 }\n");
    writeFileSync(
      join(conversationDir, "service.go"),
      "package conversation\n\nimport \"example.com/subrepo/internal/llm\"\n\nvar _ = llm.New\n",
    );

    const config = ConfigSchema.parse({
      sources: [{ path: repoDir }],
      dataDir: join(tmp.path, "data"),
      embedding: {
        provider: "local",
        localBackend: "mock",
        dimensions: 768,
      },
    });

    const engine = await ContextEngine.create(config);
    await engine.index();

    const importers = await engine.findImporters("server/internal/llm");
    expect(importers).toContain("server/internal/conversation/service.go");

    await engine.close();
  });

  it("parses Go dependencies and reference queries", async () => {
    const tmp = TempDir.create("ce-engine-go");
    dirs.push(tmp);

    const sourceDir = join(tmp.path, "repo", "src");
    mkdirSync(join(sourceDir, "service"), { recursive: true });
    mkdirSync(join(sourceDir, "cmd"), { recursive: true });

    writeFileSync(join(sourceDir, "go.mod"), "module example.com/ce-go\n\ngo 1.22\n");

    writeFileSync(
      join(sourceDir, "service", "service.go"),
      `package service

import (
  "context"
  "encoding/json"
  "fmt"
)

// Service is used in reference lookup tests.
// keep comment above type to test identifier anchoring.
type Service struct{}

func (s *Service) Start(ctx context.Context) {
  fmt.Println(ctx)
  _ = json.Valid([]byte("{}"))
}

func Use(s *Service, ctx context.Context) {
  s.Start(ctx)
}
`,
    );

    writeFileSync(
      join(sourceDir, "cmd", "main.go"),
      `package main

import (
  "context"
  "example.com/ce-go/service"
)

func main() {
  svc := &service.Service{}
  service.Use(svc, context.Background())
}
`,
    );

    const config = ConfigSchema.parse({
      sources: [{ path: sourceDir }],
      dataDir: join(tmp.path, "data"),
      embedding: {
        provider: "local",
        localBackend: "mock",
        dimensions: 768,
      },
    });

    const engine = await ContextEngine.create(config);
    await engine.index();

    const deps = await engine.getDependencies("service/service.go");
    expect(deps).toContain("context");
    expect(deps).toContain("fmt");
    expect(deps).toContain("encoding/json");
    expect(deps).toContain("Dependency groups (heuristic):");
    expect(deps).toContain("Stdlib");
    expect(deps).toContain("- Internal (0)");
    expect(deps).not.toContain("Internal (1): encoding/json");

    const cmdDeps = await engine.getDependencies("cmd/main.go");
    expect(cmdDeps).toContain("example.com/ce-go/service");
    expect(cmdDeps).toContain("Stdlib");
    expect(cmdDeps).toContain("Internal (1): example.com/ce-go/service");

    const goImporters = await engine.findImporters("service/service.go");
    expect(goImporters).toContain("cmd/main.go");

    const refs = await engine.findReferences("Start", {
      filePath: "service/service.go",
      includeContext: true,
      contextLines: 1,
      limit: 10,
    });
    expect(refs).toContain("References for Start");
    expect(refs).toContain("Requested backend: gopls");
    if (refs.includes("Actual backend: gopls")) {
      expect(refs).toContain("References (with context):");
      expect(refs).toMatch(/>\s+\d+:\s+s\.Start\(ctx\)/);
    } else {
      expect(refs).toContain("Actual backend: heuristic");
    }

    const typeRefs = await engine.findReferences("Service", { filePath: "service/service.go", limit: 10 });
    expect(typeRefs).toContain("Requested backend: gopls");

    const ambiguous = await engine.findReferences("Sta", { limit: 10 });
    expect(ambiguous).toContain("Actual backend: heuristic");
    expect(ambiguous).toContain("Candidate declarations:");
    expect(ambiguous).toMatch(/Guidance:/);
    expect(ambiguous).toMatch(/filePath/);

    const staleSymbol = await engine.findReferences("StartV2", { filePath: "service/service.go", limit: 10 });
    expect(staleSymbol).toContain("symbol 'StartV2' was not found in service/service.go");
    expect(staleSymbol).toContain("Did you mean:");
    expect(staleSymbol).toContain("Start");

    await engine.close();
  });

  it("suggests nearby files and supports directory dependency scans", async () => {
    const tmp = TempDir.create("ce-engine-deps");
    dirs.push(tmp);

    const sourceDir = join(tmp.path, "repo", "src");
    mkdirSync(join(sourceDir, "features", "assistant"), { recursive: true });
    mkdirSync(join(sourceDir, "features", "unified"), { recursive: true });

    writeFileSync(
      join(sourceDir, "features", "assistant", "ChatPanel.tsx"),
      "import UnifiedScreen from '../unified/UnifiedScreen';\nexport const ChatPanel = () => UnifiedScreen;\n",
    );
    writeFileSync(
      join(sourceDir, "features", "unified", "UnifiedScreen.tsx"),
      "export default function UnifiedScreen() { return null; }\n",
    );

    const config = ConfigSchema.parse({
      sources: [{ path: sourceDir }],
      dataDir: join(tmp.path, "data"),
      embedding: {
        provider: "local",
        localBackend: "mock",
        dimensions: 768,
      },
    });

    const engine = await ContextEngine.create(config);
    await engine.index();

    const missing = await engine.getDependencies("features/assistant/Chat.tsx");
    expect(missing).toContain("File not found for dependency scan");
    expect(missing).toContain("Files in features/assistant");
    expect(missing).toContain("ChatPanel.tsx");

    const dirDeps = await engine.getDependencies("features", { recursive: true, maxFiles: 20 });
    expect(dirDeps).toContain("Dependencies for directory features");
    expect(dirDeps).toContain("features/unified/UnifiedScreen");

    const importers = await engine.findImporters("features/unified/UnifiedScreen");
    expect(importers).toContain("Importers for");
    expect(importers).toContain("features/assistant/ChatPanel.tsx");

    await engine.close();
  });

  it("reindexes changed files and removes deleted files", async () => {
    const tmp = TempDir.create("ce-engine-reindex");
    dirs.push(tmp);

    const sourceDir = join(tmp.path, "repo", "src");
    mkdirSync(sourceDir, { recursive: true });

    const fileA = join(sourceDir, "a.ts");
    const fileB = join(sourceDir, "b.ts");

    writeFileSync(fileA, "export const alpha = () => 'alpha';\n");
    writeFileSync(fileB, "export const beta = () => 'beta';\n");

    const config = ConfigSchema.parse({
      sources: [{ path: sourceDir }],
      dataDir: join(tmp.path, "data"),
      embedding: {
        provider: "local",
        localBackend: "mock",
        dimensions: 768,
      },
    });

    const engine = await ContextEngine.create(config);
    await engine.index();

    let results = await engine.search("alpha", { limit: 10 });
    expect(results.some((r) => r.filePath.endsWith("a.ts"))).toBe(true);

    // change file A
    writeFileSync(fileA, "export const alpha = () => 'alpha v2 with token refresh';\n");
    await engine.index();

    results = await engine.search("token refresh", { limit: 10 });
    expect(results.some((r) => r.filePath.endsWith("a.ts"))).toBe(true);

    // delete file B
    rmSync(fileB);
    await engine.index();

    const files = await engine.findFiles("*.ts");
    expect(files.some((f) => f.endsWith("b.ts"))).toBe(false);

    await engine.close();
  });

  it("supports local onnx backend with fallback", async () => {
    const tmp = TempDir.create("ce-engine-onnx");
    dirs.push(tmp);

    const sourceDir = join(tmp.path, "repo", "src");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "hello.ts"), "export const hello = () => 'world';\n");

    const config = ConfigSchema.parse({
      sources: [{ path: sourceDir }],
      dataDir: join(tmp.path, "data"),
      embedding: {
        provider: "local",
        localBackend: "onnx",
        model: "invalid/non-existent-model",
        dimensions: 64,
        fallbackToMock: true,
      },
    });

    const engine = await ContextEngine.create(config);
    await engine.index();

    const status = await engine.status();
    expect(status.embeddingModel.startsWith("local-onnx/") || status.embeddingModel.includes("local-mock/worker")).toBe(true);

    const results = await engine.search("hello", { limit: 3 });
    expect(results.length).toBeGreaterThan(0);

    await engine.close();
  });

  it("reconciles pending write-log entries on startup", async () => {
    const tmp = TempDir.create("ce-engine-reconcile");
    dirs.push(tmp);

    const sourceDir = join(tmp.path, "repo", "src");
    mkdirSync(sourceDir, { recursive: true });

    const dataDir = join(tmp.path, "data");
    const metadata = new SQLiteMetadataStore({ path: join(dataDir, "metadata.db") });
    const vectors = new LanceVectorStore({ uri: join(dataDir, "lancedb"), vectorDimensions: 128 });
    const wal = new WriteAheadLog(metadata.getDatabase());

    // simulate crash: vector written, metadata not written, WAL left pending
    await vectors.upsert(
      [new Float32Array(new Array(128).fill(0).map((_, i) => (i === 0 ? 1 : 0)))],
      [
        {
          id: "orphan-chunk",
          content: "orphan",
          filePath: "src/orphan.ts",
          startLine: 1,
          endLine: 1,
          language: "typescript",
          repoId: "repo",
        },
      ],
    );
    const writeId = await wal.beginIntent("upsert", ["orphan-chunk"]);
    await wal.markLanceOk(writeId);

    await vectors.close();
    await metadata.close();

    const config = ConfigSchema.parse({
      sources: [{ path: sourceDir }],
      dataDir,
      embedding: {
        provider: "local",
        localBackend: "mock",
        dimensions: 768,
      },
    });

    const engine = await ContextEngine.create(config);
    const status = await engine.status();

    // orphan chunk should be removed during reconcile
    expect(status.repos[0].chunksStored).toBe(0);

    await engine.close();
  });
});
