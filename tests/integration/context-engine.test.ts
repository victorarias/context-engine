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
    expect(summary).toContain("File:");
    expect(summary).toContain("Symbols:");

    const results = await engine.search("authenticate user", { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.filePath.endsWith("auth.ts"))).toBe(true);

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
  "fmt"
)

// Service is used in reference lookup tests.
// keep comment above type to test identifier anchoring.
type Service struct{}

func (s *Service) Start(ctx context.Context) {
  fmt.Println(ctx)
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

    const goImporters = await engine.findImporters("service/service.go");
    expect(goImporters).toContain("cmd/main.go");

    const refs = await engine.findReferences("Start", { filePath: "service/service.go", limit: 10 });
    expect(refs).toContain("References for Start");
    expect(refs).toContain("Requested backend: gopls");

    const typeRefs = await engine.findReferences("Service", { filePath: "service/service.go", limit: 10 });
    expect(typeRefs).toContain("Requested backend: gopls");
    expect(typeRefs).not.toContain("gopls failed");

    const ambiguous = await engine.findReferences("Sta", { limit: 10 });
    expect(ambiguous).toContain("Actual backend: heuristic");
    expect(ambiguous).toContain("Candidate declarations:");
    expect(ambiguous).toContain("Guidance: Provide `filePath`");

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
