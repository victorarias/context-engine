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

export type TsReferenceResolution =
  | {
    kind: "resolved";
    declaration: TsSymbolDeclaration;
    candidates: string[];
  }
  | {
    kind: "ambiguous";
    reason: string;
    candidates: string[];
  }
  | {
    kind: "unresolved";
    reason: string;
    candidates: string[];
  };

export interface TsReferenceSearchResult {
  resolution: TsReferenceResolution;
  references: string[];
}

type ProjectConfig = {
  id: string;
  configPath?: string;
  compilerOptions: ts.CompilerOptions;
};

type ProjectIndex = {
  id: string;
  configPath?: string;
  compilerOptions: ts.CompilerOptions;
  files: Set<string>; // absolute, normalized to '/'
};

export type TsSymbolDeclaration = {
  name: string;
  kind: string;
  filePath: string;
  absolutePath: string;
  position: number;
  line: number;
  projectId: string;
};

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

export class TsDependencyService {
  private roots: string[];
  private depsByFile = new Map<string, TsDependencyEdge[]>();
  private importersByTarget = new Map<string, Set<string>>();
  private importersBySpecifier = new Map<string, Set<string>>();
  private configCacheByDir = new Map<string, ProjectConfig>();

  private declarationsBySymbol = new Map<string, TsSymbolDeclaration[]>();
  private declarationsByFile = new Map<string, TsSymbolDeclaration[]>();
  private absoluteByRelative = new Map<string, string>();
  private relativeByAbsolute = new Map<string, string>();
  private projectByFile = new Map<string, string>();
  private projectIndex = new Map<string, ProjectIndex>();

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

    this.declarationsBySymbol.clear();
    this.declarationsByFile.clear();
    this.absoluteByRelative.clear();
    this.relativeByAbsolute.clear();
    this.projectByFile.clear();
    this.projectIndex.clear();

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

      const absoluteNormalized = normalizePath(resolve(absolutePath));
      this.absoluteByRelative.set(relativePath, absoluteNormalized);
      this.relativeByAbsolute.set(absoluteNormalized, relativePath);

      const project = this.getOwningProject(absolutePath);
      this.projectByFile.set(relativePath, project.id);

      const projectBucket = this.projectIndex.get(project.id) ?? {
        id: project.id,
        configPath: project.configPath,
        compilerOptions: project.compilerOptions,
        files: new Set<string>(),
      };
      projectBucket.files.add(absoluteNormalized);
      this.projectIndex.set(project.id, projectBucket);

      const facts = extractFileFacts(content, absolutePath);
      const edges: TsDependencyEdge[] = facts.edges.map((edge) => {
        const resolved = this.resolveSpecifier(edge.rawSpecifier, absolutePath, project);

        return {
          sourceFile: relativePath,
          rawSpecifier: edge.rawSpecifier,
          edgeKind: edge.edgeKind,
          projectId: project.id,
          confidence: resolved.confidence,
          resolvedTarget: resolved.target,
          unresolvedReason: resolved.reason,
        };
      });

      const declarations: TsSymbolDeclaration[] = facts.declarations.map((decl) => ({
        name: decl.name,
        kind: decl.kind,
        filePath: relativePath,
        absolutePath: absoluteNormalized,
        position: decl.position,
        line: decl.line,
        projectId: project.id,
      }));

      this.declarationsByFile.set(relativePath, declarations);
      for (const decl of declarations) {
        const bucket = this.declarationsBySymbol.get(decl.name) ?? [];
        bucket.push(decl);
        this.declarationsBySymbol.set(decl.name, bucket);
      }

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

  findReferences(
    symbol: string,
    options?: { filePath?: string; includeDeclaration?: boolean; limit?: number },
  ): TsReferenceSearchResult {
    const resolution = this.resolveReferenceTarget(symbol, options?.filePath);
    if (resolution.kind !== "resolved") {
      return {
        resolution,
        references: [],
      };
    }

    const references = this.findReferencesForDeclaration(resolution.declaration, {
      includeDeclaration: options?.includeDeclaration ?? false,
      limit: Math.max(1, options?.limit ?? 50),
    });

    return {
      resolution,
      references,
    };
  }

