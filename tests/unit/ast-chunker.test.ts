import { describe, expect, it } from "bun:test";
import { AstChunker } from "../../src/chunker/ast-chunker.js";
import { HybridChunker } from "../../src/chunker/chunker.js";

describe("AstChunker", () => {
  it("extracts TypeScript symbols as semantic chunks", () => {
    const chunker = new AstChunker();
    const source = `
export interface User { id: string }

export type Token = { value: string }

export class SessionManager {
  createSession(userId: string) {
    return { userId };
  }
}

export function authenticateUser(email: string, pass: string) {
  return email.length > 0 && pass.length > 0;
}
`;

    const chunks = chunker.chunk(source, "src/auth.ts", "typescript", "repo1");

    const symbols = chunks.map((c) => `${c.symbolKind}:${c.symbolName}`);
    expect(symbols).toContain("interface:User");
    expect(symbols).toContain("type:Token");
    expect(symbols).toContain("class:SessionManager");
    expect(symbols).toContain("method:createSession");
    expect(symbols).toContain("function:authenticateUser");

    const method = chunks.find((c) => c.symbolKind === "method" && c.symbolName === "createSession");
    expect(method?.parentSymbol).toBe("SessionManager");
  });

  it("extracts Python class/function chunks", () => {
    const chunker = new AstChunker();
    const source = `
class SessionManager:
    def create_session(self, user_id):
        return {"user_id": user_id}

def authenticate_user(email, password):
    return len(email) > 0
`;

    const chunks = chunker.chunk(source, "src/auth.py", "python", "repo1");
    const symbols = chunks.map((c) => `${c.symbolKind}:${c.symbolName}`);

    expect(symbols).toContain("class:SessionManager");
    expect(symbols).toContain("function:create_session");
    expect(symbols).toContain("function:authenticate_user");
  });
});

describe("HybridChunker", () => {
  it("falls back to text chunking for unsupported language", () => {
    const chunker = new HybridChunker();
    const source = "line1\nline2\nline3\nline4\nline5";

    const chunks = chunker.chunk(source, "README.md", "markdown", "repo1");

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].symbolName).toBeUndefined();
  });
});
