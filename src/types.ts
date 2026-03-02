// ─── Core Types ────────────────────────────────────────────────────────

/** A chunk is the atomic unit of indexing and search */
export interface Chunk {
  id: string;
  content: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  repoId: string;
  worktreeId?: string;
  blobHash?: string;

  // Optional AST metadata
  symbolName?: string;
  symbolKind?: SymbolKind;
  parentSymbol?: string;
  docstring?: string;
}

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "module"
  | "namespace"
  | "other";

/** Metadata about a chunk stored in SQLite */
export interface ChunkMeta {
  chunkId: string;
  blobHash: string;
  filePath: string;
  startLine: number;
  endLine: number;
  symbolName?: string;
  symbolKind?: SymbolKind;
  language: string;
  repoId: string;
}

/** Information about an indexed file */
export interface FileInfo {
  path: string;
  contentHash: string;
  size: number;
  mtime: number;
  language: string;
}

/** Search result returned to MCP clients */
export interface SearchResult {
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
  symbolName?: string;
  symbolKind?: SymbolKind;
  language: string;
  repoId: string;
  worktreeId?: string;
}

/** Symbol entry for the get_symbols tool */
export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  filePath: string;
  startLine: number;
  endLine: number;
  repoId: string;
}

/** Git worktree information */
export interface WorktreeInfo {
  worktreeId: string;
  repoId: string;
  path: string;
  branch: string;
  isMain: boolean;
  gitCommonDir: string;
}

/** Index state tracking */
export interface IndexState {
  repoId: string;
  worktreeId: string;
  lastIndexedAt: number;
  filesIndexed: number;
  chunksStored: number;
  lastCommitSha?: string;
}

// ─── Interfaces ────────────────────────────────────────────────────────

/** Embedding provider interface (local ONNX/worker or Vertex AI) */
export interface EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** Vector store interface (LanceDB or in-memory mock) */
export interface VectorStore {
  upsert(
    vectors: Float32Array[],
    chunks: Chunk[],
  ): Promise<void>;
  search(
    query: Float32Array,
    options: VectorSearchOptions,
  ): Promise<VectorSearchResult[]>;
  delete(chunkIds: string[]): Promise<void>;
  count(): Promise<number>;
  close(): Promise<void>;
}

export interface VectorSearchOptions {
  limit: number;
  filter?: Record<string, unknown>;
}

export interface VectorSearchResult {
  chunkId: string;
  score: number;
  chunk: Chunk;
}

/** Metadata store interface (SQLite or in-memory mock) */
export interface MetadataStore {
  // Blob operations
  getBlob(blobHash: string): Promise<{ chunkIds: string[] } | null>;
  upsertBlob(blobHash: string, chunkIds: string[]): Promise<void>;
  deleteBlob(blobHash: string): Promise<void>;
  countBlobReferences(blobHash: string): Promise<number>;

  // Tree entry operations (worktree → path → blobHash)
  getTreeEntries(worktreeId: string): Promise<Array<{ path: string; blobHash: string }>>;
  upsertTreeEntry(repoId: string, worktreeId: string, path: string, blobHash: string): Promise<void>;
  deleteTreeEntry(worktreeId: string, path: string): Promise<void>;
  clearTreeEntries(worktreeId: string): Promise<void>;

  // Dirty file operations
  getDirtyFiles(worktreeId: string): Promise<Array<{ path: string; contentHash: string; chunkIds: string[] }>>;
  upsertDirtyFile(worktreeId: string, path: string, contentHash: string, chunkIds: string[]): Promise<void>;
  deleteDirtyFile(worktreeId: string, path: string): Promise<void>;
  clearDirtyFiles(worktreeId: string): Promise<void>;
  getKnownWorktreeIds(): Promise<string[]>;

  // Symbol operations
  getSymbols(query: { name?: string; filePath?: string; kind?: SymbolKind; repoId?: string }): Promise<SymbolInfo[]>;
  upsertSymbols(symbols: SymbolInfo[]): Promise<void>;
  deleteSymbolsByFile(filePath: string): Promise<void>;

  // Documentation chunk operations
  upsertDocChunks(url: string, title: string, chunks: string[]): Promise<void>;
  deleteDocChunks(url: string): Promise<void>;
  searchDocChunks(query: string, limit: number): Promise<Array<{ url: string; title: string; content: string; chunkIndex: number }>>;

  // Index state
  getIndexState(key: string): Promise<string | null>;
  setIndexState(key: string, value: string): Promise<void>;

  close(): Promise<void>;
}

/** Chunker interface (AST or sliding window) */
export interface Chunker {
  chunk(content: string, filePath: string, language: string, repoId: string): Chunk[];
}

/** Source scanner interface */
export interface SourceScanner {
  scan(dir: string, options?: ScanOptions): AsyncIterable<FileInfo>;
}

export interface ScanOptions {
  include?: string[];
  exclude?: string[];
}

// ─── Engine ────────────────────────────────────────────────────────────

/** Top-level engine status */
export interface EngineStatus {
  indexing: boolean;
  repos: Array<{
    repoId: string;
    path: string;
    filesIndexed: number;
    chunksStored: number;
    lastIndexedAt: number;
  }>;
  embeddingModel: string;
  workerBusy: boolean;
  languageFileCounts?: Record<string, number>;
  capabilities?: {
    goReferencesBinary?: "available" | "unavailable";
    goReferencesSelection?: "requires-anchor-for-ambiguous-symbols";
    goDependencies?: "native";
    tsDependencies?: "compiler-api";
    tsReferences?: "compiler-api";
  };
  tsDependencyGraph?: {
    filesIndexed: number;
    edgesTotal: number;
    edgesResolved: number;
    edgesUnresolved: number;
    resolutionSuccessRate: number;
    lastBuiltAt: number;
  };
}
