import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import ts from "typescript";

export type TsEdgeKind =
  | "import"
  | "side-effect"
  | "reexport"
  | "type-only"
  | "dynamic-literal"
  | "dynamic-unresolved";

export interface TsDependencyEdge {
  sourceFile: string;
  rawSpecifier: string;
  resolvedTarget?: string;
  edgeKind: TsEdgeKind;
  projectId: string;
  confidence: "high" | "medium" | "low";
  unresolvedReason?: string;
}

export interface TsDependencyStats {
  filesIndexed: number;
  edgesTotal: number;
  edgesResolved: number;
  edgesUnresolved: number;
  resolutionSuccessRate: number;
  lastBuiltAt: number;
}

type ProjectConfig = {
  id: string;
  configPath?: string;
  compilerOptions: ts.CompilerOptions;
};

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

export class TsDependencyService {
  private roots: string[];
  private depsByFile = new Map<string, TsDependencyEdge[]>();
  private importersByTarget = new Map<string, Set<string>>();
  private importersBySpecifier = new Map<string, Set<string>>();
  private configCacheByDir = new Map<string, ProjectConfig>();

  private stats: TsDependencyStats = {
    filesIndexed: 0,
    edgesTotal: 0,
    edgesResolved: 0,
    edgesUnresolved: 0,
    resolutionSuccessRate: 0,
    lastBuiltAt: 0,
  };

  constructor(roots: string[]) {
    this.roots = roots.map((r) => resolve(r));
  }

  setRoots(roots: string[]): void {
    this.roots = roots.map((r) => resolve(r));
  }

  rebuild(visibleFiles: string[]): void {
    this.depsByFile.clear();
    this.importersByTarget.clear();
    this.importersBySpecifier.clear();
    this.configCacheByDir.clear();

    let edgesTotal = 0;
    let edgesResolved = 0;
    let edgesUnresolved = 0;

    const tsFiles = visibleFiles
      .map(normalizePath)
      .filter((path) => TS_EXTENSIONS.has(extname(path).toLowerCase()));

    for (const relativePath of tsFiles) {
      const absolutePath = this.resolveInRoots(relativePath);
      if (!absolutePath || !existsSync(absolutePath)) continue;

      let content: string;
      try {
        content = readFileSync(absolutePath, "utf-8");
      } catch {
        continue;
      }

      const project = this.getOwningProject(absolutePath);
      const extracted = extractEdges(content);

      const edges: TsDependencyEdge[] = extracted.map((edge) => {
        const resolved = this.resolveSpecifier(edge.rawSpecifier, absolutePath, project);

        const out: TsDependencyEdge = {
          sourceFile: relativePath,
          rawSpecifier: edge.rawSpecifier,
          edgeKind: edge.edgeKind,
          projectId: project.id,
          confidence: resolved.confidence,
          resolvedTarget: resolved.target,
          unresolvedReason: resolved.reason,
        };

        return out;
      });

      this.depsByFile.set(relativePath, edges);

      for (const edge of edges) {
        edgesTotal++;
        if (edge.resolvedTarget) edgesResolved++;
        else edgesUnresolved++;

        const specSet = this.importersBySpecifier.get(edge.rawSpecifier) ?? new Set<string>();
        specSet.add(relativePath);
        this.importersBySpecifier.set(edge.rawSpecifier, specSet);

        if (edge.resolvedTarget) {
          const importerSet = this.importersByTarget.get(edge.resolvedTarget) ?? new Set<string>();
          importerSet.add(relativePath);
          this.importersByTarget.set(edge.resolvedTarget, importerSet);
        }
      }
    }

    this.stats = {
      filesIndexed: this.depsByFile.size,
      edgesTotal,
      edgesResolved,
      edgesUnresolved,
      resolutionSuccessRate: edgesTotal > 0 ? edgesResolved / edgesTotal : 0,
      lastBuiltAt: Date.now(),
    };
  }

  getStats(): TsDependencyStats {
    return { ...this.stats };
  }

  getFileEdges(filePath: string): TsDependencyEdge[] {
    const normalized = normalizePath(filePath);
    return [...(this.depsByFile.get(normalized) ?? [])];
  }

  getDirectoryEdges(
    dirPath: string,
    options?: { recursive?: boolean; maxFiles?: number },
  ): Array<{ file: string; edges: TsDependencyEdge[] }> {
    const recursive = options?.recursive ?? false;
    const maxFiles = Math.max(1, Math.min(1000, Math.floor(options?.maxFiles ?? 50)));

    const normalizedDir = normalizePath(dirPath).replace(/\/$/, "");

    const files = Array.from(this.depsByFile.keys())
      .filter((file) => {
        const fileDir = normalizePath(dirname(file));

        if (!normalizedDir || normalizedDir === ".") return true;
        if (recursive) {
          return fileDir === normalizedDir || file.startsWith(`${normalizedDir}/`);
        }

        return fileDir === normalizedDir;
      })
      .sort()
      .slice(0, maxFiles);

    return files.map((file) => ({
      file,
      edges: this.getFileEdges(file),
    }));
  }