  private resolveReferenceTarget(symbol: string, filePath?: string): TsReferenceResolution {
    if (this.depsByFile.size === 0) {
      return {
        kind: "unresolved",
        reason: "TS dependency graph is empty (index has no TS/JS files).",
        candidates: [],
      };
    }

    if (filePath) {
      const resolvedFile = this.resolveIndexedFilePath(filePath);
      if (!resolvedFile) {
        return {
          kind: "unresolved",
          reason: `TS file not indexed: ${filePath}`,
          candidates: [],
        };
      }

      const fileDecls = this.declarationsByFile.get(resolvedFile) ?? [];
      const exact = fileDecls.filter((decl) => decl.name === symbol);
      const partial = exact.length > 0
        ? exact
        : fileDecls.filter((decl) => decl.name.toLowerCase().includes(symbol.toLowerCase()));

      const candidates = partial
        .slice(0, 8)
        .map((decl) => `${decl.filePath}:${decl.line} ${decl.kind} ${decl.name}`);

      if (exact.length === 0) {
        return {
          kind: "ambiguous",
          reason: `no exact TS symbol match for '${symbol}' in ${resolvedFile}`,
          candidates,
        };
      }

      if (exact.length > 1) {
        return {
          kind: "ambiguous",
          reason: `multiple exact TS symbol matches for '${symbol}' in ${resolvedFile}`,
          candidates,
        };
      }

      return {
        kind: "resolved",
        declaration: exact[0],
        candidates,
      };
    }

    const exact = [...(this.declarationsBySymbol.get(symbol) ?? [])]
      .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line);

    if (exact.length === 1) {
      return {
        kind: "resolved",
        declaration: exact[0],
        candidates: exact.map((decl) => `${decl.filePath}:${decl.line} ${decl.kind} ${decl.name}`),
      };
    }

    if (exact.length > 1) {
      return {
        kind: "ambiguous",
        reason: `multiple exact TS symbol matches for '${symbol}'`,
        candidates: exact.slice(0, 8).map((decl) => `${decl.filePath}:${decl.line} ${decl.kind} ${decl.name}`),
      };
    }

