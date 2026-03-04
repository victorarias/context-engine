import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { TreeSitterLoader } from "../chunker/tree-sitter-loader.js";
import { PythonPackageResolver } from "./python-resolver/python-package-resolver.js";

export type PyEdgeKind = "import" | "from-import" | "relative-import" | "dynamic";

export interface PyDependencyEdge {
  sourceFile: string;
  rawSpecifier: string;
  importedNames: string[];
  resolvedTarget?: string;
  edgeKind: PyEdgeKind;
  level: number;
  confidence: "high" | "medium" | "low";
  unresolvedReason?: string;
}

export interface PyDependencyStats {
  filesIndexed: number;
  edgesTotal: number;
  edgesResolved: number;
  edgesUnresolved: number;
  resolutionSuccessRate: number;
  internalEdgesTotal: number;
  internalEdgesResolved: number;
  internalResolutionRate: number;
  stdlibEdges: number;
  externalEdges: number;
  aliasResolvedEdges: number;
  lastBuiltAt: number;
  parserReady: boolean;
}

type ParsedImportStatement = {
  module: string;
  level: number;
  importedNames: string[];
  edgeKind: "import" | "from-import" | "relative-import";
  conditional: boolean;
};

const PY_EXTENSIONS = new Set([".py"]);

interface PyDependencyServiceOptions {
  importAliases?: Record<string, string>;
}

export class PyDependencyService {
  private roots: string[];
  private readonly treeSitter = new TreeSitterLoader();
  private readonly packageResolver: PythonPackageResolver;
  private parserReady = false;
  private warmupAttempted = false;

  private visiblePyFiles = new Set<string>();
  private moduleToFiles = new Map<string, string[]>();
  private namespaceToDirs = new Map<string, string[]>();

  private depsByFile = new Map<string, PyDependencyEdge[]>();
  private importersByTarget = new Map<string, Set<string>>();
  private importersByModule = new Map<string, Set<string>>();
  private sysPathHintDirsByFile = new Map<string, string[]>();
  private sysPathMutationByFile = new Map<string, boolean>();

  private stats: PyDependencyStats = {
    filesIndexed: 0,
    edgesTotal: 0,
    edgesResolved: 0,
    edgesUnresolved: 0,
    resolutionSuccessRate: 0,
    internalEdgesTotal: 0,
    internalEdgesResolved: 0,
    internalResolutionRate: 0,
    stdlibEdges: 0,
    externalEdges: 0,
    aliasResolvedEdges: 0,
    lastBuiltAt: 0,
    parserReady: false,
  };

  constructor(roots: string[], options?: PyDependencyServiceOptions) {
    this.roots = roots.map((root) => resolve(root));
    this.packageResolver = new PythonPackageResolver(this.roots, {
      importAliases: options?.importAliases,
    });
  }

  async warmup(): Promise<void> {
    if (this.warmupAttempted) {
      return;
    }

    this.warmupAttempted = true;
    await this.treeSitter.warmup(["python"]);
    this.parserReady = this.treeSitter.isReady("python");
    this.stats.parserReady = this.parserReady;
  }

  setRoots(roots: string[]): void {
    this.roots = roots.map((root) => resolve(root));
    this.packageResolver.setRoots(this.roots);
  }

  setImportAliases(importAliases: Record<string, string>): void {
    this.packageResolver.setOptions({ importAliases });
  }