  findImporters(target: string, options?: { limit?: number }): string[] {
    const limit = Math.max(1, options?.limit ?? 100);
    const normalized = normalizePath(target);

    const exactPathMatches = this.importersByTarget.get(normalized);
    if (exactPathMatches && exactPathMatches.size > 0) {
      return Array.from(exactPathMatches).sort().slice(0, limit);
    }

    const withExtensions = tryPathVariants(normalized);
    for (const variant of withExtensions) {
      const matches = this.importersByTarget.get(variant);
      if (matches && matches.size > 0) {
        return Array.from(matches).sort().slice(0, limit);
      }
    }

    const specMatches = this.importersBySpecifier.get(target) ?? this.importersBySpecifier.get(normalized);
    if (specMatches && specMatches.size > 0) {
      return Array.from(specMatches).sort().slice(0, limit);
    }

    return [];
  }

  private resolveSpecifier(
    specifier: string,
    sourceAbsolutePath: string,
    project: ProjectConfig,
  ): { target?: string; confidence: "high" | "medium" | "low"; reason?: string } {
    const raw = specifier.trim();
    if (!raw) {
      return {
        confidence: "low",
        reason: "empty specifier",
      };
    }

    if (!looksResolvableSpecifier(raw)) {
      return {
        target: `pkg:${raw}`,
        confidence: "medium",
      };
    }

    const resolved = ts.resolveModuleName(raw, sourceAbsolutePath, project.compilerOptions, ts.sys);
    const resolvedFile = resolved.resolvedModule?.resolvedFileName;

    if (!resolvedFile) {
      if (!raw.startsWith(".") && !raw.startsWith("/")) {
        return {
          target: `pkg:${raw}`,
          confidence: "medium",
          reason: "package resolution not materialized to file",
        };
      }

      return {
        confidence: "low",
        reason: "module could not be resolved",
      };
    }

    const normalizedTarget = this.normalizeTargetPath(resolvedFile, raw);
    return {
      target: normalizedTarget,
      confidence: normalizedTarget.startsWith("pkg:") ? "medium" : "high",
    };
  }

  private normalizeTargetPath(resolvedFilePath: string, fallbackSpecifier: string): string {
    const absolute = resolve(resolvedFilePath);

    for (const root of this.roots) {
      const rel = normalizePath(relative(root, absolute));
      if (!rel.startsWith("../") && rel !== "..") {
        return rel;
      }
    }

    if (absolute.includes("node_modules")) {
      return `pkg:${fallbackSpecifier}`;
    }

    return normalizePath(absolute);
  }

  private getOwningProject(fileAbsolutePath: string): ProjectConfig {
    let cursor = dirname(fileAbsolutePath);

    while (true) {
      const cached = this.configCacheByDir.get(cursor);
      if (cached) return cached;

      const tsConfigPath = resolve(cursor, "tsconfig.json");
      const jsConfigPath = resolve(cursor, "jsconfig.json");

      if (existsSync(tsConfigPath)) {
        const parsed = this.parseProject(tsConfigPath);
        this.configCacheByDir.set(cursor, parsed);
        return parsed;
      }

      if (existsSync(jsConfigPath)) {
        const parsed = this.parseProject(jsConfigPath);
        this.configCacheByDir.set(cursor, parsed);
        return parsed;
      }

      const parent = dirname(cursor);
      if (parent === cursor) {
        break;
      }

      cursor = parent;
    }

    const fallback: ProjectConfig = {
      id: "default-ts-project",
      compilerOptions: {
        allowJs: true,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      },
    };

    return fallback;
  }

  private parseProject(configPath: string): ProjectConfig {
    try {
      const read = ts.readConfigFile(configPath, ts.sys.readFile);
      if (read.error) {
        return {
          id: normalizePath(configPath),
          configPath,
          compilerOptions: {
            allowJs: true,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
          },
        };
      }

      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath));

      return {
        id: normalizePath(configPath),
        configPath,
        compilerOptions: parsed.options,
      };
    } catch {
      return {
        id: normalizePath(configPath),
        configPath,
        compilerOptions: {
          allowJs: true,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
        },
      };
    }
  }

  private resolveInRoots(path: string): string | null {
    const normalized = normalizePath(path);

    if (isAbsolute(normalized) && existsSync(normalized)) {
      return normalized;
    }

    for (const root of this.roots) {
      const candidate = resolve(root, normalized);
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }
}

function extractEdges(content: string): Array<{ rawSpecifier: string; edgeKind: TsEdgeKind }> {
  const source = ts.createSourceFile("module.ts", content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Array<{ rawSpecifier: string; edgeKind: TsEdgeKind }> = [];

  const push = (rawSpecifier: string, edgeKind: TsEdgeKind) => {
    const spec = rawSpecifier.trim();
    if (!spec) return;
    out.push({ rawSpecifier: spec, edgeKind });
  };

  const walk = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (!node.importClause) {
        push(specifier, "side-effect");
      } else if (node.importClause.isTypeOnly) {
        push(specifier, "type-only");
      } else {
        push(specifier, "import");
      }
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (node.isTypeOnly) {
        push(specifier, "type-only");
      } else {
        push(specifier, "reexport");
      }
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0
    ) {
      const arg = node.arguments[0];
      if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
        push(arg.text, "dynamic-literal");
      } else {
        push(arg.getText(source), "dynamic-unresolved");
      }
    }

    ts.forEachChild(node, walk);
  };

  walk(source);
  return out;
}

function looksResolvableSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    /^[A-Za-z0-9@][^\s]*$/.test(specifier)
  );
}

function tryPathVariants(path: string): string[] {
  const variants = new Set<string>();
  variants.add(path);

  if (!extname(path)) {
    for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".d.ts"]) {
      variants.add(`${path}${ext}`);
    }

    for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]) {
      variants.add(`${path}/index${ext}`);
    }
  }

  return Array.from(variants);
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}
