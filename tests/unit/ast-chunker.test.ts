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

  it("extracts Go symbols", () => {
    const chunker = new AstChunker({ preferTreeSitter: false });
    const source = `
package auth

type SessionManager struct{}
type Runner interface { Run() }

func NewSessionManager() *SessionManager { return &SessionManager{} }
func (s *SessionManager) Start() {}
`;

    const chunks = chunker.chunk(source, "src/auth.go", "go", "repo1");
    const symbols = chunks.map((c) => `${c.symbolKind}:${c.symbolName}`);

    expect(symbols).toContain("class:SessionManager");
    expect(symbols).toContain("interface:Runner");
    expect(symbols).toContain("function:NewSessionManager");
    expect(symbols).toContain("method:Start");

    const method = chunks.find((c) => c.symbolKind === "method" && c.symbolName === "Start");
    expect(method?.parentSymbol).toBe("SessionManager");
  });

  it("extracts Rust symbols", () => {
    const chunker = new AstChunker({ preferTreeSitter: false });
    const source = `
pub struct SessionManager;
pub trait Runner { fn run(&self); }

impl SessionManager {
  pub fn start(&self) {}
}

pub fn new_manager() -> SessionManager { SessionManager }
`;

    const chunks = chunker.chunk(source, "src/auth.rs", "rust", "repo1");
    const symbols = chunks.map((c) => `${c.symbolKind}:${c.symbolName}`);

    expect(symbols).toContain("class:SessionManager");
    expect(symbols).toContain("interface:Runner");
    expect(symbols).toContain("function:start");
    expect(symbols).toContain("function:new_manager");
  });

  it("extracts Kotlin symbols", () => {
    const chunker = new AstChunker({ preferTreeSitter: false });
    const source = `
class SessionManager {
  fun start() {}
}

interface Runner {
  fun run()
}

typealias SessionId = String

fun createManager(): SessionManager = SessionManager()
`;

    const chunks = chunker.chunk(source, "src/auth.kt", "kotlin", "repo1");
    const symbols = chunks.map((c) => `${c.symbolKind}:${c.symbolName}`);

    expect(symbols).toContain("class:SessionManager");
    expect(symbols).toContain("interface:Runner");
    expect(symbols).toContain("type:SessionId");
    expect(symbols).toContain("function:start");
    expect(symbols).toContain("function:run");
    expect(symbols).toContain("function:createManager");
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
