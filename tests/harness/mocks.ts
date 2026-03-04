import type {
  EmbeddingProvider,
  VectorStore,
  MetadataStore,
  Chunk,
  VectorSearchOptions,
  VectorSearchResult,
  SymbolInfo,
  SymbolKind,
} from "../../src/types.js";

// ─── Mock Embedding Provider ──────────────────────────────────────────

/**
 * Deterministic mock embedding provider.
 * Returns vectors based on content hashing — same input always gives
 * the same vector. Useful for testing search/ranking without ONNX.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly modelId = "mock-embed-v1";
  readonly dimensions = 64;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.hashToVector(text));
  }

  private hashToVector(text: string): Float32Array {
    const vec = new Float32Array(this.dimensions);
    // Simple deterministic hash → vector
    for (let i = 0; i < text.length; i++) {
      vec[i % this.dimensions] += text.charCodeAt(i);
    }
    // Normalize to unit vector
    let norm = 0;
    for (let i = 0; i < this.dimensions; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < this.dimensions; i++) vec[i] /= norm;
    return vec;
  }
}

// ─── Mock Vector Store ────────────────────────────────────────────────

/**
 * In-memory vector store backed by a Map. Same interface as LanceDB wrapper.
 * Uses brute-force cosine similarity for search.
 */
export class MockVectorStore implements VectorStore {
  private entries = new Map<string, { vector: Float32Array; chunk: Chunk }>();

  async upsert(vectors: Float32Array[], chunks: Chunk[]): Promise<void> {
    for (let i = 0; i < chunks.length; i++) {
      this.entries.set(chunks[i].id, {
        vector: vectors[i],
        chunk: chunks[i],
      });
    }
  }

  async search(query: Float32Array, options: VectorSearchOptions): Promise<VectorSearchResult[]> {
    const results: VectorSearchResult[] = [];

    for (const [id, entry] of this.entries) {
      // Apply filters
      if (options.filter) {
        let matches = true;
        for (const [key, value] of Object.entries(options.filter)) {
          if ((entry.chunk as any)[key] !== value) {
            matches = false;
            break;
          }
        }
        if (!matches) continue;
      }

      const score = cosine(query, entry.vector);
      results.push({ chunkId: id, score, chunk: entry.chunk });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, options.limit);
  }

  async delete(chunkIds: string[]): Promise<void> {
    for (const id of chunkIds) {
      this.entries.delete(id);
    }
  }

  async count(): Promise<number> {
    return this.entries.size;
  }

  async optimize(): Promise<void> {
    // no-op for mock
  }

  async close(): Promise<void> {
    this.entries.clear();
  }
}

// ─── Mock Metadata Store ──────────────────────────────────────────────

/**
 * In-memory metadata store backed by Maps. Same interface as SQLite wrapper.
 */
export class MockMetadataStore implements MetadataStore {
  private blobs = new Map<string, { chunkIds: string[] }>();
  private treeEntries = new Map<string, Map<string, { repoId: string; blobHash: string }>>();
  private dirtyFiles = new Map<string, Map<string, { contentHash: string; chunkIds: string[] }>>();
  private symbols: SymbolInfo[] = [];
  private docs = new Map<string, { title: string; chunks: string[] }>();
  private state = new Map<string, string>();

  // Blob operations
  async getBlob(blobHash: string) {
    return this.blobs.get(blobHash) ?? null;
  }
  async upsertBlob(blobHash: string, chunkIds: string[]) {
    this.blobs.set(blobHash, { chunkIds });
  }
  async deleteBlob(blobHash: string) {
    this.blobs.delete(blobHash);
  }
  async countBlobReferences(blobHash: string) {
    let count = 0;

    for (const entries of this.treeEntries.values()) {
      for (const entry of entries.values()) {
        if (entry.blobHash === blobHash) count += 1;
      }
    }

    for (const files of this.dirtyFiles.values()) {
      for (const entry of files.values()) {
        if (entry.contentHash === blobHash) count += 1;
      }
    }

    return count;
  }

