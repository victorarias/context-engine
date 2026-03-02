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

  it("parses Go dependencies and reference queries", async () => {
    const tmp = TempDir.create("ce-engine-go");
    dirs.push(tmp);

    const sourceDir = join(tmp.path, "repo", "src");
    mkdirSync(sourceDir, { recursive: true });

    writeFileSync(join(sourceDir, "go.mod"), "module example.com/ce-go\n\ngo 1.22\n");

    writeFileSync(
      join(sourceDir, "service.go"),
      `package service

import (
  "context"
  "fmt"
)

type Service struct{}

func (s *Service) Start(ctx context.Context) {
  fmt.Println(ctx)
}

func Use(s *Service, ctx context.Context) {
  s.Start(ctx)
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

    const deps = await engine.getDependencies("service.go");
    expect(deps).toContain("context");
    expect(deps).toContain("fmt");

    const refs = await engine.findReferences("Start", { filePath: "service.go", limit: 10 });
    expect(refs).toContain("References for Start");
    expect(refs).toContain("Requested backend: gopls");

    const ambiguous = await engine.findReferences("Sta", { limit: 10 });
    expect(ambiguous).toContain("Actual backend: none");
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
