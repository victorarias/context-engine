import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AstChunker } from "../../src/chunker/ast-chunker.js";

type SnapshotChunk = {
  symbolKind?: string;
  symbolName?: string;
  parentSymbol?: string;
  startLine: number;
  endLine: number;
  content: string;
};

describe("AstChunker snapshots", () => {
  it("matches TypeScript chunk snapshot", () => {
    const chunker = new AstChunker({ preferTreeSitter: false });

    const source = `export interface User { id: string }
export type Token = { value: string }
export class SessionManager {
  createSession(userId: string) { return { userId }; }
}
export function authenticateUser(email: string, pass: string) { return email.length > 0 && pass.length > 0; }
`;

    const actual = normalize(chunker.chunk(source, "src/auth.ts", "typescript", "repo1"));
    const expected = loadSnapshot("ast-typescript.json");

    expect(actual).toEqual(expected);
  });

  it("matches Python chunk snapshot", () => {
    const chunker = new AstChunker({ preferTreeSitter: false });

    const source = `class SessionManager:
    def create_session(self, user_id):
        return {"user_id": user_id}

def authenticate_user(email, password):
    return len(email) > 0
`;

    const actual = normalize(chunker.chunk(source, "src/auth.py", "python", "repo1"));
    const expected = loadSnapshot("ast-python.json");

    expect(actual).toEqual(expected);
  });
});

function normalize(chunks: any[]): SnapshotChunk[] {
  return chunks.map((chunk) => ({
    symbolKind: chunk.symbolKind,
    symbolName: chunk.symbolName,
    parentSymbol: chunk.parentSymbol,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    content: chunk.content,
  }));
}

function loadSnapshot(file: string): SnapshotChunk[] {
  const path = join(import.meta.dir, "..", "fixtures", "snapshots", file);
  return JSON.parse(readFileSync(path, "utf-8")) as SnapshotChunk[];
}