  rebuild(visibleFiles: string[]): void {
    this.clearAll();

    const pyFiles = visibleFiles
      .map(normalizePath)
      .filter((filePath) => PY_EXTENSIONS.has(extname(filePath).toLowerCase()));

    this.visiblePyFiles = new Set(pyFiles);
    this.moduleToFiles = this.buildModuleIndex(pyFiles);
    this.namespaceToDirs = this.buildNamespaceIndex(pyFiles);

    for (const relativePath of pyFiles) {
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
    const shouldRebuild =
      params.forceRebuild === true ||
      this.stats.lastBuiltAt === 0 ||
      params.changedPaths.length > 0 ||
      params.removedPaths.length > 0;

    if (!shouldRebuild) {
      return;
    }

    this.rebuild(params.visibleFiles);
  }

  getFileEdges(filePath: string): PyDependencyEdge[] {
    const normalized = normalizePath(filePath);
    return [...(this.depsByFile.get(normalized) ?? [])];
  }

  findImporters(target: string, options?: { limit?: number }): string[] {
    const limit = Math.max(1, options?.limit ?? 100);
    const normalizedTarget = normalizePath(target);

    const candidates = new Set<string>([
      normalizedTarget,
      stripPyExtension(normalizedTarget),
      normalizedTarget.replace(/^\/+/, ""),
      stripPyExtension(normalizedTarget.replace(/^\/+/, "")),
    ]);

    const fromPathModule = moduleNameFromPath(normalizedTarget);
    if (fromPathModule) {
      candidates.add(fromPathModule);
    }

    if (!extname(normalizedTarget) && normalizedTarget.includes("/")) {
      candidates.add(normalizedTarget.replaceAll("/", "."));
      candidates.add(`${normalizedTarget}/__init__.py`);
    }

    if (looksLikeDottedModule(normalizedTarget)) {
      candidates.add(normalizedTarget);
      const asPath = `${normalizedTarget.replaceAll(".", "/")}.py`;
      const asInit = `${normalizedTarget.replaceAll(".", "/")}/__init__.py`;
      candidates.add(asPath);
      candidates.add(asInit);
      candidates.add(stripPyExtension(asPath));
      candidates.add(stripPyExtension(asInit));
    }

    const matches = new Set<string>();

    for (const candidate of candidates) {
      const byTarget = this.importersByTarget.get(candidate);
      if (byTarget) {
        for (const importer of byTarget) {
          matches.add(importer);
        }
      }

      const byModule = this.importersByModule.get(candidate);
      if (byModule) {
        for (const importer of byModule) {
          matches.add(importer);
        }
      }
    }

    return Array.from(matches).sort().slice(0, limit);
  }

  getStats(): PyDependencyStats {
    return {
      ...this.stats,
      parserReady: this.parserReady,
    };
  }

  private clearAll(): void {
    this.visiblePyFiles.clear();
    this.moduleToFiles.clear();
    this.namespaceToDirs.clear();
    this.depsByFile.clear();
    this.importersByTarget.clear();
    this.importersByModule.clear();
    this.sysPathHintDirsByFile.clear();
    this.sysPathMutationByFile.clear();
  }

  private recomputeStats(): void {
    let edgesTotal = 0;
    let edgesResolved = 0;
    let internalEdgesTotal = 0;
    let internalEdgesResolved = 0;
    let stdlibEdges = 0;
    let externalEdges = 0;
    let aliasResolvedEdges = 0;

    for (const edges of this.depsByFile.values()) {
      edgesTotal += edges.length;
      for (const edge of edges) {
        const reason = edge.unresolvedReason ?? "";

        if (edge.resolvedTarget) {
          edgesResolved += 1;
        }

        if (reason.includes("alias-resolved")) {
          aliasResolvedEdges += 1;
        }

        const stdlib = reason.includes("python stdlib module") || isPythonStdlibEdge(edge);
        const external = reason.includes("external package") || reason.includes("third-party");
        const internal = edge.edgeKind === "relative-import"
          || edge.rawSpecifier.startsWith(".")
          || !!edge.resolvedTarget
          || reason.includes("alias-resolved")
          || (!stdlib && !external && edge.level > 0);

        if (stdlib) {
          stdlibEdges += 1;
          continue;
        }

        if (external && !internal) {
          externalEdges += 1;
          continue;
        }

        if (internal) {
          internalEdgesTotal += 1;
          if (edge.resolvedTarget) {
            internalEdgesResolved += 1;
          }
          continue;
        }

        externalEdges += 1;
      }
    }

    const edgesUnresolved = Math.max(0, edgesTotal - edgesResolved);

    this.stats = {
      filesIndexed: this.visiblePyFiles.size,
      edgesTotal,
      edgesResolved,
      edgesUnresolved,
      resolutionSuccessRate: edgesTotal === 0 ? 0 : edgesResolved / edgesTotal,
      internalEdgesTotal,
      internalEdgesResolved,
      internalResolutionRate: internalEdgesTotal === 0 ? 0 : internalEdgesResolved / internalEdgesTotal,
      stdlibEdges,
      externalEdges,
      aliasResolvedEdges,
      lastBuiltAt: Date.now(),
      parserReady: this.parserReady,
    };
  }

  private buildModuleIndex(relativePaths: string[]): Map<string, string[]> {
    const moduleIndex = new Map<string, string[]>();

    for (const relativePath of relativePaths) {
      const moduleName = moduleNameFromPath(relativePath);
      if (!moduleName) continue;

      const existing = moduleIndex.get(moduleName) ?? [];
      existing.push(relativePath);
      moduleIndex.set(moduleName, existing);
    }

    return moduleIndex;
  }

  private buildNamespaceIndex(relativePaths: string[]): Map<string, string[]> {
    const namespaceIndex = new Map<string, string[]>();

    for (const relativePath of relativePaths) {
      const dirPath = normalizePath(dirname(relativePath));
      if (!dirPath || dirPath === ".") continue;

      const parts = dirPath.split("/").filter(Boolean);
      for (let length = 1; length <= parts.length; length++) {
        const moduleName = parts.slice(0, length).join(".");
        const dir = parts.slice(0, length).join("/");

        const bucket = namespaceIndex.get(moduleName) ?? [];
        bucket.push(dir);
        namespaceIndex.set(moduleName, bucket);
      }
    }

    return namespaceIndex;
  }

  private upsertFileAnalysis(relativePath: string): void {
    const normalized = normalizePath(relativePath);

    if (!PY_EXTENSIONS.has(extname(normalized).toLowerCase())) {
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

    const sysPathHints = extractSysPathHintDirs(content, absolutePath);
    this.sysPathHintDirsByFile.set(normalized, sysPathHints);
    this.sysPathMutationByFile.set(normalized, hasSysPathMutation(content));

    const statements = this.extractImportStatements(content);
    const edges: PyDependencyEdge[] = [];

    for (const statement of statements) {
      edges.push(...this.statementToEdges(statement, normalized));
    }

    const deduped = dedupeEdges(edges);

    this.depsByFile.set(normalized, deduped);

    for (const edge of deduped) {
      this.indexImporterByModule(edge.rawSpecifier, normalized);

      if (edge.resolvedTarget) {
        for (const targetKey of buildTargetKeys(edge.resolvedTarget)) {
          const bucket = this.importersByTarget.get(targetKey) ?? new Set<string>();
          bucket.add(normalized);
          this.importersByTarget.set(targetKey, bucket);
        }
      }
    }
  }

  private removeFileAnalysis(relativePath: string): void {
    const normalized = normalizePath(relativePath);

    const previousEdges = this.depsByFile.get(normalized) ?? [];

    for (const edge of previousEdges) {
      for (const key of buildModuleKeys(edge.rawSpecifier)) {
        const bucket = this.importersByModule.get(key);
        if (!bucket) continue;

        bucket.delete(normalized);
        if (bucket.size === 0) {
          this.importersByModule.delete(key);
        }
      }

      if (edge.resolvedTarget) {
        for (const key of buildTargetKeys(edge.resolvedTarget)) {
          const bucket = this.importersByTarget.get(key);
          if (!bucket) continue;

          bucket.delete(normalized);
          if (bucket.size === 0) {
            this.importersByTarget.delete(key);
          }
        }
      }
    }

    this.depsByFile.delete(normalized);
    this.sysPathHintDirsByFile.delete(normalized);
    this.sysPathMutationByFile.delete(normalized);
  }

  private statementToEdges(statement: ParsedImportStatement, sourceFile: string): PyDependencyEdge[] {
    const output: PyDependencyEdge[] = [];

    const baseRawSpecifier = formatRawSpecifier(statement.module, statement.level);
    const primaryResolution = this.resolveModuleSpecifier({
      sourceFile,
      module: statement.module,
      level: statement.level,
    });

    const primaryConfidence = statement.conditional
      ? downgradeConfidence(primaryResolution.confidence)
      : primaryResolution.confidence;

    output.push({
      sourceFile,
      rawSpecifier: baseRawSpecifier,
      importedNames: statement.importedNames,
      resolvedTarget: primaryResolution.resolvedTarget,
      edgeKind: statement.edgeKind,
      level: statement.level,
      confidence: primaryConfidence,
      unresolvedReason: appendImportContextReason(primaryResolution.unresolvedReason, {
        conditional: statement.conditional,
      }),
    });

    if (statement.edgeKind !== "import" && statement.importedNames.length > 0) {
      for (const name of statement.importedNames) {
        if (!isValidModuleToken(name) || name === "*") continue;

        if (statement.module) {
          const childResolution = this.resolveModuleSpecifier({
            sourceFile,
            module: `${statement.module}.${name}`,
            level: statement.level,
          });

          if (childResolution.resolvedTarget && childResolution.resolvedTarget !== primaryResolution.resolvedTarget) {
            output.push({
              sourceFile,
              rawSpecifier: formatRawSpecifier(`${statement.module}.${name}`, statement.level),
              importedNames: [name],
              resolvedTarget: childResolution.resolvedTarget,
              edgeKind: statement.edgeKind,
              level: statement.level,
              confidence: statement.conditional ? downgradeConfidence(childResolution.confidence) : childResolution.confidence,
              unresolvedReason: appendImportContextReason(childResolution.unresolvedReason, {
                conditional: statement.conditional,
              }),
            });
          }

          continue;
        }

        const bareRelative = this.resolveModuleSpecifier({
          sourceFile,
          module: name,
          level: statement.level,
        });

        if (!bareRelative.resolvedTarget) continue;

        output.push({
          sourceFile,
          rawSpecifier: formatRawSpecifier(name, statement.level),
          importedNames: [name],
          resolvedTarget: bareRelative.resolvedTarget,
          edgeKind: "relative-import",
          level: statement.level,
          confidence: statement.conditional ? downgradeConfidence(bareRelative.confidence) : bareRelative.confidence,
          unresolvedReason: appendImportContextReason(bareRelative.unresolvedReason, {
            conditional: statement.conditional,
          }),
        });
      }
    }

    return output;
  }

  private resolveModuleSpecifier(params: {
    sourceFile: string;
    module: string;
    level: number;
  }): {
    resolvedTarget?: string;
    confidence: "high" | "medium" | "low";
    unresolvedReason?: string;
  } {
    const sourcePackageParts = sourcePackagePartsForFile(params.sourceFile);
    const hasSysPathTweaks = this.sysPathMutationByFile.get(params.sourceFile) === true;

    const moduleParts = params.module
      .split(".")
      .map((part) => part.trim())
      .filter(Boolean);

    let fullModuleParts: string[];

    if (params.level > 0) {
      const ascend = Math.max(0, params.level - 1);
      if (ascend > sourcePackageParts.length) {
        return {
          confidence: "low",
          unresolvedReason: "relative import escapes package root",
        };
      }

      const baseParts = sourcePackageParts.slice(0, sourcePackageParts.length - ascend);
      fullModuleParts = [...baseParts, ...moduleParts];
    } else {
      fullModuleParts = moduleParts;
    }

    const fullModule = fullModuleParts.join(".");

    if (fullModule) {
      const moduleCandidates = this.packageResolver.resolveCandidates(fullModule);

      for (const candidate of moduleCandidates) {
        const localResolution = this.resolveLocalModule(candidate, params.sourceFile);
        if (!localResolution) continue;

        const aliasApplied = candidate !== fullModule;
        return {
          resolvedTarget: localResolution.target,
          confidence: aliasApplied && localResolution.confidence === "high" ? "medium" : localResolution.confidence,
          unresolvedReason: aliasApplied
            ? [localResolution.reason, `alias-resolved from '${fullModule}' -> '${candidate}'`].filter(Boolean).join("; ")
            : localResolution.reason,
        };
      }
    }

    const topLevel = fullModuleParts[0] ?? moduleParts[0] ?? "";
    if (topLevel && PYTHON_STDLIB.has(topLevel)) {
      return {
        confidence: "medium",
        unresolvedReason: "python stdlib module",
      };
    }

    if (params.level > 0) {
      return {
        confidence: "low",
        unresolvedReason: hasSysPathTweaks
          ? "relative module could not be resolved (sys.path modified in file)"
          : "relative module could not be resolved",
      };
    }

    return {
      confidence: hasSysPathTweaks ? "medium" : "low",
      unresolvedReason: hasSysPathTweaks
        ? "external package or unresolved module (sys.path modified in file)"
        : "external package or unresolved module",
    };
  }

  private resolveLocalModule(moduleName: string, sourceFile: string): {
    target: string;
    confidence: "high" | "medium";
    reason?: string;
  } | undefined {
    const fileCandidates = this.moduleToFiles.get(moduleName) ?? [];
    if (fileCandidates.length > 0) {
      return {
        target: choosePreferredPythonTarget(fileCandidates),
        confidence: "high",
      };
    }

    const namespaceCandidates = this.namespaceToDirs.get(moduleName) ?? [];
    if (namespaceCandidates.length > 0) {
      return {
        target: choosePreferredNamespaceTarget(namespaceCandidates),
        confidence: "medium",
        reason: "namespace package (PEP 420)",
      };
    }

    const hintDirs = this.sysPathHintDirsByFile.get(sourceFile) ?? [];
    const viaHint = this.resolveModuleViaSysPathHints(moduleName, hintDirs);
    if (viaHint) {
      return {
        target: viaHint,
        confidence: "medium",
        reason: "resolved via sys.path hint",
      };
    }

    return undefined;
  }

  private resolveInRoots(relativePath: string): string | null {
    const normalized = normalizePath(relativePath);

    for (const root of this.roots) {
      const candidate = resolve(root, normalized);
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private resolveModuleViaSysPathHints(moduleName: string, hintDirs: string[]): string | undefined {
    if (!moduleName || hintDirs.length === 0) return undefined;

    const moduleRel = moduleName.replaceAll(".", "/");

    for (const hintDir of hintDirs) {
      const fileCandidate = resolve(hintDir, `${moduleRel}.py`);
      const packageInitCandidate = resolve(hintDir, moduleRel, "__init__.py");
      const namespaceDirCandidate = resolve(hintDir, moduleRel);

      const resolvedFile = this.asIndexedRelativePath(fileCandidate);
      if (resolvedFile) return resolvedFile;

      const resolvedInit = this.asIndexedRelativePath(packageInitCandidate);
      if (resolvedInit) return resolvedInit;

      const resolvedNamespace = this.asIndexedRelativePath(namespaceDirCandidate, { allowDirectory: true });
      if (resolvedNamespace) return resolvedNamespace;
    }

    return undefined;
  }

  private asIndexedRelativePath(absolutePath: string, options?: { allowDirectory?: boolean }): string | undefined {
    const absoluteFsPath = resolve(absolutePath);
    if (!existsSync(absoluteFsPath)) {
      return undefined;
    }

    for (const root of this.roots) {
      const rel = normalizePath(relative(root, absoluteFsPath));
      if (rel.startsWith("../") || rel === "..") continue;

      if (!options?.allowDirectory) {
        if (this.visiblePyFiles.has(rel)) {
          return rel;
        }
      } else {
        if (this.visiblePyFiles.has(rel)) {
          return rel;
        }

        for (const entry of this.visiblePyFiles) {
          if (entry.startsWith(`${rel}/`)) {
            return rel;
          }
        }
      }
    }

    return undefined;
  }

  private indexImporterByModule(rawSpecifier: string, sourceFile: string): void {
    for (const key of buildModuleKeys(rawSpecifier)) {
      const bucket = this.importersByModule.get(key) ?? new Set<string>();
      bucket.add(sourceFile);
      this.importersByModule.set(key, bucket);
    }
  }

  private extractImportStatements(content: string): ParsedImportStatement[] {
    if (this.parserReady) {
      const parsed = this.extractImportStatementsWithTreeSitter(content);
      if (parsed.length > 0) {
        return parsed;
      }
    }

    return extractImportStatementsFallback(content);
  }

  private extractImportStatementsWithTreeSitter(content: string): ParsedImportStatement[] {
    const parser = this.treeSitter.getParser("python");
    if (!parser) {
      return [];
    }

    const tree = parser.parse(content);
    const statements: ParsedImportStatement[] = [];

    try {
      const visit = (node: any, conditional: boolean) => {
        if (!node) return;

        if (node.type === "import_statement") {
          statements.push(...parseImportStatementNode(node, conditional));
        } else if (node.type === "import_from_statement") {
          const parsed = parseImportFromNode(node, conditional);
          if (parsed) {
            statements.push(parsed);
          }
        }

        const nextConditional = conditional || CONDITIONAL_IMPORT_CONTEXT_TYPES.has(node.type);

        for (let index = 0; index < node.childCount; index++) {
          visit(node.child(index), nextConditional);
        }
      };

      visit(tree.rootNode, false);
    } finally {
      tree.delete();
    }

    return statements;
  }
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function normalizeAbsolutePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return normalized.endsWith("/") && normalized.length > 1 ? normalized.slice(0, -1) : normalized;
}

function stripPyExtension(path: string): string {
  return path.replace(/\.py$/i, "");
}

function moduleNameFromPath(relativePath: string): string {
  const normalized = normalizePath(relativePath);
  if (!normalized.endsWith(".py")) return "";

  if (normalized.endsWith("/__init__.py")) {
    const dir = dirname(normalized);
    return dir === "." ? "" : dir.replaceAll("/", ".");
  }

  return stripPyExtension(normalized).replaceAll("/", ".");
}

function sourcePackagePartsForFile(relativePath: string): string[] {
  const normalized = normalizePath(relativePath);
  const packagePath = dirname(normalized);

  if (!packagePath || packagePath === ".") {
    return [];
  }

  return packagePath.split("/").filter(Boolean);
}

function formatRawSpecifier(module: string, level: number): string {
  const dots = level > 0 ? ".".repeat(level) : "";
  if (!module) {
    return dots || ".";
  }

  return `${dots}${module}`;
}

function parseImportStatementNode(node: any, conditional: boolean): ParsedImportStatement[] {
  const statements: ParsedImportStatement[] = [];

  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index);
    if (!child) continue;

    if (child.type === "dotted_name") {
      const moduleName = child.text?.trim() ?? "";
      if (!moduleName) continue;

      statements.push({
        module: moduleName,
        level: 0,
        importedNames: [moduleName],
        edgeKind: "import",
        conditional,
      });
      continue;
    }

    if (child.type === "aliased_import") {
      const dotted = findFirstChildByType(child, "dotted_name");
      const moduleName = dotted?.text?.trim() ?? "";
      if (!moduleName) continue;

      const aliasNode = findLastIdentifier(child);
      const alias = aliasNode?.text?.trim();

      statements.push({
        module: moduleName,
        level: 0,
        importedNames: alias ? [alias] : [moduleName],
        edgeKind: "import",
        conditional,
      });
    }
  }

  return statements;
}

function parseImportFromNode(node: any, conditional: boolean): ParsedImportStatement | null {
  let seenImportKeyword = false;
  let module = "";
  let level = 0;
  const importedNames: string[] = [];

  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index);
    if (!child) continue;

    if (child.type === "import") {
      seenImportKeyword = true;
      continue;
    }

    if (!seenImportKeyword) {
      if (child.type === "relative_import") {
        const importPrefix = findFirstChildByType(child, "import_prefix");
        level = countDots(importPrefix?.text ?? "");

        const dottedName = findFirstChildByType(child, "dotted_name");
        module = dottedName?.text?.trim() ?? "";
        continue;
      }

      if (child.type === "dotted_name") {
        module = child.text?.trim() ?? "";
      }

      continue;
    }

    if (child.type === "dotted_name") {
      const imported = child.text?.trim() ?? "";
      if (imported) {
        importedNames.push(imported);
      }
      continue;
    }

    if (child.type === "aliased_import") {
      const alias = findLastIdentifier(child)?.text?.trim();
      const dotted = findFirstChildByType(child, "dotted_name")?.text?.trim() ?? "";

      if (alias) {
        importedNames.push(alias);
      } else if (dotted) {
        importedNames.push(dotted);
      }
      continue;
    }

    if (child.type === "wildcard_import") {
      importedNames.push("*");
    }
  }

