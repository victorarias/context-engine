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
  private visibleTsFiles = new Set<string>();

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

  private projectVersions = new Map<string, number>();
  private projectProgramCache = new Map<string, { version: number; program: ts.Program }>();
  private programCacheHits = 0;
  private programCacheMisses = 0;

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
    this.clearAll();

    const tsFiles = visibleFiles
      .map(normalizePath)
      .filter((path) => TS_EXTENSIONS.has(extname(path).toLowerCase()));

    this.visibleTsFiles = new Set(tsFiles);

    for (const relativePath of tsFiles) {
      this.upsertFileAnalysis(relativePath);
    }

    this.recomputeStats();
  }

  applyDelta(params: {
    visibleFiles: string[];
    changedPaths: string[];
    removedPaths: string[];
    forceRebuild?: boolean;
  }): void {
    if (params.forceRebuild || this.stats.lastBuiltAt === 0) {
      this.rebuild(params.visibleFiles);
      return;
    }

    const visibleTs = new Set(
      params.visibleFiles
        .map(normalizePath)
        .filter((path) => TS_EXTENSIONS.has(extname(path).toLowerCase())),
    );

    this.visibleTsFiles = visibleTs;

    const removeCandidates = new Set<string>();
    for (const path of params.removedPaths) {
      const normalized = normalizePath(path);
      if (TS_EXTENSIONS.has(extname(normalized).toLowerCase())) {
        removeCandidates.add(normalized);
      }
    }

    for (const path of params.changedPaths) {
      const normalized = normalizePath(path);
      if (!visibleTs.has(normalized) || !TS_EXTENSIONS.has(extname(normalized).toLowerCase())) {
        removeCandidates.add(normalized);
      }
    }

    for (const existing of Array.from(this.depsByFile.keys())) {
      if (!visibleTs.has(existing)) {
        removeCandidates.add(existing);
      }
    }

    for (const filePath of removeCandidates) {
      this.removeFileAnalysis(filePath);
    }

    for (const path of params.changedPaths) {
      const normalized = normalizePath(path);
      if (visibleTs.has(normalized)) {
        this.upsertFileAnalysis(normalized);
      }
    }

    this.recomputeStats();
  }

  getStats(): TsDependencyStats {
    return { ...this.stats };
  }

  getProgramCacheStats(): { hits: number; misses: number; size: number } {
    return {
      hits: this.programCacheHits,
      misses: this.programCacheMisses,
      size: this.projectProgramCache.size,
    };
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

  private clearAll(): void {
    this.visibleTsFiles.clear();
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

    this.projectVersions.clear();
    this.projectProgramCache.clear();
  }

  private recomputeStats(): void {
    let edgesTotal = 0;
    let edgesResolved = 0;
    let edgesUnresolved = 0;

    for (const edges of this.depsByFile.values()) {
      for (const edge of edges) {
        edgesTotal += 1;
        if (edge.resolvedTarget) edgesResolved += 1;
        else edgesUnresolved += 1;
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

  private upsertFileAnalysis(relativePath: string): void {
    const normalized = normalizePath(relativePath);

    if (!TS_EXTENSIONS.has(extname(normalized).toLowerCase())) {
      this.removeFileAnalysis(normalized);
      return;
    }

    const absolutePath = this.resolveInRoots(normalized);
    if (!absolutePath || !existsSync(absolutePath)) {
      this.removeFileAnalysis(normalized);
      return;
    }

    let content: string;
    try {
      content = readFileSync(absolutePath, "utf-8");
    } catch {
      this.removeFileAnalysis(normalized);
      return;
    }

    this.removeFileAnalysis(normalized);

    const absoluteNormalized = normalizePath(resolve(absolutePath));
    this.absoluteByRelative.set(normalized, absoluteNormalized);
    this.relativeByAbsolute.set(absoluteNormalized, normalized);

    const project = this.getOwningProject(absolutePath);
    this.projectByFile.set(normalized, project.id);

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
        sourceFile: normalized,
        rawSpecifier: edge.rawSpecifier,
        edgeKind: edge.edgeKind,
        projectId: project.id,
        confidence: resolved.confidence,
        resolvedTarget: resolved.target,
        unresolvedReason: resolved.reason,
      };
    });

    this.depsByFile.set(normalized, edges);
    for (const edge of edges) {
      const specSet = this.importersBySpecifier.get(edge.rawSpecifier) ?? new Set<string>();
      specSet.add(normalized);
      this.importersBySpecifier.set(edge.rawSpecifier, specSet);

      if (edge.resolvedTarget) {
        const targetSet = this.importersByTarget.get(edge.resolvedTarget) ?? new Set<string>();
        targetSet.add(normalized);
        this.importersByTarget.set(edge.resolvedTarget, targetSet);
      }
    }

    const declarations: TsSymbolDeclaration[] = facts.declarations.map((decl) => ({
      name: decl.name,
      kind: decl.kind,
      filePath: normalized,
      absolutePath: absoluteNormalized,
      position: decl.position,
      line: decl.line,
      projectId: project.id,
    }));

    this.declarationsByFile.set(normalized, declarations);
    for (const declaration of declarations) {
      const bucket = this.declarationsBySymbol.get(declaration.name) ?? [];
      bucket.push(declaration);
      this.declarationsBySymbol.set(declaration.name, bucket);
    }

    this.bumpProjectVersion(project.id);
  }

  private removeFileAnalysis(relativePath: string): void {
    const normalized = normalizePath(relativePath);

    const previousEdges = this.depsByFile.get(normalized) ?? [];
    for (const edge of previousEdges) {
      const specSet = this.importersBySpecifier.get(edge.rawSpecifier);
      if (specSet) {
        specSet.delete(normalized);
        if (specSet.size === 0) {
          this.importersBySpecifier.delete(edge.rawSpecifier);
        }
      }

      if (edge.resolvedTarget) {
        const targetSet = this.importersByTarget.get(edge.resolvedTarget);
        if (targetSet) {
          targetSet.delete(normalized);
          if (targetSet.size === 0) {
            this.importersByTarget.delete(edge.resolvedTarget);
          }
        }
      }
    }
    this.depsByFile.delete(normalized);

    const previousDecls = this.declarationsByFile.get(normalized) ?? [];
    for (const declaration of previousDecls) {
      const bucket = this.declarationsBySymbol.get(declaration.name);
      if (!bucket) continue;

      const remaining = bucket.filter(
        (entry) => !(entry.filePath === declaration.filePath && entry.line === declaration.line && entry.kind === declaration.kind),
      );

      if (remaining.length === 0) {
        this.declarationsBySymbol.delete(declaration.name);
      } else {
        this.declarationsBySymbol.set(declaration.name, remaining);
      }
    }
    this.declarationsByFile.delete(normalized);

    const absolute = this.absoluteByRelative.get(normalized);
    if (absolute) {
      this.relativeByAbsolute.delete(absolute);
      this.absoluteByRelative.delete(normalized);
    }

    const projectId = this.projectByFile.get(normalized);
    this.projectByFile.delete(normalized);

    if (projectId) {
      const project = this.projectIndex.get(projectId);
      if (project && absolute) {
        project.files.delete(absolute);
      }
      if (project && project.files.size === 0) {
        this.projectIndex.delete(projectId);
      }
      this.bumpProjectVersion(projectId);
    }
  }

  private bumpProjectVersion(projectId: string): void {
    const next = (this.projectVersions.get(projectId) ?? 0) + 1;
    this.projectVersions.set(projectId, next);
    this.projectProgramCache.delete(projectId);
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

      const fileDeclarations = this.declarationsByFile.get(resolvedFile) ?? [];
      const exact = fileDeclarations.filter((declaration) => declaration.name === symbol);
      const partial = exact.length > 0
        ? exact
        : fileDeclarations.filter((declaration) => declaration.name.toLowerCase().includes(symbol.toLowerCase()));

      const candidates = partial
        .slice(0, 8)
        .map((declaration) => `${declaration.filePath}:${declaration.line} ${declaration.kind} ${declaration.name}`);

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
        candidates: exact.map((declaration) => `${declaration.filePath}:${declaration.line} ${declaration.kind} ${declaration.name}`),
      };
    }

    if (exact.length > 1) {
      return {
        kind: "ambiguous",
        reason: `multiple exact TS symbol matches for '${symbol}'`,
        candidates: exact.slice(0, 8).map((declaration) => `${declaration.filePath}:${declaration.line} ${declaration.kind} ${declaration.name}`),
      };
    }

    const partial = Array.from(this.declarationsBySymbol.entries())
      .filter(([name]) => name.toLowerCase().includes(symbol.toLowerCase()))
      .flatMap(([, declarations]) => declarations)
      .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line)
      .slice(0, 8)
      .map((declaration) => `${declaration.filePath}:${declaration.line} ${declaration.kind} ${declaration.name}`);

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

    const program = this.getProjectProgram(declaration.projectId, project);
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

    const references: string[] = [];
    const seen = new Set<string>();

    for (const candidateSource of program.getSourceFiles()) {
      const absolute = normalizePath(resolve(candidateSource.fileName));
      if (!project.files.has(absolute)) continue;

      const relativePath = this.relativeFromAbsolute(absolute);
      if (!relativePath) continue;

      const visit = (node: ts.Node) => {
        if (references.length >= options.limit) return;

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
                references.push(key);
              }
            }
          }
        }

        if (references.length < options.limit) {
          ts.forEachChild(node, visit);
        }
      };

      visit(candidateSource);
      if (references.length >= options.limit) {
        break;
      }
    }

    return references;
  }

  private getProjectProgram(projectId: string, project: ProjectIndex): ts.Program {
    const version = this.projectVersions.get(projectId) ?? 0;
    const cached = this.projectProgramCache.get(projectId);

    if (cached && cached.version === version) {
      this.programCacheHits += 1;
      return cached.program;
    }

    const program = ts.createProgram({
      rootNames: Array.from(project.files),
      options: project.compilerOptions,
    });

    this.programCacheMisses += 1;
    this.projectProgramCache.set(projectId, { version, program });
    return program;
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

    const resolvedModule = ts.resolveModuleName(raw, sourceAbsolutePath, project.compilerOptions, ts.sys);
    const resolvedFile = resolvedModule.resolvedModule?.resolvedFileName;

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
    const position = nameNode.getStart(source, false);
    const line = source.getLineAndCharacterOfPosition(position).line + 1;
    declarations.push({
      name: nameNode.text,
      kind,
      position,
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

  const dedupDeclarations = new Map<string, { name: string; kind: string; position: number; line: number }>();
  for (const declaration of declarations) {
    const key = `${declaration.name}:${declaration.line}:${declaration.kind}`;
    if (!dedupDeclarations.has(key)) {
      dedupDeclarations.set(key, declaration);
    }
  }

  return {
    edges,
    declarations: Array.from(dedupDeclarations.values()),
  };
}

function inferScriptKind(fileName: string): ts.ScriptKind {
  const extension = extname(fileName).toLowerCase();

  switch (extension) {
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
    for (const extension of [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".d.ts"]) {
      variants.add(`${path}${extension}`);
    }

    for (const extension of [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]) {
      variants.add(`${path}/index${extension}`);
    }
  }

  return Array.from(variants);
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}