    const partial = Array.from(this.declarationsBySymbol.entries())
      .filter(([name]) => name.toLowerCase().includes(symbol.toLowerCase()))
      .flatMap(([, decls]) => decls)
      .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line)
      .slice(0, 8)
      .map((decl) => `${decl.filePath}:${decl.line} ${decl.kind} ${decl.name}`);

    if (partial.length > 0) {
      return {
        kind: "ambiguous",
        reason: `no exact TS symbol match for '${symbol}' (partial matches exist)`,
        candidates: partial,
      };
    }

    return {
      kind: "unresolved",
      reason: `no indexed TS symbol candidates for '${symbol}'`,
      candidates: [],
    };
  }

  private findReferencesForDeclaration(
    declaration: TsSymbolDeclaration,
    options: { includeDeclaration: boolean; limit: number },
  ): string[] {
    const project = this.projectIndex.get(declaration.projectId);
    if (!project || project.files.size === 0) {
      return [];
    }

    const program = ts.createProgram({
      rootNames: Array.from(project.files),
      options: project.compilerOptions,
    });

    const checker = program.getTypeChecker();
    const sourceFile = findSourceFileByName(program, declaration.absolutePath);
    if (!sourceFile) {
      return [];
    }

    const anchorNode = findIdentifierAtPosition(sourceFile, declaration.position, declaration.name)
      ?? findIdentifierByName(sourceFile, declaration.name, declaration.line);
    if (!anchorNode) {
      return [];
    }

    const rawTarget = checker.getSymbolAtLocation(anchorNode);
    const targetSymbol = rawTarget ? canonicalSymbol(checker, rawTarget) : undefined;
    if (!targetSymbol) {
      return [];
    }

    const projectFiles = project.files;
    const refs: string[] = [];
    const seen = new Set<string>();

    for (const candidateSource of program.getSourceFiles()) {
      const abs = normalizePath(resolve(candidateSource.fileName));
      if (!projectFiles.has(abs)) continue;

      const relativePath = this.relativeFromAbsolute(abs);
      if (!relativePath) continue;

      const visit = (node: ts.Node) => {
        if (refs.length >= options.limit) return;

        if (ts.isIdentifier(node) && node.text === declaration.name) {
          const raw = checker.getSymbolAtLocation(node);
          const symbol = raw ? canonicalSymbol(checker, raw) : undefined;

          if (symbol === targetSymbol) {
            const isDeclaration = isDeclarationIdentifier(node);
            if (options.includeDeclaration || !isDeclaration) {
              const start = node.getStart(candidateSource, false);
              const loc = candidateSource.getLineAndCharacterOfPosition(start);
              const key = `${relativePath}:${loc.line + 1}:${loc.character + 1}`;
              if (!seen.has(key)) {
                seen.add(key);
                refs.push(key);
              }
            }
          }
        }

        if (refs.length < options.limit) {
          ts.forEachChild(node, visit);
        }
      };

      visit(candidateSource);
      if (refs.length >= options.limit) break;
    }

    return refs;
  }

  private relativeFromAbsolute(absolutePath: string): string | null {
    const normalized = normalizePath(resolve(absolutePath));

    const mapped = this.relativeByAbsolute.get(normalized);
    if (mapped) return mapped;

    for (const root of this.roots) {
      const rel = normalizePath(relative(root, normalized));
      if (!rel.startsWith("../") && rel !== "..") {
        return rel;
      }
    }

    return null;
  }

  private resolveIndexedFilePath(inputPath: string): string | null {
    const normalized = normalizePath(inputPath);

    if (this.depsByFile.has(normalized)) {
      return normalized;
    }

    if (isAbsolute(inputPath)) {
      const absNormalized = normalizePath(resolve(inputPath));
      const fromAbsolute = this.relativeByAbsolute.get(absNormalized);
      if (fromAbsolute) return fromAbsolute;
    }

    const variants = tryPathVariants(normalized);
    for (const variant of variants) {
      if (this.depsByFile.has(variant)) {
        return variant;
      }
    }

    for (const root of this.roots) {
      const rel = normalizePath(relative(root, resolve(inputPath)));
      if (!rel.startsWith("../") && rel !== ".." && this.depsByFile.has(rel)) {
        return rel;
      }
    }

    return null;
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

function extractFileFacts(
  content: string,
  fileName: string,
): {
  edges: Array<{ rawSpecifier: string; edgeKind: TsEdgeKind }>;
  declarations: Array<{ name: string; kind: string; position: number; line: number }>;
} {
  const source = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, inferScriptKind(fileName));
  const edges: Array<{ rawSpecifier: string; edgeKind: TsEdgeKind }> = [];
  const declarations: Array<{ name: string; kind: string; position: number; line: number }> = [];

  const pushEdge = (rawSpecifier: string, edgeKind: TsEdgeKind) => {
    const spec = rawSpecifier.trim();
    if (!spec) return;
    edges.push({ rawSpecifier: spec, edgeKind });
  };

  const pushDeclaration = (nameNode: ts.Identifier, kind: string) => {
    const pos = nameNode.getStart(source, false);
    const line = source.getLineAndCharacterOfPosition(pos).line + 1;
    declarations.push({
      name: nameNode.text,
      kind,
      position: pos,
      line,
    });
  };

  const walk = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (!node.importClause) {
        pushEdge(specifier, "side-effect");
      } else if (node.importClause.isTypeOnly) {
        pushEdge(specifier, "type-only");
      } else {
        pushEdge(specifier, "import");
      }
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (node.isTypeOnly) {
        pushEdge(specifier, "type-only");
      } else {
        pushEdge(specifier, "reexport");
      }
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0
    ) {
      const arg = node.arguments[0];
      if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
        pushEdge(arg.text, "dynamic-literal");
      } else {
        pushEdge(arg.getText(source), "dynamic-unresolved");
      }
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      pushDeclaration(node.name, "function");
    } else if (ts.isClassDeclaration(node) && node.name) {
      pushDeclaration(node.name, "class");
    } else if (ts.isInterfaceDeclaration(node)) {
      pushDeclaration(node.name, "interface");
    } else if (ts.isTypeAliasDeclaration(node)) {
      pushDeclaration(node.name, "type");
    } else if (ts.isEnumDeclaration(node)) {
      pushDeclaration(node.name, "enum");
    } else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      pushDeclaration(node.name, "method");
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      pushDeclaration(node.name, "variable");
    }

    ts.forEachChild(node, walk);
  };

  walk(source);

  const dedupDecls = new Map<string, { name: string; kind: string; position: number; line: number }>();
  for (const decl of declarations) {
    const key = `${decl.name}:${decl.line}:${decl.kind}`;
    if (!dedupDecls.has(key)) {
      dedupDecls.set(key, decl);
    }
  }

  return {
    edges,
    declarations: Array.from(dedupDecls.values()),
  };
}