  const edgeKind: ParsedImportStatement["edgeKind"] = level > 0 ? "relative-import" : "from-import";

  if (!module && level === 0 && importedNames.length === 0) {
    return null;
  }

  return {
    module,
    level,
    importedNames,
    edgeKind,
    conditional,
  };
}

function findFirstChildByType(node: any, type: string): any | null {
  if (!node) return null;

  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index);
    if (!child) continue;

    if (child.type === type) {
      return child;
    }
  }

  return null;
}

function findLastIdentifier(node: any): any | null {
  if (!node) return null;

  let latest: any | null = null;

  const visit = (current: any) => {
    if (!current) return;

    if (current.type === "identifier") {
      latest = current;
    }

    for (let index = 0; index < current.childCount; index++) {
      visit(current.child(index));
    }
  };

  visit(node);
  return latest;
}

function countDots(value: string): number {
  return (value.match(/\./g) ?? []).length;
}

function downgradeConfidence(value: "high" | "medium" | "low"): "high" | "medium" | "low" {
  if (value === "high") return "medium";
  if (value === "medium") return "low";
  return "low";
}

function appendImportContextReason(
  existing: string | undefined,
  context: { conditional: boolean },
): string | undefined {
  if (!context.conditional) {
    return existing;
  }

  const suffix = "conditional import context";
  if (!existing) return suffix;
  if (existing.includes(suffix)) return existing;
  return `${existing}; ${suffix}`;
}

