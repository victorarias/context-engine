import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parsePyProject } from "./pyproject-parser.js";

export interface PythonPackageResolverOptions {
  importAliases?: Record<string, string>;
}

export class PythonPackageResolver {
  private roots: string[];
  private options: PythonPackageResolverOptions;
  private aliases = new Map<string, string>();

  constructor(roots: string[], options?: PythonPackageResolverOptions) {
    this.roots = roots.map((r) => resolve(r));
    this.options = options ?? {};
    this.refreshAliases();
  }

  setRoots(roots: string[]): void {
    this.roots = roots.map((r) => resolve(r));
    this.refreshAliases();
  }

  setOptions(options: PythonPackageResolverOptions): void {
    this.options = options;
    this.refreshAliases();
  }

  resolveCandidates(moduleName: string): string[] {
    const cleaned = moduleName.trim();
    if (!cleaned) return [];

    const out = new Set<string>([cleaned]);

    for (const [from, to] of this.aliases.entries()) {
      if (cleaned === from) {
        out.add(to);
        continue;
      }

      if (cleaned.startsWith(`${from}.`)) {
        out.add(`${to}${cleaned.slice(from.length)}`);
      }
    }

    return Array.from(out);
  }

  getAliases(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.aliases.entries()) {
      out[k] = v;
    }
    return out;
  }

  private refreshAliases(): void {
    this.aliases.clear();

    if (this.options.importAliases) {
      for (const [from, to] of Object.entries(this.options.importAliases)) {
        const cleanFrom = from.trim();
        const cleanTo = to.trim();
        if (!cleanFrom || !cleanTo) continue;
        this.aliases.set(cleanFrom, cleanTo);
      }
    }

    for (const root of this.roots) {
      const pyprojectPath = findUpward(root, "pyproject.toml");
      if (!pyprojectPath) continue;

      const info = parsePyProject(pyprojectPath);

      for (const [from, to] of Object.entries(info.aliasMap)) {
        if (!this.aliases.has(from)) {
          this.aliases.set(from, to);
        }
      }

      // Heuristic for flowllm[reme]-style package bridging in multi-package repos.
      // If project includes reme* packages and depends on flowllm, map flowllm.core -> reme.core
      // unless user already configured a mapping.
      const dependsOnFlowllm = info.dependencies.some((dep) => dep.startsWith("flowllm"));
      const includesReme = info.packageIncludes.some((pkg) => pkg.startsWith("reme"));

      if (dependsOnFlowllm && includesReme) {
        if (!this.aliases.has("flowllm.core")) {
          this.aliases.set("flowllm.core", "reme.core");
        }
      }
    }
  }
}

function findUpward(start: string, filename: string): string | null {
  let current = resolve(start);

  while (true) {
    const candidate = resolve(current, filename);
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
}
