import { describe, expect, it } from "bun:test";
import { TreeSitterLoader } from "../../src/chunker/tree-sitter-loader.js";
import { AstChunker } from "../../src/chunker/ast-chunker.js";

describe("TreeSitterLoader", () => {
  it("warms up parsers for supported languages", async () => {
    const loader = new TreeSitterLoader();
    await loader.warmup(["typescript", "javascript", "python"]);

    const tsReady = loader.isReady("typescript");
    const jsReady = loader.isReady("javascript");
    const pyReady = loader.isReady("python");

    expect(tsReady || jsReady || pyReady).toBe(true);
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
});