function hasSysPathMutation(content: string): boolean {
  return /\bsys\.path\s*\./.test(content);
}

function extractSysPathHintDirs(content: string, sourceAbsolutePath: string): string[] {
  const out = new Set<string>();
  const sourceDir = dirname(sourceAbsolutePath);

  const add = (rawPath: string) => {
    const trimmed = rawPath.trim();
    if (!trimmed) return;

    const absolute = trimmed.startsWith("/") ? resolve(trimmed) : resolve(sourceDir, trimmed);
    out.add(normalizeAbsolutePath(absolute));
  };

  for (const match of content.matchAll(/\bsys\.path\.(?:append|insert)\s*\(([^\n)]*)\)/g)) {
    const callArgs = (match[1] ?? "").trim();
    if (!callArgs) continue;

    const literalMatches = Array.from(callArgs.matchAll(/["']([^"']+)["']/g));
    for (const literal of literalMatches) {
      const value = literal[1] ?? "";
      if (!value) continue;
      add(value);
    }
  }

  return Array.from(out);
}

const CONDITIONAL_IMPORT_CONTEXT_TYPES = new Set([
  "if_statement",
  "elif_clause",
  "else_clause",
  "try_statement",
  "except_clause",
  "finally_clause",
  "while_statement",
  "for_statement",
  "with_statement",
  "match_statement",
  "case_clause",
  "lambda",
]);

