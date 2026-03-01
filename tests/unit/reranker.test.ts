import { describe, expect, it } from "bun:test";
import { rerankCandidates } from "../../src/engine/reranker.js";

describe("reranker", () => {
  it("boosts symbol/path matches over pure vector score", () => {
    const ranked = rerankCandidates(
      "authenticate user",
      [
        {
          path: "src/utils/random.ts",
          baseScore: 0.9,
          chunk: {
            id: "a",
            content: "random utility",
            filePath: "src/utils/random.ts",
            startLine: 1,
            endLine: 2,
            language: "typescript",
            repoId: "repo",
          },
        },
        {
          path: "src/auth/authenticate.ts",
          baseScore: 0.82,
          chunk: {
            id: "b",
            content: "function authenticateUser() {}",
            filePath: "src/auth/authenticate.ts",
            startLine: 1,
            endLine: 5,
            language: "typescript",
            repoId: "repo",
            symbolName: "authenticateUser",
            symbolKind: "function",
          },
        },
      ],
      { roots: [] },
    );

    expect(ranked[0].chunk.id).toBe("b");
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });
});
