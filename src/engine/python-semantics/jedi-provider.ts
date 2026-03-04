import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { PythonReferenceQuery, PythonReferenceResult, PythonSemanticProvider } from "./provider.js";

interface JediProviderOptions {
  pythonExecutable: string;
  requestTimeoutMs: number;
  roots: string[];
  resolveFileOnDisk: (path: string) => string | null;
}

export class JediPythonSemanticProvider implements PythonSemanticProvider {
  readonly name = "python-jedi";
  private available = false;

  constructor(private readonly options: JediProviderOptions) {}

  setRoots(roots: string[]): void {
    this.options.roots = roots.map((root) => resolve(root));
  }

  async warmup(): Promise<void> {
    this.available = this.detectAvailability();
  }

  async findReferences(query: PythonReferenceQuery): Promise<PythonReferenceResult> {
    if (!this.available) {
      return {
        backend: "none",
        confidence: "low",
        references: [],
        reason: "jedi backend unavailable",
      };
    }

    if (!query.filePath) {
      return {
        backend: "none",
        confidence: "low",
        references: [],
        reason: "jedi backend requires filePath anchor",
      };
    }

    const anchor = this.options.resolveFileOnDisk(query.filePath);
    if (!anchor || !existsSync(anchor) || extname(anchor).toLowerCase() !== ".py") {
      return {
        backend: "none",
        confidence: "low",
        references: [],
        reason: `python file not found for jedi anchor: ${query.filePath}`,
      };
    }

    try {
      const refs = this.runJedi(anchor, query.symbol, query.includeDeclaration ?? false, query.limit);
      const normalized = refs.map((entry) => this.normalizeReferenceLine(entry));

      return {
        backend: "python-jedi",
        confidence: normalized.length > 0 ? "high" : "medium",
        references: normalized,
        reason: normalized.length === 0 ? "jedi returned 0 references" : undefined,
      };
    } catch (error) {
      return {
        backend: "none",
        confidence: "low",
        references: [],
        reason: `jedi failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private detectAvailability(): boolean {
    try {
      const output = execFileSync(
        this.options.pythonExecutable,
        ["-c", "import jedi; print('ok')"],
        {
          timeout: Math.max(500, Math.min(5000, this.options.requestTimeoutMs)),
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      return output.includes("ok");
    } catch {
      return false;
    }
  }

  private runJedi(anchorAbsolutePath: string, symbol: string, includeDeclaration: boolean, limit: number): string[] {
    const payload = JSON.stringify({
      path: anchorAbsolutePath,
      symbol,
      includeDeclaration,
      limit,
      source: readFileSync(anchorAbsolutePath, "utf-8"),
    });

    const output = execFileSync(
      this.options.pythonExecutable,
      ["-c", JEDI_SCRIPT],
      {
        input: payload,
        timeout: this.options.requestTimeoutMs,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const parsed = JSON.parse(output) as { refs?: string[] };
    return Array.isArray(parsed.refs) ? parsed.refs : [];
  }

  private normalizeReferenceLine(line: string): string {
    const match = line.match(/^(.*?):(\d+):(\d+):(.*)$/);
    if (!match) return line;

    const absPath = normalizeSlashes(match[1] ?? "");
    const lineNo = match[2] ?? "";
    const col = match[3] ?? "";
    const snippet = (match[4] ?? "").trim();

    for (const root of this.options.roots) {
      const normalizedRoot = normalizeSlashes(resolve(root)).replace(/\/+$/, "");
      if (!absPath.startsWith(`${normalizedRoot}/`)) continue;

      const relative = absPath.slice(normalizedRoot.length + 1);
      return `${relative}:${lineNo}:${snippet || `col=${col}`}`;
    }

    return `${absPath}:${lineNo}:${snippet || `col=${col}`}`;
  }
}

function normalizeSlashes(path: string): string {
  return path.replaceAll("\\", "/");
}

const JEDI_SCRIPT = String.raw`import json
import re
import sys

import jedi

payload = json.load(sys.stdin)
path = payload.get("path")
symbol = (payload.get("symbol") or "").strip()
include_declaration = bool(payload.get("includeDeclaration"))
limit = max(1, int(payload.get("limit") or 50))
source = payload.get("source") or ""

if not path or not symbol:
    print(json.dumps({"refs": []}))
    raise SystemExit(0)

script = jedi.Script(code=source, path=path)

line_no = None
col_no = None
for idx, line in enumerate(source.splitlines(), start=1):
    if re.match(r"^\s*(def|class)\s+" + re.escape(symbol) + r"\b", line):
        line_no = idx
        col_no = max(0, line.find(symbol))
        break

if line_no is None:
    for idx, line in enumerate(source.splitlines(), start=1):
        pos = line.find(symbol)
        if pos >= 0:
            line_no = idx
            col_no = pos
            break

if line_no is None:
    print(json.dumps({"refs": []}))
    raise SystemExit(0)

refs = script.get_references(line=line_no, column=col_no, include_builtins=False)
out = []
for ref in refs:
    if not include_declaration and getattr(ref, "is_definition", lambda: False)():
        continue

    module_path = getattr(ref, "module_path", None)
    if not module_path:
        continue

    line = int(getattr(ref, "line", 0) or 0)
    column = int(getattr(ref, "column", 0) or 0)
    code_line = (getattr(ref, "line_code", "") or "").strip()
    out.append(f"{module_path}:{line}:{column}:{code_line}")

if len(out) > limit:
    out = out[:limit]

print(json.dumps({"refs": out}))
`;