function looksLikeDottedModule(value: string): boolean {
  if (value.includes("/")) return false;
  return /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(value);
}

function isValidModuleToken(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function choosePreferredPythonTarget(targets: string[]): string {
  const sorted = [...targets].sort((a, b) => a.localeCompare(b));

  const moduleFile = sorted.find((path) => !path.endsWith("/__init__.py"));
  if (moduleFile) return moduleFile;

  return sorted[0]!;
}

function choosePreferredNamespaceTarget(targets: string[]): string {
  const unique = Array.from(new Set(targets)).sort((a, b) => a.localeCompare(b));
  return unique[0]!;
}

function buildTargetKeys(resolvedTarget: string): Set<string> {
  const out = new Set<string>();
  const normalized = normalizePath(resolvedTarget).replace(/\/$/, "");

  out.add(normalized);

  if (normalized.endsWith(".py")) {
    out.add(stripPyExtension(normalized));
  }

  if (normalized.endsWith("/__init__.py")) {
    const dir = dirname(normalized);
    if (dir && dir !== ".") {
      out.add(dir);
      out.add(dir.replaceAll("/", "."));
    }
  } else if (!extname(normalized)) {
    out.add(normalized.replaceAll("/", "."));
    out.add(`${normalized}/__init__.py`);
  }

  const moduleName = moduleNameFromPath(normalized);
  if (moduleName) {
    out.add(moduleName);
  }

  return out;
}

function buildModuleKeys(rawSpecifier: string): Set<string> {
  const normalized = rawSpecifier.trim();
  const out = new Set<string>();
  if (!normalized) return out;

  out.add(normalized);

  const withoutDots = normalized.replace(/^\.+/, "");
  if (withoutDots) {
    out.add(withoutDots);
  }

  if (looksLikeDottedModule(withoutDots)) {
    out.add(withoutDots.replaceAll(".", "/"));
    out.add(`${withoutDots.replaceAll(".", "/")}.py`);
  }

  return out;
}

function dedupeEdges(edges: PyDependencyEdge[]): PyDependencyEdge[] {
  const seen = new Set<string>();
  const output: PyDependencyEdge[] = [];

  for (const edge of edges) {
    const key = [
      edge.sourceFile,
      edge.rawSpecifier,
      edge.resolvedTarget ?? "",
      edge.edgeKind,
      edge.level,
      edge.importedNames.join(","),
    ].join("|");

    if (seen.has(key)) continue;
    seen.add(key);
    output.push(edge);
  }

  return output;
}

function extractImportStatementsFallback(content: string): ParsedImportStatement[] {
  const statements: ParsedImportStatement[] = [];

  for (const match of content.matchAll(/^\s*import\s+([^\n#]+)$/gm)) {
    const body = (match[1] ?? "").trim();
    if (!body) continue;

    const parts = body
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);

    for (const part of parts) {
      const [modulePath] = part.split(/\s+as\s+/i);
      const module = modulePath?.trim() ?? "";
      if (!module) continue;

      statements.push({
        module,
        level: 0,
        importedNames: [module],
        edgeKind: "import",
        conditional: false,
      });
    }
  }

  for (const match of content.matchAll(/^\s*from\s+([\.A-Za-z0-9_]+)\s+import\s+([^\n#]+)$/gm)) {
    const fromPart = (match[1] ?? "").trim();
    const importPart = (match[2] ?? "").trim();
    if (!fromPart || !importPart) continue;

    const level = countDots(fromPart.match(/^\.+/)?.[0] ?? "");
    const module = fromPart.replace(/^\.+/, "").trim();

    const names = importPart
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => (part.split(/\s+as\s+/i)[1] ?? part.split(/\s+as\s+/i)[0] ?? "").trim())
      .filter(Boolean);

    statements.push({
      module,
      level,
      importedNames: names,
      edgeKind: level > 0 ? "relative-import" : "from-import",
      conditional: false,
    });
  }

  return statements;
}

function isPythonStdlibEdge(edge: PyDependencyEdge): boolean {
  const raw = edge.rawSpecifier.replace(/^\.+/, "").trim();
  if (!raw) return false;
  const head = raw.split(".")[0] ?? "";
  return PYTHON_STDLIB.has(head);
}

const PYTHON_STDLIB = new Set([
  "abc", "argparse", "array", "asyncio", "base64", "binascii", "bisect", "builtins", "bz2", "calendar", "collections", "concurrent", "contextlib", "contextvars", "copy", "csv", "ctypes", "dataclasses", "datetime", "decimal", "difflib", "dis", "email", "enum", "faulthandler", "fnmatch", "fractions", "functools", "gc", "getopt", "getpass", "gettext", "glob", "gzip", "hashlib", "heapq", "hmac", "html", "http", "importlib", "inspect", "io", "ipaddress", "itertools", "json", "keyword", "linecache", "locale", "logging", "lzma", "math", "mimetypes", "mmap", "multiprocessing", "numbers", "operator", "os", "pathlib", "pickle", "pkgutil", "platform", "plistlib", "pprint", "queue", "random", "re", "resource", "sched", "secrets", "selectors", "shlex", "shutil", "signal", "site", "socket", "socketserver", "sqlite3", "ssl", "stat", "statistics", "string", "struct", "subprocess", "sys", "tempfile", "textwrap", "threading", "time", "timeit", "token", "tokenize", "tomllib", "trace", "traceback", "types", "typing", "typing_extensions", "unicodedata", "unittest", "urllib", "uuid", "venv", "warnings", "weakref", "xml", "zipfile", "zipimport", "zlib",
]);

export function isPythonStdlibModule(moduleName: string): boolean {
  return PYTHON_STDLIB.has(moduleName);
}

export function pythonStdlibSet(): ReadonlySet<string> {
  return PYTHON_STDLIB;
}
