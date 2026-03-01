import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { detectGitWorktree, isGitRepository } from "./git-worktree.js";

export interface GitHistoryEntry {
  commit: string;
  shortCommit: string;
  author: string;
  date: string;
  message: string;
  files: string[];
  repoPath: string;
  repoId?: string;
  branch?: string;
}

export interface GitHistoryQueryOptions {
  maxCommits?: number;
  query?: string;
}

export function getRecentGitChanges(root: string, options: GitHistoryQueryOptions = {}): GitHistoryEntry[] {
  if (!isGitRepository(root)) return [];

  const maxCommits = Math.max(1, options.maxCommits ?? 100);

  const raw = runGit(root, [
    "log",
    `--max-count=${maxCommits}`,
    "--date=iso-strict",
    "--pretty=format:%x1e%H%x1f%an%x1f%ad%x1f%s",
    "--name-only",
  ]);

  if (!raw.trim()) return [];

  const worktree = detectGitWorktree(root);
  const query = options.query?.trim().toLowerCase();

  const entries = raw
    .split("\x1e")
    .map((block) => parseGitLogBlock(block, resolve(root), worktree?.repoId, worktree?.branch))
    .filter((entry): entry is GitHistoryEntry => Boolean(entry));

  if (!query) return entries;

  return entries.filter((entry) => {
    const haystack = [
      entry.commit,
      entry.shortCommit,
      entry.author,
      entry.message,
      ...entry.files,
    ]
      .join("\n")
      .toLowerCase();

    return haystack.includes(query);
  });
}

function parseGitLogBlock(
  block: string,
  repoPath: string,
  repoId?: string,
  branch?: string,
): GitHistoryEntry | null {
  const trimmed = block.trim();
  if (!trimmed) return null;

  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;

  const header = lines[0].split("\x1f");
  if (header.length < 4) return null;

  const [commit, author, date, ...messageParts] = header;
  const message = messageParts.join("\x1f");

  const files = lines.slice(1)
    .map((line) => normalizeFilePath(line))
    .filter(Boolean);

  return {
    commit,
    shortCommit: commit.slice(0, 8),
    author,
    date,
    message,
    files,
    repoPath,
    repoId,
    branch,
  };
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", resolve(cwd), ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function normalizeFilePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}
