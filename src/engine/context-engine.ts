import { readFileSync, existsSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
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
import {
  LanceVectorStore,
  SQLiteMetadataStore,
  WriteAheadLog,
  normalizePathForLookup,
} from "../storage/index.js";
import { logError, logEvent } from "../observability/logger.js";

const DEFAULT_WORKTREE_ID = "default-worktree";

export class ContextEngine implements Engine {
  private readonly metadataStore: SQLiteMetadataStore;
  private readonly vectorStore: LanceVectorStore;
  private readonly writeLog: WriteAheadLog;
  private readonly scanner = new LocalFileScanner();
  private readonly chunker = new HybridChunker();
  private readonly embedder: EmbeddingRuntimeProvider;

  private indexing = false;
  private indexedFiles = 0;
  private indexedRoots: string[];
  private readonly repoId: string;
  private primaryWorktreeId = DEFAULT_WORKTREE_ID;
  private watcher: WorktreeWatcher | null = null;
  private watcherReindexQueued = false;

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
      lines.push("Top symbols:");
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

  async getDependencies(filePath: string): Promise<string> {
    const normalized = normalizePathForLookup(filePath, this.indexedRoots);
    if (!normalized) {
      return `Rejected path (outside source roots or secret): ${filePath}`;
    }

    const resolved = this.resolveFileOnDisk(normalized);
    if (!resolved || !existsSync(resolved)) {
      return `File not found for dependency scan: ${filePath}`;
    }

    const content = readFileSync(resolved, "utf-8");
    const deps = extractDependencies(content).slice(0, 100);

    if (deps.length === 0) {
      return `No import dependencies detected in ${filePath}`;
    }

    return [`Dependencies for ${filePath}:`, ...deps.map((d) => `- ${d}`)].join("\n");
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
    const chunksStored = await this.vectorStore.count();
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
    };
  }

  async index(dirs?: string[]): Promise<void> {
    const roots = (dirs?.length ? dirs : this.config.sources.map((s) => s.path)).map((d) => resolve(d));
    this.indexedRoots = roots;

    const startedAt = Date.now();
    let scannedFiles = 0;
    let changedFiles = 0;

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
            await this.metadataStore.deleteTreeEntry(worktreeId, filePath);
            await this.metadataStore.setIndexState(this.fileHashKey(worktreeId, filePath), "");
            await this.metadataStore.deleteSymbolsByFile(filePath);
            await this.cleanupBlobIfUnreferenced(blobHash);
          }
        }

        for (const [path, entry] of previousDirtyByPath.entries()) {
          if (!seenPaths.has(path) && !dirtyPaths.has(path)) {
            await this.metadataStore.deleteDirtyFile(worktreeId, path);
            await this.cleanupBlobIfUnreferenced(entry.contentHash);
          }
        }
      }

      await this.indexDocs();
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

function extractDependencies(content: string): string[] {
  const deps = new Set<string>();

  for (const match of content.matchAll(/import\s+[^"']*from\s+["']([^"']+)["']/g)) {
    deps.add(match[1]);
  }
  for (const match of content.matchAll(/require\(["']([^"']+)["']\)/g)) {
    deps.add(match[1]);
  }
  for (const match of content.matchAll(/^\s*from\s+([a-zA-Z0-9_\.]+)\s+import\s+/gm)) {
    deps.add(match[1]);
  }
  for (const match of content.matchAll(/^\s*import\s+([a-zA-Z0-9_\.]+)/gm)) {
    deps.add(match[1]);
  }

  return Array.from(deps).sort();
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
    { regex: /^\s*(?:export\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm, kind: "function", group: 1 },
    { regex: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm, kind: "class", group: 1 },
    { regex: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/gm, kind: "interface", group: 1 },
    { regex: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/gm, kind: "type", group: 1 },
    { regex: /^\s*def\s+([A-Za-z_][\w]*)\s*\(/gm, kind: "function", group: 1 },
    { regex: /^\s*class\s+([A-Za-z_][\w]*)/gm, kind: "class", group: 1 },
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
