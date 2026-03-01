import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, extname } from "node:path";
import type { FileInfo, SourceScanner, ScanOptions } from "../types.js";
import { isSecretPath } from "../storage/security.js";

const DEFAULT_EXCLUDES = [
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  "target",
  "vendor",
  "__pycache__",
  ".context-engine",
];

export class LocalFileScanner implements SourceScanner {
  async *scan(dir: string, options: ScanOptions = {}): AsyncIterable<FileInfo> {
    const root = resolve(dir);
    const excludes = new Set([...(options.exclude ?? []).map(normalizeSimplePattern), ...DEFAULT_EXCLUDES]);

    for (const filePath of walkFiles(root, excludes)) {
      let stat;
      try {
        stat = statSync(filePath);
      } catch {
        // File may disappear between directory walk and stat (e.g. concurrent cleanup).
        continue;
      }

      if (!stat.isFile()) continue;

      // Skip large files for now (M3 baseline)
      if (stat.size > 1024 * 1024) continue;

      let content: string;
      try {
        content = readFileSync(filePath, "utf-8");
      } catch {
        // binary or unreadable file
        continue;
      }

      // Skip likely binary files
      if (content.includes("\u0000")) continue;

      const hash = hashAsGitBlob(content);

      yield {
        path: filePath,
        contentHash: hash,
        size: stat.size,
        mtime: stat.mtimeMs,
        language: languageFromPath(filePath),
      };
    }
  }
}

function* walkFiles(dir: string, excludes: Set<string>): Generator<string> {
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);

    if (entry.isDirectory()) {
      if (excludes.has(entry.name)) continue;
      if (isSecretPath(fullPath)) continue;
      yield* walkFiles(fullPath, excludes);
      continue;
    }

    if (entry.isFile()) {
      if (excludes.has(entry.name)) continue;
      if (entry.name === ".git") continue;
      if (isSecretPath(fullPath)) continue;
      yield fullPath;
    }
  }
}

function normalizeSimplePattern(pattern: string): string {
  // Very simple for now: "**/node_modules/**" -> "node_modules"
  const parts = pattern.split("/").filter(Boolean).filter((p) => p !== "**" && p !== "*");
  return parts[parts.length - 1] ?? pattern;
}

function hashAsGitBlob(content: string): string {
  const bytes = Buffer.from(content, "utf-8");
  const header = `blob ${bytes.length}\0`;
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

function languageFromPath(path: string): string {
  const ext = extname(path).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
      return "javascript";
    case ".py":
      return "python";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    case ".java":
      return "java";
    case ".c":
    case ".h":
      return "c";
    case ".cpp":
    case ".hpp":
    case ".cc":
      return "cpp";
    case ".md":
      return "markdown";
    case ".json":
      return "json";
    default:
      return "text";
  }
}
