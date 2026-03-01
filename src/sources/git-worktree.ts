import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { WorktreeInfo } from "../types.js";

export interface HeadTreeEntry {
  path: string;
  blobHash: string;
}

export function isGitRepository(path: string): boolean {
  try {
    runGit(path, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

export function detectGitWorktree(path: string): WorktreeInfo | null {
  if (!isGitRepository(path)) return null;

  const absPath = resolve(path);
  const root = runGit(path, ["rev-parse", "--show-toplevel"]);
  const gitCommonDirRaw = runGit(path, ["rev-parse", "--git-common-dir"]);
  const gitCommonDir = resolve(root, gitCommonDirRaw);
  const branchRef = runGit(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const gitDir = runGit(path, ["rev-parse", "--absolute-git-dir"]);

  const branch = branchRef.startsWith("refs/heads/")
    ? branchRef.slice("refs/heads/".length)
    : branchRef;

  return {
    worktreeId: makeWorktreeId(absPath),
    repoId: makeRepoId(gitCommonDir),
    path: absPath,
    branch,
    isMain: !gitDir.includes("/worktrees/"),
    gitCommonDir,
  };
}

export function listGitWorktrees(path: string): WorktreeInfo[] {
  if (!isGitRepository(path)) return [];

  const porcelain = runGit(path, ["worktree", "list", "--porcelain"]);
  const blocks = porcelain
    .split(/\n\n+/)
    .map((b) => b.trim())
    .filter(Boolean);

  const infos: WorktreeInfo[] = [];

  for (const block of blocks) {
    const worktreeLine = block
      .split(/\r?\n/)
      .find((line) => line.startsWith("worktree "));

    if (!worktreeLine) continue;
    const wtPath = worktreeLine.slice("worktree ".length).trim();

    const info = detectGitWorktree(wtPath);
    if (info) infos.push(info);
  }

  return infos;
}

export function getHeadTreeManifest(worktreePath: string): HeadTreeEntry[] {
  if (!isGitRepository(worktreePath)) return [];

  const output = runGit(worktreePath, ["ls-tree", "-r", "--full-tree", "HEAD"]);
  if (!output.trim()) return [];

  const entries: HeadTreeEntry[] = [];

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;

    // Format: <mode> <type> <hash>\t<path>
    const match = line.match(/^[0-9]+\s+(\w+)\s+([0-9a-f]{40})\t(.+)$/);
    if (!match) continue;

    const type = match[1];
    const hash = match[2];
    const path = match[3];

    if (type !== "blob") continue;

    entries.push({
      path: normalizeFilePath(path),
      blobHash: hash,
    });
  }

  return entries;
}

export function getDirtyPaths(worktreePath: string): Set<string> {
  if (!isGitRepository(worktreePath)) return new Set();

  const output = runGit(worktreePath, ["status", "--porcelain", "--untracked-files=all"]);
  const dirty = new Set<string>();

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;

    // porcelain v1: XY <path> OR R/C with "old -> new"
    const raw = line.slice(3).trim();
    if (!raw) continue;

    if (raw.includes("->")) {
      const parts = raw.split("->").map((p) => p.trim());
      if (parts[0]) dirty.add(normalizeFilePath(parts[0]));
      if (parts[1]) dirty.add(normalizeFilePath(parts[1]));
    } else {
      dirty.add(normalizeFilePath(raw));
    }
  }

  return dirty;
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", resolve(cwd), ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeRepoId(gitCommonDir: string): string {
  return createHash("sha1").update(resolve(gitCommonDir)).digest("hex").slice(0, 16);
}

function makeWorktreeId(path: string): string {
  return `wt-${createHash("sha1").update(resolve(path)).digest("hex").slice(0, 16)}`;
}

function normalizeFilePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}
