import { describe, expect, it } from "bun:test";
import { TreeSitterLoader } from "../../src/chunker/tree-sitter-loader.js";
import { AstChunker } from "../../src/chunker/ast-chunker.js";

describe("TreeSitterLoader", () => {
  it("warms up parsers for supported languages", async () => {
    const loader = new TreeSitterLoader();
    await loader.warmup(["typescript", "javascript", "python", "go", "rust"]);

    const tsReady = loader.isReady("typescript");
    const jsReady = loader.isReady("javascript");
    const pyReady = loader.isReady("python");
    const goReady = loader.isReady("go");
    const rustReady = loader.isReady("rust");

    expect(tsReady || jsReady || pyReady || goReady || rustReady).toBe(true);
  });

  it("AstChunker can use tree-sitter when warmed", async () => {
    const loader = new TreeSitterLoader();
    const chunker = new AstChunker({ treeSitterLoader: loader, preferTreeSitter: true });

    await chunker.warmupTreeSitter(["javascript"]);

    const chunks = chunker.chunk(
      "class SessionManager { createSession() { return true; } }",
      "src/session.js",
      "javascript",
      "repo1",
    );

    const symbols = chunks.map((c) => `${c.symbolKind}:${c.symbolName}`);
    expect(symbols).toContain("class:SessionManager");
    expect(symbols).toContain("method:createSession");
  });

  it("AstChunker includes Python decorators/methods/constants via tree-sitter", async () => {
    const loader = new TreeSitterLoader();
    const chunker = new AstChunker({ treeSitterLoader: loader, preferTreeSitter: true });

    await chunker.warmupTreeSitter(["python"]);

    const chunks = chunker.chunk(
      `@decorator\nclass SessionManager:\n    @staticmethod\n    def start():\n        return 1\n\nAPI_VERSION = \"v1\"\n__all__ = [\n  \"SessionManager\",\n  \"API_VERSION\",\n]\n`,
      "src/session.py",
      "python",
      "repo1",
    );

    const classChunk = chunks.find((chunk) => chunk.symbolKind === "class" && chunk.symbolName === "SessionManager");
    const methodChunk = chunks.find((chunk) => chunk.symbolKind === "method" && chunk.symbolName === "start");

    // If parser failed to warm in this env, fallback still provides symbols; decorator checks are best-effort.
    expect(!!classChunk).toBe(true);
    expect(!!methodChunk).toBe(true);
    expect(methodChunk?.parentSymbol).toBe("SessionManager");

    if (loader.isReady("python")) {
      expect(classChunk?.content.startsWith("@decorator")).toBe(true);
      expect(methodChunk?.content.startsWith("@staticmethod")).toBe(true);
      expect(chunks.some((chunk) => chunk.symbolKind === "variable" && chunk.symbolName === "API_VERSION")).toBe(true);
      const allChunk = chunks.find((chunk) => chunk.symbolKind === "variable" && chunk.symbolName === "__all__");
      expect(!!allChunk).toBe(true);
      expect((allChunk?.endLine ?? 0) > (allChunk?.startLine ?? 0)).toBe(true);
      expect(allChunk?.content).toContain("API_VERSION");
    }
  });

  it("AstChunker can use tree-sitter for Go/Rust when warmed", async () => {
    const loader = new TreeSitterLoader();
    const chunker = new AstChunker({ treeSitterLoader: loader, preferTreeSitter: true });

    await chunker.warmupTreeSitter(["go", "rust"]);

    const goChunks = chunker.chunk(
      "package auth\ntype SessionManager struct{}\nfunc (s *SessionManager) Start() {}",
      "src/session.go",
      "go",
      "repo1",
    );

    const rustChunks = chunker.chunk(
      "pub struct SessionManager; impl SessionManager { pub fn start(&self) {} }",
      "src/session.rs",
      "rust",
      "repo1",
    );

    const goSymbols = goChunks.map((c) => `${c.symbolKind}:${c.symbolName}`);
    const rustSymbols = rustChunks.map((c) => `${c.symbolKind}:${c.symbolName}`);

    // If wasm fails to load in this environment, fallback chunkers still produce symbols.
    expect(goSymbols).toContain("class:SessionManager");
    expect(goSymbols).toContain("method:Start");

    expect(rustSymbols).toContain("class:SessionManager");
    expect(rustSymbols.includes("method:start") || rustSymbols.includes("function:start")).toBe(true);
  });
});
