import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TempDir } from "../harness/temp-dir.js";
import { LocalFileScanner } from "../../src/sources/local-fs.js";

describe("LocalFileScanner", () => {
  const dirs: TempDir[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      dir.cleanup();
    }
  });

  it("scans files recursively, excludes node_modules/.git, and emits git-style content hashes", async () => {
    const dir = TempDir.create("ce-scan");
    dirs.push(dir);

    mkdirSync(join(dir.path, "src"), { recursive: true });
    mkdirSync(join(dir.path, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(dir.path, ".git"), { recursive: true });
    mkdirSync(join(dir.path, "linked-worktree"), { recursive: true });

    const aContent = "export const a = 1;\n";
    writeFileSync(join(dir.path, "src", "a.ts"), aContent);
    writeFileSync(join(dir.path, "src", "b.py"), "def hello():\n  return 1\n");
    writeFileSync(join(dir.path, "node_modules", "pkg", "ignored.js"), "module.exports = 1\n");
    writeFileSync(join(dir.path, ".git", "config"), "[core]\n");
    writeFileSync(join(dir.path, "linked-worktree", ".git"), "gitdir: /tmp/real/.git/worktrees/linked\n");
    writeFileSync(join(dir.path, "src", ".env"), "SECRET_TOKEN=abc\n");
    writeFileSync(join(dir.path, "src", "id_rsa"), "PRIVATE KEY\n");

    const scanner = new LocalFileScanner();
    const files = [] as string[];
    const hashes = new Map<string, string>();

    for await (const f of scanner.scan(dir.path)) {
      files.push(f.path);
      hashes.set(f.path, f.contentHash);
    }

    expect(files.some((f) => f.endsWith("src/a.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("src/b.py"))).toBe(true);
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
    expect(files.some((f) => f.includes("/.git/"))).toBe(false);
    expect(files.some((f) => f.endsWith("linked-worktree/.git"))).toBe(false);
    expect(files.some((f) => f.endsWith("/.env"))).toBe(false);
    expect(files.some((f) => f.endsWith("/id_rsa"))).toBe(false);

    const aPath = files.find((f) => f.endsWith("src/a.ts"));
    expect(aPath).toBeDefined();

    const aBytes = Buffer.from(aContent, "utf-8");
    const expectedGitBlobHash = createHash("sha1")
      .update(`blob ${aBytes.length}\0`)
      .update(aBytes)
      .digest("hex");

    expect(hashes.get(aPath!)).toBe(expectedGitBlobHash);
  });
});
