import { readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, extname, relative, resolve } from "node:path";
import type { Config } from "../config.js";
import type { Engine } from "./engine.js";
import type { Chunk, EngineStatus, SearchResult, SymbolInfo } from "../types.js";
import { HybridChunker } from "../chunker/chunker.js";
import { createEmbeddingProvider } from "../embeddings/factory.js";
import type { EmbeddingRuntimeProvider } from "../embeddings/runtime.js";
import { LocalFileScanner } from "../sources/local-fs.js";
import { detectGitWorktree, getDirtyPaths, getHeadTreeManifest } from "../sources/git-worktree.js";
import { getRecentGitChanges } from "../sources/git-history.js";
import { chunkDocument, fetchDocument } from "../sources/doc-fetcher.js";
import { WorktreeWatcher } from "./watcher.js";
import { rerankCandidates } from "./reranker.js";
import { TsDependencyService, type TsDependencyEdge } from "./ts-dependency-service.js";
import {
  LanceVectorStore,
  SQLiteMetadataStore,
  WriteAheadLog,
  normalizePathForLookup,
} from "../storage/index.js";
import { logError, logEvent } from "../observability/logger.js";

const DEFAULT_WORKTREE_ID = "default-worktree";

type GoReferenceResolution =
  | {
    kind: "resolved";
    target: { absolutePath: string; line: number; column: number };
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

export class ContextEngine implements Engine {
  private readonly metadataStore: SQLiteMetadataStore;
  private readonly vectorStore: LanceVectorStore;
  private readonly writeLog: WriteAheadLog;
  private readonly scanner = new LocalFileScanner();
  private readonly chunker = new HybridChunker();
  private readonly embedder: EmbeddingRuntimeProvider;
  private readonly tsDeps: TsDependencyService;

  private indexing = false;
  private indexedFiles = 0;
  private indexedRoots: string[];
  private readonly repoId: string;
  private primaryWorktreeId = DEFAULT_WORKTREE_ID;
  private watcher: WorktreeWatcher | null = null;
  private watcherReindexQueued = false;
  private tsDepsHydrated = false;
  private readonly queryLatency = new Map<string, number[]>();

  private constructor(private readonly config: Config) {
    this.embedder = createEmbeddingProvider(config);

    this.metadataStore = new SQLiteMetadataStore({
      path: resolve(config.dataDir, "metadata.db"),
    });
    this.vectorStore = new LanceVectorStore({
      uri: resolve(config.dataDir, "lancedb"),
      vectorDimensions: this.embedder.dimensions,
    });
    this.writeLog = new WriteAheadLog(this.metadataStore.getDatabase());

    this.indexedRoots = config.sources.map((s) => s.path);
    this.repoId = this.makeRepoId(this.indexedRoots);
    this.tsDeps = new TsDependencyService(this.indexedRoots);
  }

  static async create(config: Config): Promise<ContextEngine> {
    const engine = new ContextEngine(config);
    const startedAt = Date.now();

    logEvent("info", "engine.create.start", {
      sourceCount: config.sources.length,
      dataDir: config.dataDir,
      transport: config.server.transport,
    });

    await engine.reconcileWriteLog();

    // Best-effort AST parser warmup (tree-sitter). Failures are captured as warnings.
    try {
      await engine.chunker.warmup();
    } catch (error) {
      logError("engine.create.chunker_warmup_failed", error);
      // no-op; chunker has fallback path
    }

    logEvent("info", "engine.create.complete", {
      durationMs: Date.now() - startedAt,
      modelId: engine.embedder.modelId,
      dimensions: engine.embedder.dimensions,
    });

    return engine;
  }

  async search(query: string, options?: { worktreeId?: string; limit?: number }): Promise<SearchResult[]> {
    if (!query.trim()) return [];

    const startedAt = Date.now();
    const worktreeId = options?.worktreeId ?? this.primaryWorktreeId;
    logEvent("debug", "engine.search.start", {
      query,
      worktreeId,
      limit: options?.limit ?? 10,
    });
    const [queryVector] = await this.embedder.embedWithPriority([query], 0);
    const limit = Math.max(1, options?.limit ?? 10);

    const vectorResults = await this.vectorStore.search(queryVector, {
      limit: Math.max(100, limit * 10),
    });

    const treeEntries = await this.metadataStore.getTreeEntries(worktreeId);
    const dirtyEntries = await this.metadataStore.getDirtyFiles(worktreeId);

    // Visibility map: HEAD tree + dirty overlay (overlay wins).
    const visibleBlobByPath = new Map<string, string>();
    for (const entry of treeEntries) {
      visibleBlobByPath.set(entry.path, entry.blobHash);
    }
    for (const entry of dirtyEntries) {
      visibleBlobByPath.set(entry.path, entry.contentHash);
    }

    const visiblePathsByBlob = new Map<string, string[]>();
    for (const [path, blobHash] of visibleBlobByPath.entries()) {
      const paths = visiblePathsByBlob.get(blobHash);
      if (paths) {
        paths.push(path);
      } else {
        visiblePathsByBlob.set(blobHash, [path]);
      }
    }

    const candidates: Array<{ path: string; result: (typeof vectorResults)[number] }> = [];

    for (const result of vectorResults) {
      let resolvedPath: string | null = null;

      if (visibleBlobByPath.size === 0) {
        resolvedPath = result.chunk.filePath;
      } else {
        const expectedBlob = visibleBlobByPath.get(result.chunk.filePath);
        if (expectedBlob && (!result.chunk.blobHash || expectedBlob === result.chunk.blobHash)) {
          resolvedPath = result.chunk.filePath;
        } else if (result.chunk.blobHash) {
          const aliasPaths = visiblePathsByBlob.get(result.chunk.blobHash);
          if (aliasPaths && aliasPaths.length > 0) {
            resolvedPath = aliasPaths[0];
          }
        }
      }

      if (!resolvedPath) continue;

      candidates.push({ path: resolvedPath, result });
    }

    const reranked = rerankCandidates(
      query,
      candidates.map((candidate) => ({
        path: candidate.path,
        chunk: candidate.result.chunk,
        baseScore: candidate.result.score,
      })),
      { roots: this.indexedRoots },
    ).slice(0, limit);

    const byChunkId = new Map(candidates.map((candidate) => [candidate.result.chunkId, candidate.result]));

    const results = reranked
      .map((candidate) => {
        const result = byChunkId.get(candidate.chunk.id);
        if (!result) return null;

        return {
          filePath: candidate.path,
          startLine: result.chunk.startLine,
          endLine: result.chunk.endLine,
          content: result.chunk.content,
          score: candidate.score,
          symbolName: result.chunk.symbolName,
          symbolKind: result.chunk.symbolKind,
          language: result.chunk.language,
          repoId: result.chunk.repoId,
          worktreeId,
        };
      })
      .filter((entry): entry is SearchResult => entry !== null);

    logEvent("debug", "engine.search.complete", {
      query,
      worktreeId,
      vectorCandidates: vectorResults.length,
      returned: results.length,
      durationMs: Date.now() - startedAt,
    });

    return results;
  }

  async findFiles(pattern: string, options?: { worktreeId?: string }): Promise<string[]> {
    if (!options?.worktreeId) {
      await this.ensurePrimaryWorktreeSelected();
    }

    const worktreeId = options?.worktreeId ?? this.primaryWorktreeId;
    const entries = await this.metadataStore.getTreeEntries(worktreeId);
    const dirtyFiles = await this.metadataStore.getDirtyFiles(worktreeId);
    const files = Array.from(new Set([
      ...entries.map((entry) => entry.path),
      ...dirtyFiles.map((entry) => entry.path),
    ])).sort();

    if (!pattern.trim()) {
      return files;
    }

    return files.filter((file) => matchesPattern(file, pattern));
  }

  async getSymbols(query: { name?: string; filePath?: string; kind?: string }): Promise<SymbolInfo[]> {
    return this.metadataStore.getSymbols({
      name: query.name,
      filePath: query.filePath,
      kind: query.kind as SymbolInfo["kind"] | undefined,
      repoId: this.repoId,
    });
  }

  async getFileSummary(filePath: string): Promise<string> {
    await this.ensurePrimaryWorktreeSelected();

    const normalized = normalizePathForLookup(filePath, this.indexedRoots);
    if (!normalized) {
      return `Rejected path (outside source roots or secret): ${filePath}`;
    }

    const tree = await this.metadataStore.getTreeEntries(this.primaryWorktreeId);
    const dirty = await this.metadataStore.getDirtyFiles(this.primaryWorktreeId);

    const pathMatch = (candidate: string, target: string) =>
      candidate === target ||
      candidate.endsWith(`/${target}`) ||
      target.endsWith(`/${candidate}`);

    const entry = tree.find((e) => pathMatch(e.path, normalized));
    const dirtyEntry = dirty.find((e) => pathMatch(e.path, normalized));

    if (!entry && !dirtyEntry) {
      return `File not indexed: ${filePath}`;
    }

    const symbols = await this.metadataStore.getSymbols({ filePath: (entry?.path ?? dirtyEntry!.path), repoId: this.repoId });
    const blob = entry ? await this.metadataStore.getBlob(entry.blobHash) : null;

    const lines: string[] = [
      `File: ${entry?.path ?? dirtyEntry!.path}`,
      `Chunks: ${blob?.chunkIds.length ?? dirtyEntry?.chunkIds.length ?? 0}`,
      `Symbols: ${symbols.length}`,
    ];

    if (symbols.length) {
      lines.push("Symbols (up to 8):");
      for (const sym of symbols.slice(0, 8)) {
        lines.push(`- ${sym.kind} ${sym.name} (${sym.startLine}-${sym.endLine})`);
      }
    }

    return lines.join("\n");
  }

  async getRecentChanges(query?: string): Promise<string> {
    if (!this.config.gitHistory.enabled) {
      return "Git history connector is disabled in config (gitHistory.enabled=false).";
    }

    const roots = this.indexedRoots.length > 0
      ? this.indexedRoots.map((root) => resolve(root))
      : this.config.sources.map((source) => resolve(source.path));

    const uniqueRootsByRepo = new Map<string, string>();

    for (const root of roots) {
      const info = detectGitWorktree(root);
      if (!info) continue;

      if (!uniqueRootsByRepo.has(info.repoId)) {
        uniqueRootsByRepo.set(info.repoId, info.path);
      }
    }

    if (uniqueRootsByRepo.size === 0) {
      return "No git history sources detected for indexed roots.";
    }

    const maxCommitsPerRepo = Math.max(1, this.config.gitHistory.maxCommits);
    const allEntries = Array.from(uniqueRootsByRepo.values())
      .flatMap((root) => getRecentGitChanges(root, { maxCommits: maxCommitsPerRepo, query }));

    const entries = allEntries
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, Math.min(50, maxCommitsPerRepo));

    if (entries.length === 0) {
      return query?.trim()
        ? `No recent changes matched query: ${query}`
        : "No recent changes found.";
    }

    const lines: string[] = [
      query?.trim()
        ? `Recent changes matching "${query}":`
        : "Recent changes:",
    ];

    for (const entry of entries) {
      const when = entry.date.replace("T", " ").replace("Z", " UTC");
      lines.push(`- ${entry.shortCommit} ${when} — ${entry.message}`);

      if (entry.files.length > 0) {
        const preview = entry.files.slice(0, 5);
        const suffix = entry.files.length > preview.length
          ? ` (+${entry.files.length - preview.length} more)`
          : "";
        lines.push(`  files: ${preview.join(", ")}${suffix}`);
      }
    }

    return lines.join("\n");
  }

  async getDependencies(
    filePath: string,
    options?: { recursive?: boolean; maxFiles?: number },
  ): Promise<string> {
    const startedAt = Date.now();

    try {
      await this.ensurePrimaryWorktreeSelected();

      const normalized = normalizePathForLookup(filePath, this.indexedRoots);
      if (!normalized) {
        return `Rejected path (outside source roots or secret): ${filePath}`;
      }

      const resolved = this.resolveFileOnDisk(normalized);
      if (!resolved || !existsSync(resolved)) {
        const suggestion = await this.buildDependencyPathSuggestion(normalized);
        return `File not found for dependency scan: ${filePath}${suggestion ? `\n${suggestion}` : ""}`;
      }

      let stats;
      try {
        stats = statSync(resolved);
      } catch {
        const suggestion = await this.buildDependencyPathSuggestion(normalized);
        return `File not found for dependency scan: ${filePath}${suggestion ? `\n${suggestion}` : ""}`;
      }

      if (stats.isDirectory()) {
        return this.getDirectoryDependencies(normalized, resolved, options);
      }

      await this.ensureTsDependencyGraph();

      if (isTsLikePath(resolved)) {
        const tsEdges = this.lookupTsEdgesForFile(normalized, resolved);
        if (tsEdges.length === 0) {
          return `No TypeScript/JavaScript dependencies found in ${filePath}`;
        }

        return [
          `Dependencies for ${filePath} (ts-semantic):`,
          ...formatTsEdges(tsEdges),
        ].join("\n");
      }

      const content = readFileSync(resolved, "utf-8");
      const deps = extractDependencies(content, resolved, this.indexedRoots).slice(0, 200);

      if (deps.length === 0) {
        return `No import dependencies detected in ${filePath}`;
      }

      return [
        `Dependencies for ${filePath}:`,
        ...deps.map((d) => `- ${d}`),
      ].join("\n");
    } finally {
      this.recordQueryLatency("get_dependencies", Date.now() - startedAt);
    }
  }

  async findImporters(target: string, options?: { limit?: number }): Promise<string> {
    const startedAt = Date.now();

    try {
      await this.ensureTsDependencyGraph();

      const query = target.trim();
      if (!query) {
        return "Missing target for importer search.";
      }

      const limit = Math.max(1, options?.limit ?? 100);
      const normalized = normalizePathForLookup(query, this.indexedRoots) ?? normalizeFilePath(query);
      const resolvedTarget = this.resolveFileOnDisk(normalized);

      const tsImporters = new Set<string>();
      const tsCandidates = new Set<string>([normalized, normalizeFilePath(query)]);
      if (resolvedTarget) {
        tsCandidates.add(normalizeFilePath(relative(process.cwd(), resolvedTarget)));
        for (const root of this.indexedRoots) {
          tsCandidates.add(normalizeFilePath(relative(resolve(root), resolvedTarget)));
        }
      }

      for (const candidate of tsCandidates) {
        if (!candidate || candidate.startsWith("../")) continue;
        for (const importer of this.tsDeps.findImporters(candidate, { limit: limit * 2 })) {
          tsImporters.add(importer);
        }
      }

      const staticImporters = await this.findImportersStatic(normalized, resolvedTarget, limit * 2);

      const combined = Array.from(new Set([
        ...Array.from(tsImporters),
        ...staticImporters,
      ])).sort().slice(0, limit);

      if (combined.length === 0) {
        return [
          `Importers for ${query}:`,
          "No importers found.",
          "Backends checked: ts-semantic graph + static import scan.",
        ].join("\n");
      }

      return [
        `Importers for ${query}:`,
        ...combined.map((entry) => `- ${entry}`),
      ].join("\n");
    } finally {
      this.recordQueryLatency("find_importers", Date.now() - startedAt);
    }
  }

  private async findImportersStatic(
    normalizedTarget: string,
    resolvedTarget: string | null,
    limit: number,
  ): Promise<string[]> {
    const files = await this.findFiles("", {
      worktreeId: this.primaryWorktreeId,
    });

    const targetNoExt = stripCodeExtension(normalizedTarget);
    const targetDir = normalizedTarget.endsWith(".go")
      ? normalizeFilePath(dirname(normalizedTarget))
      : normalizeFilePath(dirname(targetNoExt));
    const targetLooksLikePath = normalizedTarget.includes("/") || normalizedTarget.includes(".");

    const resolvedCandidates = new Set<string>();
    if (resolvedTarget) {
      for (const root of this.indexedRoots) {
        const rel = normalizeFilePath(relative(resolve(root), resolvedTarget));
        if (!rel.startsWith("../") && rel !== "..") {
          resolvedCandidates.add(rel);
          resolvedCandidates.add(stripCodeExtension(rel));
          resolvedCandidates.add(normalizeFilePath(dirname(rel)));
        }
      }
    }

    const matches = new Set<string>();

    for (const relativePath of files) {
      if (matches.size >= limit) break;

      const absolutePath = this.resolveFileOnDisk(relativePath);
      if (!absolutePath || !existsSync(absolutePath)) continue;

      let content: string;
      try {
        content = readFileSync(absolutePath, "utf-8");
      } catch {
        continue;
      }

      const deps = extractDependencies(content, absolutePath, this.indexedRoots);
      for (const dep of deps) {
        const normalizedDep = normalizeFilePath(dep.replace(/^pkg:/, ""));
        if (
          dependencyMatchesTarget(normalizedDep, {
            normalizedTarget,
            targetNoExt,
            targetDir,
            targetLooksLikePath,
            resolvedCandidates,
          })
        ) {
          matches.add(relativePath);
          break;
        }
      }
    }

    return Array.from(matches).sort().slice(0, limit);
  }

  private async ensurePrimaryWorktreeSelected(): Promise<void> {
    if (this.primaryWorktreeId !== DEFAULT_WORKTREE_ID) {
      return;
    }

    const currentTree = await this.metadataStore.getTreeEntries(this.primaryWorktreeId);
    if (currentTree.length > 0) {
      return;
    }

    const currentDirty = await this.metadataStore.getDirtyFiles(this.primaryWorktreeId);
    if (currentDirty.length > 0) {
      return;
    }

    const knownWorktrees = await this.metadataStore.getKnownWorktreeIds();
    if (knownWorktrees.length > 0) {
      this.primaryWorktreeId = knownWorktrees[0]!;
    }
  }

  private recordQueryLatency(metric: "get_dependencies" | "find_importers" | "find_references", durationMs: number): void {
    const bucket = this.queryLatency.get(metric) ?? [];
    bucket.push(Math.max(0, Math.round(durationMs)));

    if (bucket.length > 200) {
      bucket.splice(0, bucket.length - 200);
    }

    this.queryLatency.set(metric, bucket);
  }

  private summarizeLatency(metric: string): { count: number; p50: number; p95: number } {
    const values = this.queryLatency.get(metric) ?? [];
    if (values.length === 0) {
      return { count: 0, p50: 0, p95: 0 };
    }

    const sorted = [...values].sort((a, b) => a - b);
    const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0;

    return {
      count: values.length,
      p50: percentile(0.5),
      p95: percentile(0.95),
    };
  }

  private async ensureTsDependencyGraph(): Promise<void> {
    if (this.tsDepsHydrated) {
      return;
    }

    await this.updateTsDependencyGraph({
      changedPaths: [],
      removedPaths: [],
      forceRebuild: true,
    });
  }

  private async buildDependencyPathSuggestion(normalizedPath: string): Promise<string> {
    const allFiles = await this.findFiles("", {
      worktreeId: this.primaryWorktreeId,
    });

    const requestedDir = normalizeFilePath(dirname(normalizedPath));
    const requestedBase = basename(normalizedPath);
    const dirResolved = this.resolveFileOnDisk(requestedDir === "." ? "" : requestedDir);

    const lines: string[] = [];

    if (dirResolved && existsSync(dirResolved) && statSync(dirResolved).isDirectory()) {
      const siblings = allFiles
        .filter((file) => normalizeFilePath(dirname(file)) === requestedDir)
        .slice(0, 10)
        .map((file) => basename(file));

      if (siblings.length > 0) {
        lines.push(`Files in ${requestedDir === "." ? "/" : requestedDir}: ${siblings.join(", ")}`);
      } else {
        lines.push(`Directory exists (${requestedDir === "." ? "/" : requestedDir}) but has no indexed files.`);
      }
    }

    const needle = requestedBase.toLowerCase().replace(/\.[^.]+$/, "").trim();
    const alternatives = needle.length >= 2
      ? allFiles
        .filter((file) => {
          const base = basename(file).toLowerCase();
          const stem = base.replace(/\.[^.]+$/, "").trim();
          if (!stem || stem.length < 2) return false;
          return base.includes(needle) || stem.includes(needle) || needle.includes(stem);
        })
        .slice(0, 8)
      : [];

    if (alternatives.length > 0) {
      lines.push(`Did you mean: ${alternatives.join(", ")}`);
    }

    return lines.join("\n");
  }

  private async getDirectoryDependencies(
    normalizedPath: string,
    _absoluteDir: string,
    options?: { recursive?: boolean; maxFiles?: number },
  ): Promise<string> {
    await this.ensureTsDependencyGraph();

    const recursive = options?.recursive ?? false;
    const maxFiles = Math.max(1, Math.min(500, Math.floor(options?.maxFiles ?? 50)));

    const allFiles = await this.findFiles("", {
      worktreeId: this.primaryWorktreeId,
    });

    const normalizedDir = normalizeFilePath(normalizedPath).replace(/\/$/, "");

    const matchingFiles = allFiles.filter((path) => {
      if (!normalizedDir || normalizedDir === ".") {
        return true;
      }

      const fileDir = normalizeFilePath(dirname(path));
      if (recursive) {
        return path === normalizedDir || path.startsWith(`${normalizedDir}/`) || fileDir === normalizedDir;
      }

      return fileDir === normalizedDir;
    });

    if (matchingFiles.length === 0) {
      return `No indexed files found in directory: ${normalizedPath}`;
    }

    const scannedFiles = matchingFiles.slice(0, maxFiles);
    const perFile: Array<{ file: string; deps: string[] }> = [];
    const unique = new Set<string>();

    for (const relativePath of scannedFiles) {
      const absolutePath = this.resolveFileOnDisk(relativePath);
      if (!absolutePath || !existsSync(absolutePath)) continue;

      let deps: string[] = [];

      if (isTsLikePath(absolutePath)) {
        const tsEdges = this.tsDeps.getFileEdges(relativePath);
        deps = tsEdges
          .map((edge) => edge.resolvedTarget ?? edge.rawSpecifier)
          .filter(Boolean)
          .slice(0, 80);
      } else {
        let content: string;
        try {
          content = readFileSync(absolutePath, "utf-8");
        } catch {
          continue;
        }

        deps = extractDependencies(content, absolutePath, this.indexedRoots).slice(0, 80);
      }

      if (deps.length === 0) continue;

      perFile.push({ file: relativePath, deps: Array.from(new Set(deps)).sort() });
      for (const dep of deps) {
        unique.add(dep);
      }
    }

    const lines: string[] = [
      `Dependencies for directory ${normalizedPath} (${perFile.length} files with imports, scanned ${scannedFiles.length}${matchingFiles.length > scannedFiles.length ? ` of ${matchingFiles.length}` : ""}):`,
    ];

    for (const entry of perFile) {
      lines.push(`- ${entry.file}`);
      for (const dep of entry.deps) {
        lines.push(`  - ${dep}`);
      }
    }

    if (unique.size > 0) {
      lines.push(`Unique dependencies (${unique.size}):`);
      for (const dep of Array.from(unique).slice(0, 200)) {
        lines.push(`- ${dep}`);
      }
    } else {
      lines.push("No import dependencies detected in scanned files.");
    }

    return lines.join("\n");
  }

  async findReferences(
    symbol: string,
    options?: { filePath?: string; includeDeclaration?: boolean; limit?: number },
  ): Promise<string> {
    const startedAt = Date.now();

    try {
      await this.ensureTsDependencyGraph();

      const query = symbol.trim();
      if (!query) {
        return "Missing symbol for reference search.";
      }

    const limit = Math.max(1, options?.limit ?? 50);
    const includeDeclaration = options?.includeDeclaration ?? false;
    const normalizedFilePath = options?.filePath ? normalizeFilePath(options.filePath) : undefined;

    const explicitGo = normalizedFilePath?.endsWith(".go") === true;
    const explicitTs = normalizedFilePath ? isTsLikePath(normalizedFilePath) : false;

    if (explicitTs) {
      if (!this.resolveFileOnDisk(normalizedFilePath!)) {
        const suggestion = await this.buildDependencyPathSuggestion(normalizedFilePath);
        return this.formatFindReferencesResponse({
          symbol: query,
          requestedBackend: "tsserver",
          actualBackend: "none",
          references: [],
          fallbackReason: `TS file not found on disk: ${normalizedFilePath}${suggestion ? ` | ${suggestion}` : ""}`,
          guidance: "Check the path and ensure it is inside indexed source roots.",
        });
      }

      const tsResult = this.tsDeps.findReferences(query, {
        filePath: normalizedFilePath,
        includeDeclaration,
        limit,
      });

      if (tsResult.resolution.kind === "ambiguous") {
        return this.formatFindReferencesResponse({
          symbol: query,
          requestedBackend: "tsserver",
          actualBackend: "none",
          references: [],
          fallbackReason: tsResult.resolution.reason,
          candidates: tsResult.resolution.candidates,
          guidance: "Provide `filePath` + exact exported symbol name to run TypeScript references precisely.",
        });
      }

      if (tsResult.resolution.kind === "resolved" && tsResult.references.length > 0) {
        return this.formatFindReferencesResponse({
          symbol: query,
          requestedBackend: "tsserver",
          actualBackend: "tsserver",
          references: tsResult.references,
          candidates: tsResult.resolution.candidates,
        });
      }

      if (tsResult.resolution.kind === "resolved" && tsResult.references.length === 0) {
        return this.formatFindReferencesResponse({
          symbol: query,
          requestedBackend: "tsserver",
          actualBackend: "none",
          references: [],
          fallbackReason: `TypeScript backend returned 0 references for ${tsResult.resolution.declaration.filePath}:${tsResult.resolution.declaration.line}`,
          candidates: tsResult.resolution.candidates,
          guidance: "Try includeDeclaration=true or specify a different anchor filePath if symbol shadowing is involved.",
        });
      }

      return this.formatFindReferencesResponse({
        symbol: query,
        requestedBackend: "tsserver",
        actualBackend: "none",
        references: [],
        fallbackReason: tsResult.resolution.reason,
        candidates: tsResult.resolution.candidates,
      });
    }

    const goResolution = await this.resolveGoReferenceTarget(query, normalizedFilePath);
    const goplsInstalled = isGoplsAvailable();
    const shouldTryGo = goplsInstalled && (goResolution.kind !== "unresolved" || explicitGo);

    if (shouldTryGo) {
      if (goResolution.kind === "ambiguous") {
        return this.formatFindReferencesResponse({
          symbol: query,
          requestedBackend: "gopls",
          actualBackend: "none",
          fallbackReason: goResolution.reason,
          references: [],
          candidates: goResolution.candidates,
          guidance: "Provide `filePath` to the exact Go declaration to run gopls references precisely.",
        });
      }

      if (goResolution.kind === "resolved") {
        try {
          const references = this.findGoReferencesWithGopls(goResolution.target, {
            includeDeclaration,
            limit,
          });

          if (references.length > 0) {
            return this.formatFindReferencesResponse({
              symbol: query,
              requestedBackend: "gopls",
              actualBackend: "gopls",
              references,
              candidates: goResolution.candidates,
            });
          }

          const fallback = await this.findReferencesHeuristic(query, {
            filePath: normalizedFilePath,
            limit,
          });

          return this.formatFindReferencesResponse({
            symbol: query,
            requestedBackend: "gopls",
            actualBackend: "heuristic",
            fallbackReason: `gopls returned 0 references for ${goResolution.target.absolutePath}:${goResolution.target.line}:${goResolution.target.column}`,
            references: fallback,
            candidates: goResolution.candidates,
          });
        } catch (error) {
          const fallback = await this.findReferencesHeuristic(query, {
            filePath: normalizedFilePath,
            limit,
          });

          return this.formatFindReferencesResponse({
            symbol: query,
            requestedBackend: "gopls",
            actualBackend: "heuristic",
            fallbackReason: `gopls failed: ${error instanceof Error ? error.message : String(error)}`,
            references: fallback,
            candidates: goResolution.candidates,
          });
        }
      }

      const fallback = await this.findReferencesHeuristic(query, {
        filePath: normalizedFilePath,
        limit,
      });

      return this.formatFindReferencesResponse({
        symbol: query,
        requestedBackend: "gopls",
        actualBackend: "heuristic",
        fallbackReason: goResolution.reason,
        references: fallback,
        candidates: goResolution.candidates,
      });
    }

    const tsResult = this.tsDeps.findReferences(query, {
      filePath: normalizedFilePath,
      includeDeclaration,
      limit,
    });

    if (tsResult.resolution.kind === "ambiguous") {
      return this.formatFindReferencesResponse({
        symbol: query,
        requestedBackend: "tsserver",
        actualBackend: "none",
        references: [],
        fallbackReason: tsResult.resolution.reason,
        candidates: tsResult.resolution.candidates,
        guidance: "Provide `filePath` to the exact TypeScript declaration to disambiguate.",
      });
    }

    if (tsResult.resolution.kind === "resolved") {
      if (tsResult.references.length > 0) {
        return this.formatFindReferencesResponse({
          symbol: query,
          requestedBackend: "tsserver",
          actualBackend: "tsserver",
          references: tsResult.references,
          candidates: tsResult.resolution.candidates,
        });
      }

      const fallback = await this.findReferencesHeuristic(query, {
        filePath: normalizedFilePath,
        limit,
      });

      return this.formatFindReferencesResponse({
        symbol: query,
        requestedBackend: "tsserver",
        actualBackend: "heuristic",
        references: fallback,
        fallbackReason: `TypeScript backend returned 0 references for ${tsResult.resolution.declaration.filePath}:${tsResult.resolution.declaration.line}`,
        candidates: tsResult.resolution.candidates,
      });
    }

    const heuristic = await this.findReferencesHeuristic(query, {
      filePath: normalizedFilePath,
      limit,
    });

    return this.formatFindReferencesResponse({
      symbol: query,
      requestedBackend: "heuristic",
      actualBackend: "heuristic",
      references: heuristic,
      fallbackReason: heuristic.length === 0
        ? `No symbol-service backend selected for this query. (${tsResult.resolution.reason})`
        : tsResult.resolution.reason,
      candidates: tsResult.resolution.candidates,
    });
    } finally {
      this.recordQueryLatency("find_references", Date.now() - startedAt);
    }
  }

  private formatFindReferencesResponse(params: {
    symbol: string;
    requestedBackend: "gopls" | "tsserver" | "heuristic";
    actualBackend: "gopls" | "tsserver" | "heuristic" | "none";
    references: string[];
    fallbackReason?: string;
    candidates?: string[];
    guidance?: string;
  }): string {
    const lines = [
      `References for ${params.symbol}:`,
      `Requested backend: ${params.requestedBackend}`,
      `Actual backend: ${params.actualBackend}`,
    ];

    if (params.fallbackReason) {
      lines.push(`Fallback reason: ${params.fallbackReason}`);
    }

    if (params.candidates && params.candidates.length > 0) {
      lines.push("Candidate declarations:");
      for (const candidate of params.candidates.slice(0, 8)) {
        lines.push(`- ${candidate}`);
      }
    }

    if (params.references.length === 0) {
      if (params.actualBackend === "none") {
        lines.push("No call-site search executed.");
      } else {
        lines.push("No references found.");
      }
    } else {
      lines.push("References:");
      for (const ref of params.references) {
        lines.push(`- ${ref}`);
      }
    }

    if (params.actualBackend === "heuristic") {
      lines.push("Warning: heuristic backend may include false positives; verify critical matches before refactoring.");
    }

    if (params.guidance) {
      lines.push(`Guidance: ${params.guidance}`);
    } else if (params.references.length === 0 && params.candidates && params.candidates.length > 0) {
      const firstCandidate = params.candidates[0]?.split(":")?.[0];
      if (firstCandidate) {
        lines.push(`Guidance: Retry with filePath='${firstCandidate}' to disambiguate.`);
      }
    }

    return lines.join("\n");
  }

  async searchDocs(query: string): Promise<SearchResult[]> {
    if (!query.trim()) return [];

    const rows = await this.metadataStore.searchDocChunks(query, 10);

    return rows.map((row) => ({
      filePath: row.url,
      startLine: row.chunkIndex + 1,
      endLine: row.chunkIndex + 1,
      content: `${row.title}\n\n${row.content}`,
      score: 1,
      language: "markdown",
      repoId: this.repoId,
    }));
  }

  async status(): Promise<EngineStatus> {
    await this.ensurePrimaryWorktreeSelected();

    let chunksStored = 0;
    try {
      chunksStored = await this.vectorStore.count();
    } catch {
      chunksStored = 0;
    }

    const filesIndexed = (await this.metadataStore.getTreeEntries(this.primaryWorktreeId)).length;
    const lastIndexedRaw = await this.metadataStore.getIndexState("engine:lastIndexedAt");
    const lastIndexedAt = lastIndexedRaw ? Number(lastIndexedRaw) : 0;

    this.indexedFiles = filesIndexed;

    const embeddingWarning =
      "getWarning" in this.embedder && typeof (this.embedder as any).getWarning === "function"
        ? (this.embedder as any).getWarning() as string | undefined
        : undefined;

    const chunkerWarnings = this.chunker.getWarnings();
    const warningParts = [
      embeddingWarning,
      ...chunkerWarnings,
    ].filter(Boolean) as string[];

    const treeEntries = await this.metadataStore.getTreeEntries(this.primaryWorktreeId);
    const dirtyEntries = await this.metadataStore.getDirtyFiles(this.primaryWorktreeId);
    const visiblePaths = new Set<string>([
      ...treeEntries.map((entry) => entry.path),
      ...dirtyEntries.map((entry) => entry.path),
    ]);

    const languageFileCounts: Record<string, number> = {};
    for (const filePath of visiblePaths) {
      const language = inferLanguageFromPath(filePath);
      languageFileCounts[language] = (languageFileCounts[language] ?? 0) + 1;
    }

    await this.ensureTsDependencyGraph();
    const tsStats = this.tsDeps.getStats();
    const tsProgramCache = this.tsDeps.getProgramCacheStats();

    return {
      indexing: this.indexing,
      repos: [
        {
          repoId: this.repoId,
          path: this.indexedRoots[0] ?? process.cwd(),
          filesIndexed,
          chunksStored,
          lastIndexedAt,
        },
      ],
      embeddingModel: warningParts.length > 0
        ? `${this.embedder.modelId} (warning: ${warningParts.join(" | ")})`
        : this.embedder.modelId,
      workerBusy: this.embedder.isBusy(),
      languageFileCounts,
      capabilities: {
        goReferencesBinary: isGoplsAvailable() ? "available" : "unavailable",
        goReferencesSelection: "requires-anchor-for-ambiguous-symbols",
        goDependencies: "native",
        tsDependencies: "compiler-api",
        tsReferences: "compiler-api",
      },
      tsDependencyGraph: {
        filesIndexed: tsStats.filesIndexed,
        edgesTotal: tsStats.edgesTotal,
        edgesResolved: tsStats.edgesResolved,
        edgesUnresolved: tsStats.edgesUnresolved,
        resolutionSuccessRate: tsStats.resolutionSuccessRate,
        lastBuiltAt: tsStats.lastBuiltAt,
        programCacheHits: tsProgramCache.hits,
        programCacheMisses: tsProgramCache.misses,
        cachedPrograms: tsProgramCache.size,
      },
      queryLatencyMs: {
        getDependencies: this.summarizeLatency("get_dependencies"),
        findImporters: this.summarizeLatency("find_importers"),
        findReferences: this.summarizeLatency("find_references"),
      },
    };
  }

  async index(dirs?: string[]): Promise<void> {
    const roots = (dirs?.length ? dirs : this.config.sources.map((s) => s.path)).map((d) => resolve(d));
    const previousRoots = this.indexedRoots.map((root) => resolve(root));
    const rootsChanged =
      previousRoots.length !== roots.length ||
      previousRoots.some((root, index) => root !== roots[index]);

    this.indexedRoots = roots;
    this.tsDeps.setRoots(roots);
    if (rootsChanged) {
      this.tsDepsHydrated = false;
    }

    const startedAt = Date.now();
    let scannedFiles = 0;
    let changedFiles = 0;
    const tsChangedPaths = new Set<string>();
    const tsRemovedPaths = new Set<string>();
    let tsConfigTouched = false;

    logEvent("info", "engine.index.start", {
      roots,
      docs: this.config.docs.length,
    });

    this.indexing = true;
    try {
      let isFirstRoot = true;

      for (const root of roots) {
        const context = this.getWorktreeContext(root);
        const worktreeId = context.worktreeId;

        if (isFirstRoot) {
          this.primaryWorktreeId = worktreeId;
          isFirstRoot = false;
        }

        const previousEntries = await this.metadataStore.getTreeEntries(worktreeId);
        const previousMap = new Map(previousEntries.map((entry) => [entry.path, entry.blobHash]));
        const previousDirty = await this.metadataStore.getDirtyFiles(worktreeId);
        const previousDirtyByPath = new Map(previousDirty.map((entry) => [entry.path, entry]));
        const seenPaths = new Set<string>();

        const manifestEntries = context.isGit ? getHeadTreeManifest(root) : [];
        const manifestMap = new Map(manifestEntries.map((entry) => [entry.path, entry.blobHash]));
        const dirtyPaths = context.isGit ? getDirtyPaths(root) : new Set<string>();

        if (context.isGit) {
          await this.metadataStore.clearTreeEntries(worktreeId);
          for (const entry of manifestEntries) {
            await this.metadataStore.upsertTreeEntry(context.repoId, worktreeId, entry.path, entry.blobHash);
          }
        }

        for await (const file of this.scanner.scan(root, {
          exclude: this.config.sources.find((s) => resolve(s.path) === root)?.exclude,
        })) {
          scannedFiles += 1;
          const filePath = normalizeFilePath(relative(root, file.path));
          seenPaths.add(filePath);

          const previousHash = await this.metadataStore.getIndexState(this.fileHashKey(worktreeId, filePath));
          const previousDirtyEntry = previousDirtyByPath.get(filePath);

          const trackedBlob = manifestMap.get(filePath);
          const isDirtyOverlay = context.isGit ? (!trackedBlob || dirtyPaths.has(filePath)) : false;

          const unchangedContent = previousHash === file.contentHash;
          const unchangedOverlay = isDirtyOverlay
            ? previousDirtyEntry?.contentHash === file.contentHash
            : !previousDirtyEntry;

          if (unchangedContent && unchangedOverlay) {
            continue;
          }

          changedFiles += 1;
          const contentChanged = previousHash !== file.contentHash;
          const normalizedChangedPath = normalizeFilePath(filePath);
          if (isTsLikePath(normalizedChangedPath)) {
            tsChangedPaths.add(normalizedChangedPath);
          }
          const fileBaseName = basename(normalizedChangedPath).toLowerCase();
          if (fileBaseName === "tsconfig.json" || fileBaseName === "jsconfig.json") {
            tsConfigTouched = true;
          }

          const content = readFileSync(file.path, "utf-8");

          let symbolChunks: Chunk[] = [];
          let chunkIds: string[];

          const existingBlob = await this.metadataStore.getBlob(file.contentHash);
          if (existingBlob && existingBlob.chunkIds.length > 0) {
            chunkIds = existingBlob.chunkIds;

            if (contentChanged) {
              symbolChunks = this.chunker
                .chunk(content, filePath, file.language, context.repoId)
                .map((chunk) => ({
                  ...chunk,
                  repoId: context.repoId,
                  worktreeId,
                  blobHash: file.contentHash,
                }));
            }
          } else {
            const rawChunks = this.chunker.chunk(content, filePath, file.language, context.repoId);
            const chunks = rawChunks.map((chunk) => ({
              ...chunk,
              worktreeId,
              repoId: context.repoId,
              blobHash: file.contentHash,
            }));
            chunkIds = chunks.map((chunk) => chunk.id);
            symbolChunks = chunks;

            const writeId = await this.writeLog.beginIntent("upsert", chunkIds);
            await this.vectorStore.upsert(await this.embedChunks(chunks), chunks);
            await this.writeLog.markLanceOk(writeId);
            await this.writeLog.markSqliteOk(writeId);
            await this.writeLog.finalize(writeId);
          }

          await this.metadataStore.upsertBlob(file.contentHash, chunkIds);
          await this.metadataStore.setIndexState(this.fileHashKey(worktreeId, filePath), file.contentHash);

          if (!context.isGit) {
            await this.metadataStore.upsertTreeEntry(context.repoId, worktreeId, filePath, file.contentHash);
          }

          if (isDirtyOverlay) {
            await this.metadataStore.upsertDirtyFile(worktreeId, filePath, file.contentHash, chunkIds);
          } else {
            await this.metadataStore.deleteDirtyFile(worktreeId, filePath);
          }

          if (contentChanged) {
            await this.metadataStore.deleteSymbolsByFile(filePath);
            const symbols = chunksToSymbols(symbolChunks, context.repoId);
            const fallbackSymbols = symbols.length > 0 ? symbols : extractSymbols(content, filePath, context.repoId);
            if (fallbackSymbols.length) {
              await this.metadataStore.upsertSymbols(fallbackSymbols);
            }
          }

          if (previousHash && previousHash !== file.contentHash) {
            await this.cleanupBlobIfUnreferenced(previousHash);
          }
        }

        // deleted files
        for (const [filePath, blobHash] of previousMap.entries()) {
          if (!seenPaths.has(filePath) && !manifestMap.has(filePath)) {
            const normalizedRemovedPath = normalizeFilePath(filePath);
            if (isTsLikePath(normalizedRemovedPath)) {
              tsRemovedPaths.add(normalizedRemovedPath);
            }
            const removedBaseName = basename(normalizedRemovedPath).toLowerCase();
            if (removedBaseName === "tsconfig.json" || removedBaseName === "jsconfig.json") {
              tsConfigTouched = true;
            }

            await this.metadataStore.deleteTreeEntry(worktreeId, filePath);
            await this.metadataStore.setIndexState(this.fileHashKey(worktreeId, filePath), "");
            await this.metadataStore.deleteSymbolsByFile(filePath);
            await this.cleanupBlobIfUnreferenced(blobHash);
          }
        }

        for (const [path, entry] of previousDirtyByPath.entries()) {
          if (!seenPaths.has(path) && !dirtyPaths.has(path)) {
            const normalizedRemovedPath = normalizeFilePath(path);
            if (isTsLikePath(normalizedRemovedPath)) {
              tsRemovedPaths.add(normalizedRemovedPath);
            }
            const removedBaseName = basename(normalizedRemovedPath).toLowerCase();
            if (removedBaseName === "tsconfig.json" || removedBaseName === "jsconfig.json") {
              tsConfigTouched = true;
            }

            await this.metadataStore.deleteDirtyFile(worktreeId, path);
            await this.cleanupBlobIfUnreferenced(entry.contentHash);
          }
        }
      }

      await this.indexDocs();
      await this.updateTsDependencyGraph({
        changedPaths: Array.from(tsChangedPaths),
        removedPaths: Array.from(tsRemovedPaths),
        forceRebuild: rootsChanged || tsConfigTouched || !this.tsDepsHydrated,
      });
      await this.metadataStore.setIndexState("engine:lastIndexedAt", String(Date.now()));

      logEvent("info", "engine.index.complete", {
        roots,
        scannedFiles,
        changedFiles,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      logError("engine.index.failed", error, {
        roots,
        scannedFiles,
        changedFiles,
        durationMs: Date.now() - startedAt,
      });
      throw error;
    } finally {
      this.indexing = false;
    }
  }

  async startWatching(options?: { pollIntervalMs?: number; debounceMs?: number }): Promise<void> {
    if (this.watcher) return;

    const roots = this.indexedRoots.length > 0
      ? this.indexedRoots.map((root) => resolve(root))
      : this.config.sources.map((source) => resolve(source.path));

    this.indexedRoots = roots;

    const pollIntervalMs = options?.pollIntervalMs ?? this.config.watcher.pollIntervalMs;
    const debounceMs = options?.debounceMs ?? this.config.watcher.debounceMs;

    logEvent("info", "engine.watcher.start", {
      roots,
      pollIntervalMs,
      debounceMs,
    });

    this.watcher = new WorktreeWatcher({
      roots,
      pollIntervalMs,
      debounceMs,
      ignorePaths: [resolve(this.config.dataDir)],
      onChange: async () => {
        logEvent("debug", "engine.watcher.change_detected", {
          indexing: this.indexing,
          queued: this.watcherReindexQueued,
        });

        if (this.indexing) {
          this.watcherReindexQueued = true;
          return;
        }

        await this.index(this.indexedRoots);

        while (this.watcherReindexQueued && !this.indexing) {
          this.watcherReindexQueued = false;
          await this.index(this.indexedRoots);
        }
      },
    });

    await this.watcher.start();
  }

  async stopWatching(): Promise<void> {
    this.watcherReindexQueued = false;

    if (!this.watcher) return;

    await this.watcher.stop();
    this.watcher = null;
    logEvent("info", "engine.watcher.stopped");
  }

  async close(): Promise<void> {
    logEvent("info", "engine.close.start");
    await this.stopWatching();
    await this.vectorStore.close();
    await this.metadataStore.close();
    await this.embedder.close();
    logEvent("info", "engine.close.complete");
  }

  private async updateTsDependencyGraph(options: {
    changedPaths: string[];
    removedPaths: string[];
    forceRebuild: boolean;
  }): Promise<void> {
    const startedAt = Date.now();
    await this.ensurePrimaryWorktreeSelected();

    const treeEntries = await this.metadataStore.getTreeEntries(this.primaryWorktreeId);
    const dirtyEntries = await this.metadataStore.getDirtyFiles(this.primaryWorktreeId);
    const visible = Array.from(new Set([
      ...treeEntries.map((entry) => entry.path),
      ...dirtyEntries.map((entry) => entry.path),
    ])).sort();

    if (options.forceRebuild || !this.tsDepsHydrated) {
      this.tsDeps.rebuild(visible);
      this.tsDepsHydrated = true;
      logEvent("debug", "engine.ts_graph.updated", {
        mode: "rebuild",
        visibleFiles: visible.length,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    if (options.changedPaths.length === 0 && options.removedPaths.length === 0) {
      return;
    }

    this.tsDeps.applyDelta({
      visibleFiles: visible,
      changedPaths: options.changedPaths,
      removedPaths: options.removedPaths,
    });
    this.tsDepsHydrated = true;

    logEvent("debug", "engine.ts_graph.updated", {
      mode: "incremental",
      visibleFiles: visible.length,
      changed: options.changedPaths.length,
      removed: options.removedPaths.length,
      durationMs: Date.now() - startedAt,
    });
  }

  private async indexDocs(): Promise<void> {
    const docs = this.config.docs ?? [];

    if (docs.length === 0) {
      return;
    }

    logEvent("info", "engine.docs.index.start", {
      docCount: docs.length,
    });

    for (const doc of docs) {
      try {
        const fetched = await fetchDocument(doc.url, doc.selector);
        const chunks = chunkDocument(fetched.content);

        if (chunks.length === 0) {
          await this.metadataStore.deleteDocChunks(doc.url);
          logEvent("debug", "engine.docs.index.empty", { url: doc.url });
          continue;
        }

        await this.metadataStore.upsertDocChunks(doc.url, fetched.title, chunks);
        logEvent("debug", "engine.docs.index.upsert", {
          url: doc.url,
          chunks: chunks.length,
        });
      } catch (error) {
        logError("engine.docs.index.failed", error, { url: doc.url });
        // Keep indexing resilient; docs can be transiently unavailable.
      }
    }
  }

  private async embedChunks(chunks: Chunk[]): Promise<Float32Array[]> {
    if (chunks.length === 0) return [];
    const texts = chunks.map((chunk) => chunk.content);
    return this.embedder.embedWithPriority(texts, 1);
  }

  private async cleanupBlobIfUnreferenced(blobHash: string): Promise<void> {
    const references = await this.metadataStore.countBlobReferences(blobHash);
    if (references > 0) return;

    const oldBlob = await this.metadataStore.getBlob(blobHash);
    if (!oldBlob) return;

    const writeId = await this.writeLog.beginIntent("delete", oldBlob.chunkIds);
    await this.vectorStore.delete(oldBlob.chunkIds);
    await this.writeLog.markLanceOk(writeId);

    await this.metadataStore.deleteBlob(blobHash);

    await this.writeLog.markSqliteOk(writeId);
    await this.writeLog.finalize(writeId);
  }

  private async reconcileWriteLog(): Promise<void> {
    await this.writeLog.reconcile(async ({ entry, markRecovered, markRolledBack }) => {
      if (!entry.lanceOk && !entry.sqliteOk) {
        // nothing persisted yet; safe to consider recovered
        markRecovered();
        return;
      }

      if (entry.lanceOk && !entry.sqliteOk) {
        // vectors may exist without metadata refs -> remove vectors to avoid orphans
        await this.vectorStore.delete(entry.chunkIds);
        markRolledBack();
        return;
      }

      if (!entry.lanceOk && entry.sqliteOk) {
        // metadata references without vectors -> scrub references from sqlite
        this.scrubChunkIdsFromMetadata(entry.chunkIds);
        markRolledBack();
        return;
      }

      markRecovered();
    });
  }

  private scrubChunkIdsFromMetadata(chunkIdsToRemove: string[]): void {
    const removeSet = new Set(chunkIdsToRemove);
    const db = this.metadataStore.getDatabase();

    const blobRows = db.query("SELECT blob_hash, chunk_ids FROM blobs").all() as Array<{ blob_hash: string; chunk_ids: string }>;
    const updateBlob = db.query("UPDATE blobs SET chunk_ids = ? WHERE blob_hash = ?");

    for (const row of blobRows) {
      const updated = (JSON.parse(row.chunk_ids) as string[]).filter((id) => !removeSet.has(id));
      updateBlob.run(JSON.stringify(updated), row.blob_hash);
    }

    const dirtyRows = db
      .query("SELECT worktree_id, path, chunk_ids FROM dirty_files")
      .all() as Array<{ worktree_id: string; path: string; chunk_ids: string }>;
    const updateDirty = db.query("UPDATE dirty_files SET chunk_ids = ? WHERE worktree_id = ? AND path = ?");

    for (const row of dirtyRows) {
      const updated = (JSON.parse(row.chunk_ids) as string[]).filter((id) => !removeSet.has(id));
      updateDirty.run(JSON.stringify(updated), row.worktree_id, row.path);
    }
  }

  private fileHashKey(worktreeId: string, filePath: string): string {
    return `filehash:${worktreeId}:${filePath}`;
  }

  private getWorktreeContext(root: string): { worktreeId: string; repoId: string; isGit: boolean } {
    const detected = detectGitWorktree(root);
    if (!detected) {
      return {
        worktreeId: DEFAULT_WORKTREE_ID,
        repoId: this.repoId,
        isGit: false,
      };
    }

    return {
      worktreeId: detected.worktreeId,
      repoId: detected.repoId,
      isGit: true,
    };
  }

  private makeRepoId(roots: string[]): string {
    if (roots[0]) {
      const git = detectGitWorktree(roots[0]);
      if (git) return git.repoId;
    }

    const root = roots[0] ? basename(roots[0]) : "default-repo";
    return root || "default-repo";
  }

  private async resolveGoReferenceTarget(
    symbol: string,
    filePath?: string,
  ): Promise<GoReferenceResolution> {
    if (filePath) {
      const normalized = normalizePathForLookup(filePath, this.indexedRoots);
      if (!normalized) {
        return {
          kind: "unresolved",
          reason: `filePath rejected by path security rules: ${filePath}`,
          candidates: [],
        };
      }

      const absolutePath = this.resolveFileOnDisk(normalized);
      if (!absolutePath || extname(absolutePath).toLowerCase() !== ".go") {
        return {
          kind: "unresolved",
          reason: `filePath is not a Go file or does not exist in index scope: ${filePath}`,
          candidates: [],
        };
      }

      const location = findSymbolPositionInFile(absolutePath, symbol);
      if (!location) {
        return {
          kind: "unresolved",
          reason: `symbol '${symbol}' was not found in ${filePath}`,
          candidates: [],
        };
      }

      return {
        kind: "resolved",
        target: {
          absolutePath,
          line: location.line,
          column: location.column,
        },
        candidates: [`${normalized}:${location.line} symbol ${symbol}`],
      };
    }

    const symbols = await this.metadataStore.getSymbols({
      name: symbol,
      repoId: this.repoId,
    });

    const goSymbols = symbols
      .filter((entry) => entry.filePath.endsWith(".go"))
      .sort((a, b) => a.startLine - b.startLine);

    if (goSymbols.length === 0) {
      return {
        kind: "unresolved",
        reason: `no indexed Go symbol candidates for '${symbol}'`,
        candidates: [],
      };
    }

    const exact = goSymbols.filter((entry) => entry.name === symbol);
    const candidates = (exact.length > 0 ? exact : goSymbols)
      .slice(0, 8)
      .map((entry) => `${entry.filePath}:${entry.startLine} ${entry.kind} ${entry.name}`);

    if (exact.length === 0) {
      return {
        kind: "ambiguous",
        reason: `no exact Go symbol match for '${symbol}' (partial matches exist)`,
        candidates,
      };
    }

    if (exact.length > 1) {
      return {
        kind: "ambiguous",
        reason: `multiple exact Go symbol matches for '${symbol}'`,
        candidates,
      };
    }

    const selected = exact[0];
    const absolutePath = this.resolveFileOnDisk(selected.filePath);
    if (!absolutePath) {
      return {
        kind: "unresolved",
        reason: `resolved symbol path not found on disk: ${selected.filePath}`,
        candidates,
      };
    }

    const location = findSymbolPositionInFile(absolutePath, symbol, selected.startLine);
    if (!location) {
      return {
        kind: "unresolved",
        reason: `could not resolve symbol position for '${symbol}' in ${selected.filePath}`,
        candidates,
      };
    }

    return {
      kind: "resolved",
      target: {
        absolutePath,
        line: location.line,
        column: location.column,
      },
      candidates,
    };
  }

  private findGoReferencesWithGopls(
    target: { absolutePath: string; line: number; column: number },
    options: { includeDeclaration: boolean; limit: number },
  ): string[] {
    const args = ["references"];
    if (options.includeDeclaration) {
      args.push("-d");
    }

    args.push(`${target.absolutePath}:${target.line}:${target.column}`);

    const output = execFileSync("gopls", args, {
      cwd: dirname(target.absolutePath),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (!output) {
      return [];
    }

    const refs = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map(formatReferencePath)
      .filter((line): line is string => !!line);

    return Array.from(new Set(refs)).slice(0, options.limit);
  }

  private async findReferencesHeuristic(
    symbol: string,
    options: { filePath?: string; limit: number },
  ): Promise<string[]> {
    const escaped = escapeRegExp(symbol);
    const pattern = new RegExp(`\\b${escaped}\\b`);
    const restrictExtension = options.filePath ? extname(options.filePath).toLowerCase() : null;

    const files = await this.findFiles("", {
      worktreeId: this.primaryWorktreeId,
    });

    const references: string[] = [];

    for (const relativePath of files) {
      if (restrictExtension && extname(relativePath).toLowerCase() !== restrictExtension) {
        continue;
      }

      const absolutePath = this.resolveFileOnDisk(relativePath);
      if (!absolutePath || !existsSync(absolutePath)) continue;

      let content: string;
      try {
        content = readFileSync(absolutePath, "utf-8");
      } catch {
        continue;
      }

      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!pattern.test(line)) continue;

        references.push(`${relativePath}:${index + 1}:${line.trim().slice(0, 200)}`);
        if (references.length >= options.limit) {
          return references;
        }
      }
    }

    return references;
  }

  private lookupTsEdgesForFile(normalizedPath: string, absolutePath: string): TsDependencyEdge[] {
    const candidates = new Set<string>([
      normalizeFilePath(normalizedPath),
      normalizeFilePath(relative(process.cwd(), absolutePath)),
    ]);

    for (const root of this.indexedRoots) {
      candidates.add(normalizeFilePath(relative(resolve(root), absolutePath)));
    }

    for (const candidate of candidates) {
      if (!candidate || candidate.startsWith("../")) continue;
      const edges = this.tsDeps.getFileEdges(candidate);
      if (edges.length > 0) {
        return edges;
      }
    }

    return [];
  }

  private resolveFileOnDisk(filePath: string): string | null {
    const normalized = normalizeFilePath(filePath);

    for (const root of this.indexedRoots) {
      const candidate = resolve(root, normalized);
      if (existsSync(candidate)) return candidate;

      // if indexed path is already relative from cwd
      const candidateFromCwd = resolve(process.cwd(), normalized);
      if (existsSync(candidateFromCwd)) return candidateFromCwd;
    }

    return null;
  }
}

function normalizeFilePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function matchesPattern(file: string, pattern: string): boolean {
  try {
    if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
      const glob = new Bun.Glob(pattern);
      if (glob.match(file)) return true;

      // common expectation: "*.ts" should match basename even for nested paths
      if (!pattern.includes("/")) {
        return glob.match(basename(file));
      }

      return false;
    }
  } catch {
    // ignore and fallback
  }

  return file.toLowerCase().includes(pattern.toLowerCase());
}

function isTsLikePath(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts" || ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs";
}

function formatTsEdges(edges: TsDependencyEdge[]): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const edge of edges) {
    const target = edge.resolvedTarget ?? `unresolved:${edge.rawSpecifier}`;
    const key = `${edge.edgeKind}:${target}:${edge.rawSpecifier}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (edge.resolvedTarget) {
      lines.push(`- [${edge.edgeKind}] ${edge.resolvedTarget} (from '${edge.rawSpecifier}')`);
    } else {
      lines.push(`- [${edge.edgeKind}] ${edge.rawSpecifier} (unresolved: ${edge.unresolvedReason ?? "unknown"})`);
    }
  }

  return lines;
}

function stripCodeExtension(path: string): string {
  return path.replace(/(?:\.d\.ts|\.tsx|\.ts|\.mts|\.cts|\.jsx|\.js|\.mjs|\.cjs|\.go|\.py|\.rs|\.kt|\.kts|\.java)$/i, "");
}

function dependencyMatchesTarget(
  dep: string,
  context: {
    normalizedTarget: string;
    targetNoExt: string;
    targetDir: string;
    targetLooksLikePath: boolean;
    resolvedCandidates: Set<string>;
  },
): boolean {
  if (!dep) return false;

  if (dep === context.normalizedTarget || dep === context.targetNoExt) {
    return true;
  }

  if (context.resolvedCandidates.has(dep)) {
    return true;
  }

  if (context.targetLooksLikePath) {
    if (
      dep.endsWith(`/${context.normalizedTarget}`) ||
      dep.endsWith(`/${context.targetNoExt}`) ||
      dep === context.targetDir ||
      dep.endsWith(`/${context.targetDir}`)
    ) {
      return true;
    }
  }

  return false;
}

function extractDependencies(content: string, filePath?: string, roots: string[] = []): string[] {
  const deps = new Set<string>();
  const language = inferLanguageFromPath(filePath ?? "");

  const add = (specifier: string) => {
    const normalized = formatDependencySpecifier(specifier, {
      sourceFilePath: filePath,
      language,
      roots,
    });
    deps.add(normalized);
  };

  if (language === "go") {
    collectGoDependencies(content, deps);
  }

  for (const match of content.matchAll(/import\s+[^"']*from\s+["']([^"']+)["']/g)) {
    add(match[1]);
  }
  for (const match of content.matchAll(/require\(["']([^"']+)["']\)/g)) {
    add(match[1]);
  }
  for (const match of content.matchAll(/^\s*from\s+([a-zA-Z0-9_\.]+)\s+import\s+/gm)) {
    add(match[1]);
  }
  for (const match of content.matchAll(/^\s*import\s+([a-zA-Z0-9_\.]+)/gm)) {
    add(match[1]);
  }
  for (const match of content.matchAll(/^\s*use\s+([^;]+);/gm)) {
    add(match[1].trim());
  }

  return Array.from(deps).sort();
}

function collectGoDependencies(content: string, deps: Set<string>): void {
  const blockRegex = /^\s*import\s*\(([^)]*)\)/gms;
  for (const block of content.matchAll(blockRegex)) {
    const body = block[1] ?? "";
    for (const quoted of body.matchAll(/"([^"]+)"/g)) {
      if (quoted[1]) deps.add(quoted[1]);
    }
  }

  for (const single of content.matchAll(/^\s*import\s+(?:[._]\s+|[A-Za-z_][\w]*\s+)?"([^"]+)"\s*$/gm)) {
    if (single[1]) deps.add(single[1]);
  }
}

function formatDependencySpecifier(
  specifier: string,
  context: { sourceFilePath?: string; language: string; roots: string[] },
): string {
  const trimmed = specifier.trim();
  if (!trimmed) return trimmed;

  if (
    (context.language === "typescript" || context.language === "javascript") &&
    trimmed.startsWith(".") &&
    context.sourceFilePath
  ) {
    const absolute = resolve(dirname(context.sourceFilePath), trimmed);
    const normalized = normalizeFilePath(absolute);

    for (const root of context.roots) {
      const rel = normalizeFilePath(relative(resolve(root), absolute));
      if (!rel.startsWith("../") && rel !== "..") {
        return rel;
      }
    }

    return normalized;
  }

  return trimmed;
}

function chunksToSymbols(chunks: Chunk[], repoId: string): SymbolInfo[] {
  const symbols = chunks
    .filter((chunk) => chunk.symbolName && chunk.symbolKind)
    .map((chunk) => ({
      name: chunk.symbolName!,
      kind: chunk.symbolKind!,
      filePath: chunk.filePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      repoId,
    }));

  const seen = new Set<string>();
  return symbols.filter((s) => {
    const key = `${s.filePath}:${s.startLine}:${s.name}:${s.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractSymbols(content: string, filePath: string, repoId: string): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];

  const patterns: Array<{ regex: RegExp; kind: SymbolInfo["kind"]; group: number }> = [
    // TS/JS
    { regex: /^\s*(?:export\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm, kind: "function", group: 1 },
    { regex: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm, kind: "class", group: 1 },
    { regex: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/gm, kind: "interface", group: 1 },
    { regex: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/gm, kind: "type", group: 1 },

    // Python
    { regex: /^\s*def\s+([A-Za-z_][\w]*)\s*\(/gm, kind: "function", group: 1 },
    { regex: /^\s*class\s+([A-Za-z_][\w]*)/gm, kind: "class", group: 1 },

    // Go
    { regex: /^\s*func\s+([A-Za-z_][\w]*)\s*\(/gm, kind: "function", group: 1 },
    { regex: /^\s*func\s*\(\s*[A-Za-z_][\w]*\s+\*?[A-Za-z_][\w]*\s*\)\s+([A-Za-z_][\w]*)\s*\(/gm, kind: "method", group: 1 },
    { regex: /^\s*type\s+([A-Za-z_][\w]*)\s+struct\b/gm, kind: "class", group: 1 },
    { regex: /^\s*type\s+([A-Za-z_][\w]*)\s+interface\b/gm, kind: "interface", group: 1 },

    // Rust
    { regex: /^\s*(?:pub\s+)?fn\s+([A-Za-z_][\w]*)\s*\(/gm, kind: "function", group: 1 },
    { regex: /^\s*(?:pub\s+)?struct\s+([A-Za-z_][\w]*)\b/gm, kind: "class", group: 1 },
    { regex: /^\s*(?:pub\s+)?trait\s+([A-Za-z_][\w]*)\b/gm, kind: "interface", group: 1 },
    { regex: /^\s*(?:pub\s+)?enum\s+([A-Za-z_][\w]*)\b/gm, kind: "enum", group: 1 },

    // Kotlin
    { regex: /^\s*(?:data\s+|sealed\s+|open\s+|abstract\s+)?class\s+([A-Za-z_][\w]*)\b/gm, kind: "class", group: 1 },
    { regex: /^\s*(?:sealed\s+)?interface\s+([A-Za-z_][\w]*)\b/gm, kind: "interface", group: 1 },
    { regex: /^\s*typealias\s+([A-Za-z_][\w]*)\b/gm, kind: "type", group: 1 },
    { regex: /^\s*(?:suspend\s+)?fun\s+(?:[A-Za-z_][\w]*\.)?([A-Za-z_][\w]*)\s*\(/gm, kind: "function", group: 1 },
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern.regex)) {
      const name = match[pattern.group];
      if (!name) continue;

      const idx = match.index ?? 0;
      const startLine = 1 + content.slice(0, idx).split(/\r?\n/).length - 1;

      symbols.push({
        name,
        kind: pattern.kind,
        filePath,
        startLine,
        endLine: startLine,
        repoId,
      });
    }
  }

  // unique by name+line
  const seen = new Set<string>();
  return symbols.filter((s) => {
    const key = `${s.filePath}:${s.startLine}:${s.name}:${s.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatReferencePath(line: string): string | null {
  const match = line.match(/^(.*?):(\d+):(\d+)(?:-(\d+))?$/);
  if (!match) return line;

  const path = match[1];
  const lineNo = Number(match[2]);
  const startCol = Number(match[3]);
  const endCol = match[4] ? Number(match[4]) : startCol;
  return `${normalizeFilePath(path)}:${lineNo}:${startCol}-${endCol}`;
}

function findSymbolPositionInFile(
  absolutePath: string,
  symbol: string,
  preferredLine?: number,
): { line: number; column: number } | null {
  if (!existsSync(absolutePath)) return null;

  const content = readFileSync(absolutePath, "utf-8");
  const lines = content.split(/\r?\n/);

  if (preferredLine && preferredLine >= 1 && preferredLine <= lines.length) {
    const preferred = lines[preferredLine - 1] ?? "";
    const preferredIdx = preferred.indexOf(symbol);
    if (preferredIdx >= 0) {
      return {
        line: preferredLine,
        column: preferredIdx + 1,
      };
    }
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const col = line.indexOf(symbol);
    if (col >= 0) {
      return {
        line: index + 1,
        column: col + 1,
      };
    }
  }

  return null;
}

function inferLanguageFromPath(path: string): string {
  switch (extname(path).toLowerCase()) {
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
    case ".kt":
    case ".kts":
      return "kotlin";
    case ".java":
      return "java";
    case ".md":
      return "markdown";
    case ".json":
      return "json";
    default:
      return "text";
  }
}

let GOPLS_AVAILABLE_CACHE: boolean | null = null;

function isGoplsAvailable(): boolean {
  if (GOPLS_AVAILABLE_CACHE !== null) {
    return GOPLS_AVAILABLE_CACHE;
  }

  try {
    execFileSync("gopls", ["version"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    GOPLS_AVAILABLE_CACHE = true;
  } catch {
    GOPLS_AVAILABLE_CACHE = false;
  }

  return GOPLS_AVAILABLE_CACHE;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
