import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import type { PyDependencyService } from "../py-dependency-service.js";
import type { PythonReferenceQuery, PythonReferenceResult, PythonSemanticProvider } from "./provider.js";

interface StaticProviderDeps {
  pyDeps: PyDependencyService;
  findVisibleFiles: () => Promise<string[]>;
  resolveFileOnDisk: (path: string) => string | null;
}

export class StaticPythonSemanticProvider implements PythonSemanticProvider {
  readonly name = "python-static";

  constructor(private readonly deps: StaticProviderDeps) {}

  async warmup(): Promise<void> {
    // no-op for static provider
  }

  async findReferences(query: PythonReferenceQuery): Promise<PythonReferenceResult> {
    const symbol = query.symbol.trim();
    if (!symbol) {
      return {
        backend: "none",
        confidence: "low",
        references: [],
        reason: "missing symbol",
      };
    }

    const pattern = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
    const allFiles = (await this.deps.findVisibleFiles())
      .filter((file) => extname(file).toLowerCase() === ".py");
    const filesToScan = await this.collectCandidateFiles(query.filePath, allFiles);
    const references: string[] = [];

    const anchorClass = query.filePath
      ? this.detectAnchorMethodClass(query.filePath, symbol)
      : undefined;
    const overrideClasses = anchorClass
      ? await this.collectOverrideClasses(anchorClass, filesToScan)
      : new Set<string>();

    for (const file of filesToScan) {
      if (references.length >= query.limit) break;

      const absolutePath = this.deps.resolveFileOnDisk(file);
      if (!absolutePath || !existsSync(absolutePath)) continue;

      let content: string;
      try {
        content = readFileSync(absolutePath, "utf-8");
      } catch {
        continue;
      }

      const lines = content.split(/\r?\n/);
      const docMask = buildDocstringMask(lines);

      const classAtLine = buildClassContextByLine(lines);

      for (let index = 0; index < lines.length; index++) {
        if (references.length >= query.limit) break;

        const line = lines[index] ?? "";
        if (!line.trim()) continue;
        if (docMask.has(index)) continue;
        if (isPythonCommentLine(line)) continue;
        if (!pattern.test(line)) continue;

        const currentClass = classAtLine.get(index);
        const methodDecl = line.match(/^\s*def\s+([A-Za-z_][\w]*)\s*\(/);
        const isOverrideDeclaration =
          !!methodDecl
          && methodDecl[1] === symbol
          && !!currentClass
          && overrideClasses.has(currentClass);

        const isDeclaration = isLikelyPythonDeclaration(line, symbol);
        if (!query.includeDeclaration && isDeclaration && !isOverrideDeclaration) {
          continue;
        }

        if (!isOverrideDeclaration && !looksLikeReferenceLine(line, symbol)) {
          continue;
        }

        const suffix = isOverrideDeclaration ? " [override]" : "";
        references.push(`${file}:${index + 1}:${line.trim().slice(0, 220)}${suffix}`);
      }
    }

    const confidence = query.filePath ? "medium" : "low";

    return {
      backend: "python-static",
      confidence,
      references,
      reason: references.length === 0 ? "static python analysis found no matches" : undefined,
    };
  }

  private detectAnchorMethodClass(filePath: string, symbol: string): string | undefined {
    const absolute = this.deps.resolveFileOnDisk(filePath);
    if (!absolute || !existsSync(absolute)) return undefined;

    let content: string;
    try {
      content = readFileSync(absolute, "utf-8");
    } catch {
      return undefined;
    }

    const lines = content.split(/\r?\n/);
    const classAtLine = buildClassContextByLine(lines);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!new RegExp(`^\\s*def\\s+${escapeRegExp(symbol)}\\s*\\(`).test(line)) {
        continue;
      }

      const cls = classAtLine.get(i);
      if (cls) {
        return cls;
      }
    }