  // Tree entries
  async getTreeEntries(worktreeId: string) {
    const entries = this.treeEntries.get(worktreeId);
    if (!entries) return [];
    return Array.from(entries.entries()).map(([path, e]) => ({ path, blobHash: e.blobHash }));
  }
  async upsertTreeEntry(repoId: string, worktreeId: string, path: string, blobHash: string) {
    if (!this.treeEntries.has(worktreeId)) this.treeEntries.set(worktreeId, new Map());
    this.treeEntries.get(worktreeId)!.set(path, { repoId, blobHash });
  }
  async deleteTreeEntry(worktreeId: string, path: string) {
    this.treeEntries.get(worktreeId)?.delete(path);
  }
  async clearTreeEntries(worktreeId: string) {
    this.treeEntries.delete(worktreeId);
  }

  // Dirty files
  async getDirtyFiles(worktreeId: string) {
    const files = this.dirtyFiles.get(worktreeId);
    if (!files) return [];
    return Array.from(files.entries()).map(([path, f]) => ({ path, ...f }));
  }
  async upsertDirtyFile(worktreeId: string, path: string, contentHash: string, chunkIds: string[]) {
    if (!this.dirtyFiles.has(worktreeId)) this.dirtyFiles.set(worktreeId, new Map());
    this.dirtyFiles.get(worktreeId)!.set(path, { contentHash, chunkIds });
  }
  async deleteDirtyFile(worktreeId: string, path: string) {
    this.dirtyFiles.get(worktreeId)?.delete(path);
  }
  async clearDirtyFiles(worktreeId: string) {
    this.dirtyFiles.delete(worktreeId);
  }
  async getKnownWorktreeIds() {
    const ids = new Set<string>([
      ...this.treeEntries.keys(),
      ...this.dirtyFiles.keys(),
    ]);
    return Array.from(ids).sort();
  }

  // Documentation
  async upsertDocChunks(url: string, title: string, chunks: string[]) {
    this.docs.set(url, { title, chunks: [...chunks] });
  }
  async deleteDocChunks(url: string) {
    this.docs.delete(url);
  }
  async searchDocChunks(query: string, limit: number) {
    const q = query.toLowerCase();
    const out: Array<{ url: string; title: string; content: string; chunkIndex: number }> = [];

    for (const [url, doc] of this.docs.entries()) {
      for (let i = 0; i < doc.chunks.length; i++) {
        const content = doc.chunks[i];
        const haystack = `${url}\n${doc.title}\n${content}`.toLowerCase();
        if (!haystack.includes(q)) continue;
        out.push({ url, title: doc.title, content, chunkIndex: i });
        if (out.length >= Math.max(1, limit)) {
          return out;
        }
      }
    }

    return out;
  }

  // Symbols
  async getSymbols(query: { name?: string; filePath?: string; kind?: SymbolKind; repoId?: string; limit?: number }) {
    const filtered = this.symbols.filter((s) => {
      if (query.name && !s.name.toLowerCase().includes(query.name.toLowerCase())) return false;
      if (query.filePath && s.filePath !== query.filePath) return false;
      if (query.kind && s.kind !== query.kind) return false;
      if (query.repoId && s.repoId !== query.repoId) return false;
      return true;
    });

    return filtered.slice(0, Math.max(1, Math.floor(query.limit ?? 200)));
  }
  async upsertSymbols(symbols: SymbolInfo[]) {
    for (const sym of symbols) {
      const idx = this.symbols.findIndex(
        (s) => s.name === sym.name && s.filePath === sym.filePath && s.startLine === sym.startLine,
      );
      if (idx >= 0) this.symbols[idx] = sym;
      else this.symbols.push(sym);
    }
  }
  async deleteSymbolsByFile(filePath: string) {
    this.symbols = this.symbols.filter((s) => s.filePath !== filePath);
  }

  // Index state
  async getIndexState(key: string) {
    return this.state.get(key) ?? null;
  }
  async setIndexState(key: string, value: string) {
    this.state.set(key, value);
  }

  async close() {
    this.blobs.clear();
    this.treeEntries.clear();
    this.dirtyFiles.clear();
    this.symbols = [];
    this.docs.clear();
    this.state.clear();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
