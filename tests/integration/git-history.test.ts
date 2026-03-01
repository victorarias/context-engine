import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { TempDir } from "../harness/temp-dir.js";
import { ConfigSchema } from "../../src/config.js";
import { ContextEngine } from "../../src/engine/context-engine.js";

describe("Git history connector", () => {
  const dirs: TempDir[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      dir.cleanup();
    }
  });

  it("returns recent commit messages and changed files", async () => {
    const tmp = TempDir.create("ce-git-history");
    dirs.push(tmp);

    const repoPath = createRepoWithHistory(tmp.path);

    const config = ConfigSchema.parse({
      sources: [{ path: repoPath }],
      dataDir: join(tmp.path, "data"),
      embedding: {
        provider: "local",
        localBackend: "mock",
        dimensions: 64,
      },
      gitHistory: {
        enabled: true,
        maxCommits: 20,
      },
      watcher: {
        enabled: false,
      },
    });

    const engine = await ContextEngine.create(config);
    await engine.index();

    const summary = await engine.getRecentChanges();
    expect(summary).toContain("Recent changes:");
    expect(summary).toContain("add auth login flow");
    expect(summary).toContain("refactor session token handling");
    expect(summary).toContain("src/auth.ts");
    expect(summary).toContain("src/session.ts");

    const filtered = await engine.getRecentChanges("session token");
    expect(filtered).toContain("Recent changes matching");
    expect(filtered).toContain("refactor session token handling");
    expect(filtered).not.toContain("add auth login flow");

    await engine.close();
  });

  it("returns a helpful message when git history is disabled", async () => {
    const tmp = TempDir.create("ce-git-history-disabled");
    dirs.push(tmp);

    const repoPath = createRepoWithHistory(tmp.path);

    const config = ConfigSchema.parse({
      sources: [{ path: repoPath }],
      dataDir: join(tmp.path, "data"),
      embedding: {
        provider: "local",
        localBackend: "mock",
        dimensions: 64,
      },
      gitHistory: {
        enabled: false,
        maxCommits: 5,
      },
      watcher: {
        enabled: false,
      },
    });

    const engine = await ContextEngine.create(config);
    const summary = await engine.getRecentChanges("anything");

    expect(summary).toContain("disabled");

    await engine.close();
  });
});

function createRepoWithHistory(baseDir: string): string {
  const repoPath = join(baseDir, "repo");
  mkdirSync(join(repoPath, "src"), { recursive: true });

  runGit(repoPath, ["init"]);
  runGit(repoPath, ["config", "user.email", "test@example.com"]);
  runGit(repoPath, ["config", "user.name", "Test User"]);
  runGit(repoPath, ["checkout", "-b", "main"]);

  writeFileSync(join(repoPath, "src", "auth.ts"), "export const login = () => true;\n");
  runGit(repoPath, ["add", "."]);
  runGit(repoPath, ["commit", "-m", "add auth login flow"]);

  writeFileSync(join(repoPath, "src", "session.ts"), "export const issueToken = () => 'token';\n");
  runGit(repoPath, ["add", "."]);
  runGit(repoPath, ["commit", "-m", "refactor session token handling"]);

  return repoPath;
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