    return undefined;
  }

  private async collectOverrideClasses(anchorClass: string, allFiles: string[]): Promise<Set<string>> {
    const inheritance = new Map<string, Set<string>>();

    for (const file of allFiles) {
      const absolute = this.deps.resolveFileOnDisk(file);
      if (!absolute || !existsSync(absolute)) continue;

      let content: string;
      try {
        content = readFileSync(absolute, "utf-8");
      } catch {
        continue;
      }

      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        const classMatch = line.match(/^\s*class\s+([A-Za-z_][\w]*)\s*(?:\(([^)]*)\))?\s*:/);
        if (!classMatch?.[1]) continue;

        const className = classMatch[1].trim();
        const bases = (classMatch[2] ?? "")
          .split(",")
          .map((base) => base.trim())
          .filter(Boolean)
          .map((base) => base.split(".").slice(-1)[0] ?? base);

        for (const base of bases) {
          const bucket = inheritance.get(base) ?? new Set<string>();
          bucket.add(className);
          inheritance.set(base, bucket);
        }
      }
    }

    const out = new Set<string>();
    const queue = [anchorClass];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const children = inheritance.get(current);
      if (!children) continue;

      for (const child of children) {
        if (out.has(child)) continue;
        out.add(child);
        queue.push(child);
      }
    }

    return out;
  }

  private async collectCandidateFiles(filePath: string | undefined, allFiles: string[]): Promise<string[]> {
    if (!filePath) {
      return allFiles;
    }

    const normalized = normalizePath(filePath);
    const importers = this.deps.pyDeps.findImporters(normalized, { limit: 1000 });

    const indexedFiles = new Set(allFiles);
    const out = new Set<string>([normalized, ...importers]);
    return Array.from(out).filter((file) => indexedFiles.has(file));
  }
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isPythonCommentLine(line: string): boolean {
  return line.trimStart().startsWith("#");
}

function isLikelyPythonDeclaration(line: string, symbol: string): boolean {
  const escaped = escapeRegExp(symbol);
  return new RegExp(`^\\s*(def|class)\\s+${escaped}\\b`).test(line)
    || new RegExp(`^\\s*${escaped}\\s*=`).test(line)
    || new RegExp(`^\\s*from\\s+[^#]+\\s+import\\s+.*\\b${escaped}\\b`).test(line);
}

function looksLikeReferenceLine(line: string, symbol: string): boolean {
  const escaped = escapeRegExp(symbol);
  if (new RegExp(`\\b${escaped}\\s*\\(`).test(line)) return true;
  if (new RegExp(`\\.${escaped}\\b`).test(line)) return true;
  if (new RegExp(`\\breturn\\b.*\\b${escaped}\\b`).test(line)) return true;
  if (new RegExp(`\\b${escaped}\\b`).test(line) && line.length < 220) return true;
  return false;
}

function buildClassContextByLine(lines: string[]): Map<number, string> {
  const out = new Map<number, string>();
  const stack: Array<{ indent: number; name: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    const indent = indentation(line);

    if (trimmed && !trimmed.startsWith("#")) {
      while (stack.length > 0 && indent <= stack[stack.length - 1]!.indent) {
        stack.pop();
      }
    }

    const classMatch = line.match(/^\s*class\s+([A-Za-z_][\w]*)\s*(?:\([^)]*\))?\s*:/);
    if (classMatch?.[1]) {
      stack.push({ indent, name: classMatch[1] });
    }

    if (stack.length > 0) {
      out.set(i, stack[stack.length - 1]!.name);
    }
  }

  return out;
}

function indentation(line: string): number {
  const m = line.match(/^\s*/);
  return m?.[0].length ?? 0;
}

function buildDocstringMask(lines: string[]): Set<number> {
  const out = new Set<number>();
  let inTripleSingle = false;
  let inTripleDouble = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    if (inTripleSingle || inTripleDouble) {
      out.add(i);
    }

    const singleCount = countUnescaped(line, "'''");
    const doubleCount = countUnescaped(line, '"""');

    if (!inTripleDouble && singleCount > 0) {
      if (singleCount % 2 === 1) {
        inTripleSingle = !inTripleSingle;
      }
      out.add(i);
    }

    if (!inTripleSingle && doubleCount > 0) {
      if (doubleCount % 2 === 1) {
        inTripleDouble = !inTripleDouble;
      }
      out.add(i);
    }
  }

  return out;
}

function countUnescaped(line: string, needle: string): number {
  let idx = 0;
  let count = 0;

  while (true) {
    const found = line.indexOf(needle, idx);
    if (found < 0) break;

    let backslashes = 0;
    for (let i = found - 1; i >= 0 && line[i] === "\\"; i--) {
      backslashes += 1;
    }

    if (backslashes % 2 === 0) {
      count += 1;
    }

    idx = found + needle.length;
  }

  return count;
}