function inferScriptKind(fileName: string): ts.ScriptKind {
  const ext = extname(fileName).toLowerCase();
  switch (ext) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function findSourceFileByName(program: ts.Program, absolutePath: string): ts.SourceFile | undefined {
  const target = normalizePath(resolve(absolutePath));
  return program.getSourceFiles().find((source) => normalizePath(resolve(source.fileName)) === target);
}

function findIdentifierAtPosition(sourceFile: ts.SourceFile, position: number, expectedName: string): ts.Identifier | null {
  let found: ts.Identifier | null = null;

  const walk = (node: ts.Node) => {
    if (found) return;

    if (position < node.getFullStart() || position > node.getEnd()) {
      return;
    }

    if (ts.isIdentifier(node) && node.text === expectedName) {
      const start = node.getStart(sourceFile, false);
      if (start === position) {
        found = node;
        return;
      }
    }

    ts.forEachChild(node, walk);
  };

  walk(sourceFile);
  return found;
}

function findIdentifierByName(sourceFile: ts.SourceFile, expectedName: string, preferredLine?: number): ts.Identifier | null {
  let fallback: ts.Identifier | null = null;

  const walk = (node: ts.Node) => {
    if (!ts.isIdentifier(node) || node.text !== expectedName) {
      ts.forEachChild(node, walk);
      return;
    }

    if (!isDeclarationIdentifier(node)) {
      ts.forEachChild(node, walk);
      return;
    }

    if (preferredLine) {
      const start = node.getStart(sourceFile, false);
      const line = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
      if (line === preferredLine) {
        fallback = node;
        return;
      }
    }

    if (!fallback) {
      fallback = node;
    }

    ts.forEachChild(node, walk);
  };

  walk(sourceFile);
  return fallback;
}

function canonicalSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      return checker.getAliasedSymbol(symbol);
    } catch {
      return symbol;
    }
  }

  return symbol;
}

function isDeclarationIdentifier(node: ts.Identifier): boolean {
  const helper = (ts as unknown as { isDeclarationName?: (node: ts.Node) => boolean }).isDeclarationName;
  if (typeof helper === "function") {
    return helper(node);
  }

  const parent = node.parent;
  if (!parent) return false;

  return (
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isClassDeclaration(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isInterfaceDeclaration(parent) && parent.name === node) ||
    (ts.isTypeAliasDeclaration(parent) && parent.name === node) ||
    (ts.isEnumDeclaration(parent) && parent.name === node) ||
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node)
  );
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
