# Context Engine MCP — Architecture

A local-first MCP server that indexes codebases, documentation, and git history,
then exposes semantic search and code intelligence tools to any MCP-compatible AI agent.

## Design Principles

1. **Local-first**: All indexing and search happens on your machine. No cloud dependency.
2. **Incremental**: Only re-index what changed. File watcher + content hashing.
3. **Multi-source**: Index code repos, git history, documentation URLs, and wikis.
4. **Pluggable embeddings**: Local ONNX/worker (default) or Vertex AI.
5. **Secure by default**: Path jailing, secret file exclusion, sandboxed code execution.
6. **Non-blocking**: Embedding inference runs off the main thread to keep MCP responsive.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    MCP Clients                               │
│  Claude Code  ·  Cursor  ·  Zed  ·  Pi  ·  Any MCP Agent   │
└──────────┬──────────────────────────────────────┬────────────┘
           │ STDIO                                │ HTTP
┌──────────▼──────────────────────────────────────▼────────────┐
│                   MCP Transport Layer                         │
│              StdioTransport / StreamableHTTP                  │
├──────────────────────────────────────────────────────────────┤
│                    Security Layer                             │
│  Path jail (allowed dirs only) · Secret exclusion (.env,     │
│  .ssh, tokens) · Input validation · Rate limiting             │
├──────────────────────────────────────────────────────────────┤
│                      Tool Router                              │
│  semantic_search · find_files · get_symbols · get_file_summary│
│  get_recent_changes · get_dependencies · find_references      │
│  execute                                                      │
├──────────────────────────────────────────────────────────────┤
│                     Query Engine                              │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐     │
│  │ Query Parser │→ │ Vector Search │→ │ Result Reranker  │     │
│  │ (expand,     │  │ (LanceDB     │  │ (score fusion,   │     │
│  │  rephrase)   │  │  cosine sim)  │  │  dedup, format)  │     │
│  └─────────────┘  └──────────────┘  └─────────────────┘     │
├──────────────────────────────────────────────────────────────┤
│                   Indexing Pipeline                           │
│  ┌──────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐ │
│  │ Source    │→ │ Chunker   │→ │ Embedding │→ │ Storage   │ │
│  │ Scanner  │  │ (AST +    │  │ Worker    │  │ Writer    │ │
│  │ (walk,   │  │  sliding) │  │ (Worker   │  │ (Lance +  │ │
│  │  filter) │  │           │  │  thread)  │  │  SQLite)  │ │
│  └──────────┘  └───────────┘  └───────────┘  └───────────┘ │
├──────────────────────────────────────────────────────────────┤
│                   Source Connectors                           │
│  ┌──────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐ │
│  │ Local FS │  │ Git Repos │  │ Git       │  │ Doc URLs  │ │
│  │ + Watch  │  │ (clone/   │  │ History   │  │ (fetch +  │ │
│  │          │  │  pull)    │  │ (log/diff)│  │  extract)  │ │
│  └──────────┘  └───────────┘  └───────────┘  └───────────┘ │
├──────────────────────────────────────────────────────────────┤
│                    Storage Layer                              │
│  ┌──────────────────┐  ┌────────────────────────────────┐   │
│  │ LanceDB          │  │ SQLite (bun:sqlite)            │   │
│  │ · chunk vectors  │  │ · file index (path→hash→meta)  │   │
│  │ · metadata cols  │  │ · symbol table (name→locations) │   │
│  │ · ANN search     │  │ · index state (what's indexed)  │   │
│  └──────────────────┘  │ · write-ahead log for LanceDB   │   │
│                         │   consistency                    │   │
│                         └────────────────────────────────┘   │
├──────────────────────────────────────────────────────────────┤
│                  Embedding Worker (off main thread)           │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Worker Thread — owns ONNX model + tokenizer          │   │
│  │ · Priority queue: search queries jump ahead of index │   │
│  │ · Backpressure: max 2 in-flight batches              │   │
│  │ · Reports busy/idle state for MCP health checks      │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

## Project Structure

```
context-engine/
├── src/
│   ├── cli.ts                      # CLI entry (index, serve, status)
│   ├── config.ts                   # Configuration types + loader
│   ├── types.ts                    # Shared type definitions
│   │
│   ├── server/
│   │   ├── mcp-server.ts           # MCP server orchestrator
│   │   ├── transports.ts           # STDIO + HTTP transport setup
│   │   └── tools/
│   │       ├── index.ts            # Tool registry
│   │       ├── semantic-search.ts
│   │       ├── find-files.ts
│   │       ├── get-symbols.ts
│   │       ├── get-file-summary.ts
│   │       ├── get-recent-changes.ts
│   │       ├── get-dependencies.ts
│   │       ├── search-docs.ts
│   │       └── code-sandbox.ts     # TS sandbox for programmatic queries
│   │
│   ├── engine/
│   │   ├── engine.ts               # Core engine — ties everything together
│   │   ├── indexer.ts              # Incremental indexing orchestrator
│   │   ├── watcher.ts              # Worktree-aware polling watcher + debounce
│   │   ├── searcher.ts             # Multi-signal search + reranking
│   │   └── reranker.ts             # Score fusion + deduplication
│   │
│   ├── chunker/
│   │   ├── chunker.ts              # Chunking router (AST vs text)
│   │   ├── ast-chunker.ts          # Tree-sitter based chunking
│   │   ├── text-chunker.ts         # Sliding window fallback
│   │   └── languages.ts            # Language→tree-sitter grammar map
│   │
│   ├── embeddings/
│   │   ├── runtime.ts              # Runtime embedder interface (priority + lifecycle)
│   │   ├── factory.ts              # Provider selector (local | vertex)
│   │   ├── worker-provider.ts      # Local worker embedder (priority queue, backpressure)
│   │   ├── worker-thread.ts        # Worker process entrypoint
│   │   ├── local-onnx.ts           # @huggingface/transformers (runs in Worker)
│   │   └── vertex.ts               # Vertex AI embeddings provider
│   │
│   ├── sources/
│   │   ├── local-fs.ts             # Local directory scanner
│   │   ├── git-repo.ts             # Git clone/pull connector
│   │   ├── git-history.ts          # Git log/diff indexer
│   │   ├── git-worktree.ts         # Worktree detection + base/overlay indexing
│   │   └── doc-fetcher.ts          # URL/doc site fetcher
│   │
│   └── storage/
│       ├── vector-store.ts         # LanceDB wrapper
│       ├── metadata-store.ts       # SQLite wrapper (bun:sqlite)
│       ├── write-log.ts            # WAL for Lance↔SQLite consistency
│       ├── security.ts             # Path jail, secret exclusion, input validation
│       └── schemas.ts              # DB schemas + migrations
│
├── tests/
├── package.json
├── tsconfig.json
└── bunfig.toml
```

## Git Worktree Support

The engine is **worktree-aware**. Multiple worktrees of the same repo share a
single base index, with lightweight per-worktree overlays for dirty files.

### Detection (automatic)

At index time, we run `git rev-parse --git-common-dir` and `git worktree list --porcelain`.
This transparently detects:
- **Main worktree**: `.git` is a directory → the "home" of the shared object store
- **Linked worktrees**: `.git` is a file pointing to `<main>/.git/worktrees/<name>`

A stable **repoId** is derived from `hash(gitCommonDir)`, shared across all worktrees.

### Storage Model: Base + Overlay

```
┌─────────────────────────────────────────────────────┐
│                 Shared Base Index                     │
│          (keyed by repoId, indexed once)             │
│                                                       │
│  ┌─────────────┐  ┌──────────────────────────────┐  │
│  │ Git History  │  │ Blob-level content index      │  │
│  │ commits,     │  │ Unique blobs by blobHash —    │  │
│  │ diffs, msgs  │  │ content-addressable, shared   │  │
│  │              │  │ across branches automatically  │  │
│  └─────────────┘  └──────────────────────────────┘  │
├─────────────────────────────────────────────────────┤
│  Worktree: /projects/myapp (branch: main)            │
│  · Tree manifest: HEAD tree → path→blobHash mapping  │
│  · Dirty overlay: modified/untracked files            │
├─────────────────────────────────────────────────────┤
│  Worktree: /projects/myapp-feature (feature/auth)    │
│  · Tree manifest: HEAD tree → path→blobHash mapping  │
│  · Dirty overlay: modified/untracked files            │
└─────────────────────────────────────────────────────┘
```

**Key insight:** The base index stores content by **blobHash**, not by path.
A blob is indexed once regardless of how many branches or paths reference it.
Each worktree resolves its own `HEAD` tree to know which blobs are visible,
then overlays dirty files on top. This avoids the race condition where two
worktrees on different branches overwrite each other's path→blob mappings.

### How it works

1. **First index** of any worktree triggers indexing of all unique blobs reachable
   from its `HEAD` tree. Blobs are stored by `blobHash` (content-addressable) —
   if a blob already exists in the base index, it's skipped.
2. **Dirty files** (modified/untracked per `git status`) are indexed into a
   per-worktree overlay (stored in SQLite under the worktree's ID)
3. **Subsequent worktrees** of the same repo only need to index blobs that are
   new to them (most are shared). Each worktree resolves its own `HEAD` tree
   to a `path→blobHash` mapping via `git ls-tree -r HEAD`.
4. **Search** resolves the worktree's `HEAD` tree manifest, then overlays dirty
   files. The blob→chunk mapping plus the tree manifest tells us which chunks
   are visible to this worktree. Overlay chunks take priority.
5. **Git history** is indexed once per repo, shared across all worktrees
6. **File watcher** runs per-worktree (each has its own working tree)

### SQLite schema (replaces LevelDB)

Using `bun:sqlite` — native to Bun, zero external binaries, supports concurrent
reads and SQL joins (much simpler than LevelDB prefix scans for relational lookups).

```sql
-- Blobs: content-addressable, shared across branches
CREATE TABLE blobs (
  blob_hash   TEXT PRIMARY KEY,  -- git blob hash (or content hash for non-git)
  chunk_ids   TEXT NOT NULL       -- JSON array of chunk IDs
);

-- Worktree tree manifests: what each worktree sees at HEAD
CREATE TABLE tree_entries (
  repo_id      TEXT NOT NULL,
  worktree_id  TEXT NOT NULL,
  path         TEXT NOT NULL,
  blob_hash    TEXT NOT NULL REFERENCES blobs(blob_hash),
  PRIMARY KEY (worktree_id, path)
);
CREATE INDEX idx_tree_repo ON tree_entries(repo_id);

-- Dirty overlays: uncommitted changes per worktree
CREATE TABLE dirty_files (
  worktree_id   TEXT NOT NULL,
  path          TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  chunk_ids     TEXT NOT NULL,  -- JSON array of chunk IDs
  PRIMARY KEY (worktree_id, path)
);

-- Index state
CREATE TABLE index_state (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- Symbols (for get_symbols tool)
CREATE TABLE symbols (
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,  -- function, class, interface, etc.
  file_path  TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line   INTEGER NOT NULL,
  chunk_id   TEXT NOT NULL,
  repo_id    TEXT NOT NULL
);
CREATE INDEX idx_symbols_name ON symbols(name);
CREATE INDEX idx_symbols_file ON symbols(file_path);

-- Write-ahead log for Lance↔SQLite consistency
CREATE TABLE write_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  operation  TEXT NOT NULL,     -- 'upsert' | 'delete'
  chunk_ids  TEXT NOT NULL,     -- JSON array
  lance_ok   INTEGER DEFAULT 0, -- 1 when LanceDB write confirmed
  sqlite_ok  INTEGER DEFAULT 0, -- 1 when SQLite metadata updated
  created_at TEXT DEFAULT (datetime('now'))
);
```

**Write-ahead log:** Every index write first records its intent in `write_log`,
then writes to LanceDB, then updates SQLite metadata, then marks the log entry
complete. On startup, incomplete log entries are reconciled: either rolled back
or completed. This prevents orphaned vectors from LanceDB↔SQLite inconsistency.

### Search with worktree context

```typescript
async function search(query: string, worktreeId: string): Promise<Result[]> {
  const queryVec = await embedWorker.embed(query, { priority: 'search' });

  // 1. Resolve this worktree's visible blobs from its HEAD tree manifest
  const treeEntries = await db.all(
    `SELECT path, blob_hash FROM tree_entries WHERE worktree_id = ?`, worktreeId
  );

  // 2. Get dirty overlay files (these override committed blobs)
  const dirtyFiles = await db.all(
    `SELECT path, chunk_ids FROM dirty_files WHERE worktree_id = ?`, worktreeId
  );
  const dirtyPaths = new Set(dirtyFiles.map(f => f.path));

  // 3. Build chunk ID set: overlay chunks for dirty files, base chunks for clean files
  const chunkIds: string[] = [];
  for (const entry of treeEntries) {
    if (dirtyPaths.has(entry.path)) continue; // overlay wins
    const blob = await db.get(`SELECT chunk_ids FROM blobs WHERE blob_hash = ?`, entry.blob_hash);
    if (blob) chunkIds.push(...JSON.parse(blob.chunk_ids));
  }
  for (const dirty of dirtyFiles) {
    chunkIds.push(...JSON.parse(dirty.chunk_ids));
  }

  // 4. Vector search filtered to this worktree's visible chunks
  const results = await vectorStore.search(queryVec, {
    filter: `id IN (${chunkIds.map(id => `'${id}'`).join(',')})`,
    limit: 50,
  });

  return rerank(results);
}
```

## Key Data Flows

### Indexing Flow
1. **Source scanner** walks files, checks content hash against SQLite
2. Only new/changed files pass to the **chunker**
3. AST chunker (tree-sitter) extracts functions, classes, types → `Chunk[]`
4. Unsupported languages fall back to sliding window chunker
5. **Write-ahead log** records intent (chunk IDs + operation)
6. Chunks are batched (32 at a time) through **embedding worker thread**
   (off main thread — MCP stays responsive during indexing)
7. Vectors + metadata written to **LanceDB**, then file state to **SQLite**
8. Write-ahead log entry marked complete

### Search Flow
1. Query arrives via MCP tool call
2. **Security layer** validates path arguments, rejects out-of-sandbox paths
3. Query is embedded using same model as indexing (via embedding worker,
   search priority — jumps ahead of index batches)
4. LanceDB ANN search returns top-K candidates (k=50)
5. Reranker scores by: vector similarity × recency × symbol match
6. Top-N results (n=10) returned with file path, line range, snippet

### Incremental Update Flow
1. File watcher (worktree-aware polling + debounce) detects change
2. Changed file's old chunks are deleted from LanceDB
3. File re-chunked, re-embedded, re-stored
4. Content hash updated in SQLite

## Configuration (`context-engine.json`)

```json
{
  "sources": [
    { "path": "./", "include": ["**/*"], "exclude": ["node_modules", ".git"] }
  ],
  "embedding": {
    "provider": "local",
    "localBackend": "onnx",
    "model": "Xenova/all-MiniLM-L6-v2",
    "dimensions": 768,
    "fallbackToMock": true
  },
  "dataDir": ".context-engine",
  "server": {
    "transport": "stdio",
    "port": 3777
  }
}
```

Embedding provider options are currently **`local`** and **`vertex`** only.

## Security

The engine is exposed to AI agents via MCP tools. An LLM can call `find_files`,
`get_file_summary`, etc. with arbitrary arguments. Without sandboxing, a
prompt-injected or hallucinating agent could read `~/.ssh/id_rsa`, `.env` files,
or execute arbitrary code via the sandbox tool.

### Path Jailing

All tool calls that accept file paths are validated against an **allow-list** of
configured source directories. Any path that resolves outside the jail is rejected.

```typescript
// security.ts
function validatePath(requestedPath: string, allowedDirs: string[]): string {
  const resolved = path.resolve(requestedPath);
  const allowed = allowedDirs.some(dir => resolved.startsWith(path.resolve(dir) + path.sep));
  if (!allowed) throw new SecurityError(`Path outside allowed directories: ${requestedPath}`);
  return resolved;
}
```

### Secret File Exclusion

The scanner automatically excludes files matching these patterns (not configurable
to disable — security invariant):

```
.env, .env.*, *.pem, *.key, id_rsa*, id_ed25519*, *.p12, *.pfx,
.npmrc (if contains token), .pypirc, credentials.json, tokens.json,
.git/config (may contain tokens), **/.ssh/*, **/secrets/*, *.secret
```

These files are never indexed, never returned by `find_files`, and never readable
via `get_file_summary`.

### Code Sandbox Isolation

The `code-sandbox` tool does NOT run in the host Bun process. It must use an
isolated execution environment:
- **Primary:** QuickJS WASM sandbox with strict timeout and runtime limits
- **Fallback:** `--sandbox-docker` flag for Docker-based isolation

The sandbox has no filesystem access, no network access, and a 5-second timeout.
It receives a read-only snapshot of search results / symbols as input.

### Resource Throttling

To avoid pegging the CPU during indexing (while the user is trying to compile):

```json
{
  "performance": {
    "maxConcurrency": 2,        // max parallel embedding batches
    "cpuThrottle": "normal",    // "low" | "normal" | "high" — sets nice level
    "maxMemoryMB": 2048,        // refuse to start new batches above this
    "indexingPriority": "background" // "background" | "foreground"
  }
}
```

## Embedding Worker

ONNX inference is CPU-bound and blocks the event loop. A batch of 32 chunks can
block for 200-500ms, making the MCP transport unresponsive during indexing.

### Architecture

```
┌─────────────────────┐         ┌──────────────────────┐
│   Main Thread       │         │   Worker Thread       │
│                     │         │                       │
│  MCP Transport      │         │  ONNX Model (loaded)  │
│  Tool Router        │  ←IPC→  │  embed(texts[])       │
│  Indexer (orchestr) │         │  Tokenizer            │
│  Searcher           │         │                       │
│  SQLite / LanceDB   │         │  Priority queue       │
└─────────────────────┘         └──────────────────────┘
```

### Priority Queue

Search `embed(query)` calls are latency-sensitive. Index `embed(batch)` calls are
throughput-sensitive. The worker maintains a priority queue:

- **Priority 0 (search):** Single query embedding, <50ms target. Jumps ahead.
- **Priority 1 (index):** Batch of 32 chunks, can wait. Max 2 in-flight.

### Backpressure

The indexer limits in-flight batches (max 2 pending) to cap memory. If the worker
is saturated, the indexer pauses scanning until a batch completes.

### Health Signal

The worker reports busy/idle state. The MCP server exposes this in `status` tool
responses so clients can tell if the engine is actively indexing vs. ready.


## CLI Commands

```bash
# Index a directory
context-engine index .

# Index with config file
context-engine index --config context-engine.json

# Start MCP server (STDIO mode — for Claude Code, Cursor, etc.)
context-engine serve

# Start MCP server (HTTP mode — for remote/shared access)
context-engine serve --http --port 3100

# Show index status
context-engine status

# Re-index everything from scratch
context-engine reindex
```

---

## Build Plan — 8 Milestones (Walking Skeleton)

**Build vertically, not horizontally.** The first milestone delivers a working
MCP server that Claude/Cursor can talk to — with dummy implementations behind
every interface. Then we swap in real implementations one at a time, always
keeping the system end-to-end functional.

> Execution checklist and commit-level task breakdown: `IMPLEMENTATION_PLAN.md`

```
M1: Walking Skeleton     MCP Server + STDIO + dummy tools (Day 1 — connects to agents)
         │
M2: Real Storage         Swap in-memory → LanceDB + SQLite
         │
M3: Text Chunker         Sliding window chunker + indexing pipeline
         │
M4: Embeddings           ONNX Worker thread + real vector search
         │
M5: AST Chunker          Tree-sitter WASM for TS/JS/Python/Go/Rust/Java/C/C++
         │
M6: Source Connectors     Local FS scanner + Git worktree + file watcher
         │
M7: Search Quality        Reranker + Git history + docs + IR eval harness
         │
M8: Hardening            Security layer + code sandbox + crash recovery + polish
```

### Milestone 1 — Walking Skeleton (~500 LOC)

**Modules:** `types.ts`, `config.ts`, `mcp-server.ts`, `transports.ts`, `tools/index.ts`,
`cli.ts`, mock embedder, mock storage

**What it does:**
- Define all shared types: `Chunk`, `ChunkMeta`, `FileInfo`, `SearchResult`,
  `WorktreeInfo`, `IndexState`, embedding provider / storage interfaces
- Config loader: reads `context-engine.json`, validates, merges with defaults
- MCP server with STDIO transport — registers all tool names
- Dummy tool implementations backed by in-memory arrays
- CLI: `context-engine serve` starts the MCP server
- **Day 1 goal:** Claude Code / Cursor / Pi can connect and call tools

**Test assertions:**
- Start MCP server → connect with MCP client SDK → list tools → all registered
- `semantic_search({query: 'auth'})` → returns placeholder text (not crash)
- `find_files({pattern: '*.ts'})` → returns placeholder (not crash)
- STDIO transport: pipe stdin/stdout ↔ MCP client, full roundtrip works
- CLI `serve` → starts server, responds to tool calls
- Config loader merges partial configs with defaults correctly
- Invalid tool arguments → descriptive MCP error (not crash)

**Dependencies:** MCP SDK only. Everything else is mocked.

---

### Milestone 2 — Real Storage (~500 LOC)

**Modules:** `vector-store.ts`, `metadata-store.ts`, `schemas.ts`, `write-log.ts`

**What it does:**
- LanceDB wrapper: create/open tables, upsert vectors with metadata columns,
  ANN search with filters, delete by ID, compaction
- SQLite wrapper (`bun:sqlite`): tables for blobs, tree_entries, dirty_files,
  symbols, index_state, write_log
- Write-ahead log: intent recorded before write, reconciled on startup
- Schema definitions + migration support

**Test assertions:**
- Write 100 random vectors → search with a known vector → correct top-K ordering
- Cosine similarity search returns results sorted by distance
- Filter by `language = 'typescript'` returns only TS chunks
- Delete by chunk ID → no longer appears in search results
- SQLite tables created correctly, all CRUD operations work
- SQL joins: find all chunks for a worktree via tree_entries + blobs
- Write-log: incomplete entry on startup → reconcile (rollback or complete)
- Concurrent reads from multiple "clients" don't corrupt state
- Database opens from cold (simulating restart)

**Dependencies:** LanceDB, bun:sqlite (external, but no other internal modules).

---

### Milestone 3 — Text Chunker + Indexing Pipeline (~600 LOC)

**Modules:** `text-chunker.ts`, `indexer.ts`, `engine.ts`, `local-fs.ts`

**What it does:**
- Sliding window text chunker: split text into overlapping chunks with line tracking
- Local FS scanner: recursive walk with include/exclude globs, content hashing
- Indexer orchestrator: scan files → diff against stored hashes → chunk changed
  files → embed with mock embedder → write to real storage
- **Goal:** `context-engine index .` works end-to-end with real storage, text chunking,
  and mock embeddings. Search returns results.

**Test assertions:**
- 1000-line file → correct number of chunks at given window/overlap size
- Chunks preserve accurate start/end line numbers
- Empty file → zero chunks, single-line file → one chunk
- Index fixture repo from scratch → LanceDB has vectors for every file
- Modify one file → re-index → only that file's chunks updated
- Delete a file → its chunks removed from LanceDB
- MCP `semantic_search` returns real results (via mock embeddings)

**Dependencies:** Milestone 1 + 2.

---

### Milestone 4 — Embedding Worker (~400 LOC)

**Modules:** `runtime.ts`, `factory.ts`, `worker-provider.ts`, `worker-thread.ts`, `local-onnx.ts`, `vertex.ts`

**What it does:**
- `EmbeddingProvider` interface: `embed(texts: string[]): Promise<Float32Array[]>`,
  `dimensions: number`, `modelId: string`
- **Worker thread** wrapper: spawns worker, IPC message passing, priority queue
  (search priority 0, index priority 1), backpressure (max 2 in-flight batches)
- Local ONNX provider: runs in worker thread, downloads + caches model via
  `@huggingface/transformers`, tokenize + run ONNX inference
- Vertex provider: Google Vertex AI embeddings API wrapper (same runtime interface)
- Supported provider options are **local** and **vertex** only
- Swap mock local embedder → real ONNX embedder in the worker pipeline

**Test assertions:**
- `embed(['hello world'])` returns exactly 1 vector of correct dimension (768 for nomic)
- Batch of 32 texts → 32 vectors, all same dimension
- Semantic similarity: `cosine(embed('auth login'), embed('user authentication')) > 0.7`
- Semantic dissimilarity: `cosine(embed('authentication'), embed('banana smoothie')) < 0.3`
- Worker thread: main thread stays responsive during batch embedding
- Priority queue: search embed() completes before queued index batches
- Backpressure: indexer pauses when 2 batches in-flight
- Health signal: worker reports busy/idle state
- Provider interface works the same for local/vertex (swap test)

**Dependencies:** `@huggingface/transformers`, Worker threads.

---

### Milestone 5 — AST Chunker (~400 LOC)

**Modules:** `ast-chunker.ts`, `languages.ts`, `chunker.ts` (router)

**What it does:**
- Tree-sitter WASM setup: load grammars for TS, JS, Python, Go, Rust, Java, C, C++
- Parse source files into ASTs, extract semantic units (functions, classes, methods,
  interfaces, type aliases, enums)
- Each chunk carries: symbol name, symbol kind, file path, line range, docstring/comments
- Chunker router: AST chunker for supported languages, text chunker fallback

**Test assertions:**
- TypeScript file with `function authenticateUser()` → chunk with
  `{symbol: 'authenticateUser', kind: 'function', startLine, endLine}`
- Class with 3 methods → 4 chunks (1 class-level + 3 method-level)
- Interface extraction: `interface User { ... }` → chunk with `kind: 'interface'`
- Python file → AST-chunked (not sliding window)
- Unknown extension (`.xyz`) → falls back to text chunker
- Large function (500+ lines) → split into sub-chunks at logical boundaries
- Nested functions/classes preserved with parent context in metadata
- Parse errors → graceful fallback to text chunker, no crash

**Dependencies:** tree-sitter WASM only.

---

### Milestone 6 — Source Connectors + File Watcher (~600 LOC)

**Modules:** `git-worktree.ts`, `git-history.ts`, `doc-fetcher.ts`, `watcher.ts`

**What it does:**
- Git worktree detector: run `git rev-parse --git-common-dir`, `git worktree list`,
  return `WorktreeInfo` with repoId, isLinked, branch, siblings
- Tree manifest builder: `git ls-tree -r HEAD` → path→blobHash mapping in SQLite
- Blob-level dedup: only index blobs not already in the base index
- Git history indexer: walk `git log --format` + `git diff`, extract commit messages
  and changed file diffs, output as indexable chunks
- Doc fetcher: fetch URL, extract readable content, chunk into sections
- File watcher: worktree-aware polling watcher on source dirs, debounce, trigger incremental re-index
- Watcher safety: `node_modules`, `.git`, build artifacts always excluded before watcher attaches

**Test assertions:**
- Worktree detector identifies main vs linked worktrees correctly
- All worktrees of same repo share the same `repoId`
- Tree manifest: two worktrees on different branches have different path→blob maps
- Blob dedup: shared blob across branches is indexed once, not twice
- Search from worktree A returns files from branch A, not branch B
- Watcher: write to a file → indexer triggered within debounce window
- Watcher: rapid 10 writes to same file → only 1 re-index (debounce)
- Watcher: `npm install` doesn't crash (node_modules excluded)
- Git history returns commits in reverse chronological order

**Dependencies:** All previous milestones. Full integration.

---

### Milestone 7 — Search Quality (~400 LOC)

**Modules:** `searcher.ts`, `reranker.ts`, IR eval harness

**What it does:**
- Searcher: embed query → LanceDB ANN search (top-50) → rerank → return top-10
- Reranker: score fusion combining vector similarity, recency boost, symbol name
  match (exact/fuzzy), file path relevance
- Worktree-scoped search: resolve tree manifest + overlay, filter to visible chunks
- Result formatting: file path, line range, code snippet, relevance score, symbol info
- IR evaluation harness: golden query set, MRR/NDCG/P@k metrics, regression gate
- Differential testing: compare results against ripgrep to catch false negatives

**Test assertions:**
- Query `'how does authentication work'` on fixture repo → `login.ts` ranks in top 3
- Query `'password hashing'` → `hash.ts` ranks #1
- Worktree search: `'oauth'` from feature worktree → found; from main → not found
- Reranker: recently modified file scores higher than stale file
- Symbol name boost: query `'authenticateUser'` → exact match ranks #1
- Dedup: same function in base + overlay → only overlay version returned
- IR eval: MRR ≥ 0.55, NDCG@10 ≥ 0.45 on golden query set
- Regression gate: PR fails if any metric drops >2% vs baseline

**Dependencies:** Embedding provider + storage layer.

---

### Milestone 8 — Hardening (~500 LOC)

**Modules:** `security.ts`, `code-sandbox.ts` (QuickJS WASM), crash recovery, polish

**What it does:**
- Security layer: path jailing, secret file exclusion, input validation
- Code sandbox: QuickJS WASM runner for isolated TS execution with strict timeout
- Crash recovery: write-log reconciliation, corruption detection, `reindex` command
- Resource throttling: CPU/memory limits, backpressure config
- HTTP transport: Streamable HTTP for remote/shared access
- CLI polish: `context-engine status`, `reindex`, progress bars

**Test assertions:**
- Path jail: tool call with `../../.ssh/id_rsa` → rejected
- Secret exclusion: `.env` files never indexed, never in search results
- Code sandbox: no filesystem access, no network, 5s timeout
- Kill mid-index → restart resumes from write-log, no corrupt vectors
- Corrupted LanceDB → detect on startup, offer rebuild
- Resource throttling: indexing respects maxMemoryMB config
- HTTP transport: POST to server, get MCP responses
- Concurrent MCP clients querying simultaneously → correct results

**Dependencies:** Everything. Final integration / hardening.

### Milestone Status Tracker (living)

| Milestone | Scope | Status | Exit Gate |
|---|---|---|---|
| M1 | Walking skeleton (MCP + stub tools) | ✅ Complete | MCP client can list/call all tools without crashes |
| M2 | LanceDB + SQLite + WAL | ✅ Complete | Crash simulation shows no orphaned vectors |
| M3 | Text chunker + real indexing loop | ✅ Complete | `index .` then `semantic_search` returns real file snippets |
| M4 | ONNX worker embeddings | ✅ Complete | Search latency unaffected while background indexing runs |
| M5 | AST chunker | ✅ Complete | TS/JS/Python symbol extraction passes fixture assertions |
| M6 | Git worktree + watcher + docs + history | ✅ Complete | Branch-aware search correctness proven in tests |
| M7 | Quality + reranker + eval | ✅ Complete | MRR/NDCG baseline + differential checks passing |
| M8 | Security + hardening + HTTP | ✅ Complete | Security checks + HTTP MCP + recovery commands validated |

### Current Implementation Update (2026-03-01)

- M1 delivered and tested.
- M2 delivered with startup reconciliation + consistency checks:
  - `src/storage/vector-store.ts` (LanceDB)
  - `src/storage/metadata-store.ts` (SQLite)
  - `src/storage/write-log.ts` + `src/storage/schemas.ts`
  - `src/storage/consistency-checker.ts`
- M3 delivered with real local indexing pipeline:
  - `src/chunker/text-chunker.ts`
  - `src/sources/local-fs.ts`
  - `src/engine/context-engine.ts` (scan → chunk → embed(onnx-by-default, mock fallback) → LanceDB/SQLite)
- M4 completed:
  - `src/embeddings/worker-provider.ts` + `src/embeddings/worker-thread.ts`
  - `src/embeddings/local-onnx.ts` (worker ONNX runtime)
  - `src/embeddings/vertex.ts` + `src/embeddings/factory.ts` (`local` | `vertex`)
  - priority queue + indexing backpressure implemented
  - Vertex retry/token-refresh handling implemented + tested
  - provider-switch tests added (local mock/onnx fallback + vertex)
  - default rollout policy documented: `localBackend = onnx` with `fallbackToMock = true`
- M5 completed:
  - `src/chunker/ast-chunker.ts` (TS/JS + Python symbol chunk extraction)
  - `src/chunker/tree-sitter-loader.ts` (tree-sitter WASM loader/registry)
  - `src/chunker/chunker.ts` (AST-first, text fallback router)
  - snapshot regression tests added for AST chunk outputs
  - engine indexing now promotes symbol metadata from AST chunks
- M6 completed:
  - `src/sources/git-worktree.ts` (worktree detection + HEAD tree manifest parsing)
  - engine indexing/search is now worktree-aware via manifest + dirty overlay visibility resolution
  - blob-level dedup across sibling worktrees implemented (shared blobs indexed once)
  - scanner now uses git-compatible blob hashing and excludes `.git` + secret files
  - worktree-aware polling watcher integrated (`src/engine/watcher.ts`) with debounce + safety ignores
  - git history connector integrated (`src/sources/git-history.ts` + `ContextEngine.getRecentChanges`)
  - docs connector integrated (`src/sources/doc-fetcher.ts` + indexed documentation chunks)
  - branch-isolation + dedup + watcher + history + docs tests added
- M7 completed:
  - reranker integrated (`src/engine/reranker.ts`) with vector/symbol/path/recency fusion
  - golden query set + IR metrics harness added (`tests/eval/golden-queries.json`, `tests/harness/ir-metrics.ts`)
  - eval runner + differential semantic-vs-ripgrep checks added
- M8 completed:
  - path jail + secret denylist integrated (`src/storage/security.ts`, scanner + file tools)
  - `execute` tool added with QuickJS WASM execution + timeout guard
  - Streamable HTTP transport implemented (`src/server/transports.ts`) with HTTP E2E coverage
  - recovery/repair CLI commands added (`reindex`, `doctor --fix`)
- Test suite status: `bun test` green (89 passing).
- Next focus: release readiness (benchmark depth + CI quality gates).

### Go / No-Go Gates

A milestone is only considered complete when **all** of these are true:

1. **Feature gate**: all "What it does" bullets implemented.
2. **Test gate**: all listed assertions are automated and passing.
3. **Stability gate**: no flaky tests in that milestone's suite over 3 consecutive runs.
4. **Docs gate**: architecture + README updated for behavior changes.
5. **Performance gate** (where applicable): benchmark targets not regressed >10%.

### Immediate Execution Plan (next 3 work sessions)

#### Session 1 — CI quality gates
- Wire eval metrics thresholds into CI with baseline comparison artifact
- Add automated fail-on-regression for MRR/NDCG drops

#### Session 2 — benchmark gating
- Track indexing/search benchmark trends over time
- Add memory usage budget checks for ONNX + watcher scenarios in CI

#### Session 3 — release packaging
- Add release checklist + versioned changelog automation
- Validate STDIO/HTTP interoperability against multiple MCP clients

### Risk Register (active)

| Risk | Impact | Mitigation | Trigger |
|---|---|---|---|
| Worktree mapping regresses to path-level | Wrong cross-branch results | Keep tree-manifest tests mandatory in M6 | Any failing branch-isolation test |
| LanceDB+SQLite write divergence | Corrupt retrieval set | WAL + startup reconciliation + periodic consistency check | Orphan vector/chunk mismatch |
| ONNX worker stalls or leaks memory | Server latency / OOM | Backpressure + `maxMemoryMB` + worker health pings | p99 search latency spike |
| Watcher event storms (`node_modules`, lockfiles) | CPU spikes / reindex loops | Hardcoded ignore list + debounce + max queue size | >N reindexes/minute |
| Overgrown test suite slows PRs | Dev friction | Keep fast tiers on PR; run eval/bench nightly | PR runtime > 10 minutes |
| Sandbox escape or path traversal | Data exfiltration risk | Path jail + strict allow-list + sandbox isolation tests | Security test failure |

---

## Test Harness

### Design Principles

1. **Fast by default**: Unit tests use mocks/stubs, run in <5s total
2. **Real deps opt-in**: Integration tests use real LanceDB/SQLite/tree-sitter,
   tagged so they can run separately
3. **Deterministic embeddings**: A mock provider that returns predictable vectors
   enables testing search/ranking logic without ONNX model download
4. **Fixture-driven**: A single realistic test repo used across all milestones
5. **Snapshot-stable**: Chunker output captured as snapshots for regression detection
6. **Measure quality, not just correctness**: IR metrics (MRR, NDCG) track search
   quality as a continuous signal, not a binary pass/fail
7. **Mocks are trustworthy**: Contract tests guarantee mocks behave identically to real
   implementations

> **What we cut (and why):** Mutation testing (Stryker), chaos/fault injection,
> and property-based testing (fast-check) were dropped from the initial plan.
> They are valuable for mature projects but provide poor ROI before the system
> has real users. The chaos scenarios (corrupt DB files, symlink loops, etc.) test
> failure modes of LanceDB and SQLite — trust the database to handle its own
> corruption. These tiers can be added later if specific failure modes emerge.

### Test Directory Structure

```
tests/
├── unit/                         # Fast, no external deps (< 5s)
│   ├── text-chunker.test.ts
│   ├── ast-chunker.test.ts
│   ├── config.test.ts
│   ├── reranker.test.ts
│   ├── security.test.ts
│   └── ...
│
├── integration/                  # Real deps, disk I/O (< 30s)
│   ├── vector-store.test.ts
│   ├── metadata-store.test.ts
│   ├── embedding.test.ts
│   ├── indexer.test.ts
│   ├── searcher.test.ts
│   └── worktree.test.ts
│
├── e2e/                          # Full MCP roundtrips (< 2 min)
│   ├── mcp-stdio.test.ts
│   ├── mcp-http.test.ts
│   └── cli.test.ts
│
├── contract/                     # Mock ↔ real parity (< 10s)
│   ├── vector-store.contract.ts  # Same suite runs against Mock + LanceDB
│   ├── metadata-store.contract.ts
│   └── embedder.contract.ts
│
├── eval/                         # IR quality evaluation (< 5 min)
│   ├── golden-queries.json       # 50-100 queries with relevance judgments
│   ├── eval-runner.ts            # Computes MRR, NDCG@10, P@5, R@10
│   ├── eval-report.ts            # Generates quality dashboard
│   └── differential.test.ts      # Compare semantic search vs ripgrep
│
├── regression/                   # Bug reproduction archive (never delete)
│   ├── README.md
│   └── *.test.ts
│
├── benchmarks/                   # Performance tracking (separate CI job)
│   ├── indexing-speed.bench.ts
│   ├── search-latency.bench.ts
│   └── memory-usage.bench.ts
│
├── fixtures/                     # Shared test data
│   ├── sample-repo/              # Built by fixture-builder (not committed)
│   ├── snapshots/                # Chunker output snapshots
│   ├── vectors/                  # Pre-computed embedding fixtures
│   └── golden/                   # Golden query set + relevance labels
│
└── harness/                      # Test infrastructure
    ├── fixture-builder.ts         # Programmatic repo + worktree creation
    ├── mock-embedder.ts           # Deterministic embedding provider
    ├── mock-storage.ts            # In-memory vector + metadata stores
    ├── mcp-test-client.ts         # MCP client for E2E tests
    ├── temp-dir.ts                # Temp directory lifecycle
    ├── assertions.ts              # Custom matchers
    ├── ir-metrics.ts              # MRR, NDCG, P@k, R@k computation
    └── contract-runner.ts         # Runs interface suites against implementations
```

---

### Test Fixture: `sample-repo`

A small but realistic git repo created programmatically by `fixture-builder.ts`.
This is NOT committed to the repo — it's built fresh in CI and locally via a setup
script. This avoids fixture rot and makes the test setup self-documenting.

```
sample-repo/
├── .git/                          # Real git history (10+ commits)
├── src/
│   ├── auth/
│   │   ├── login.ts               # authenticateUser(), validateCredentials()
│   │   ├── session.ts             # class SessionManager, createSession(), destroySession()
│   │   ├── types.ts               # interface User, interface Session, type AuthToken
│   │   └── middleware.ts          # requireAuth() — imports from session.ts + types.ts
│   ├── api/
│   │   ├── routes.ts              # registerRoutes() — imports from auth/
│   │   ├── handlers.ts            # handleLogin(), handleLogout()
│   │   └── validation.ts          # validateRequest(), sanitizeInput()
│   ├── db/
│   │   ├── connection.ts          # class DatabasePool
│   │   ├── users.ts               # findUserByEmail(), createUser()
│   │   └── migrations.ts          # runMigrations()
│   └── utils/
│       ├── hash.ts                # hashPassword(), verifyPassword()
│       ├── logger.ts              # class Logger, log(), error()
│       └── config.py              # Python file (tests sliding window fallback)
├── docs/
│   ├── README.md                  # Project overview documentation
│   └── auth-flow.md               # Auth architecture doc
├── package.json
└── tsconfig.json
```

**Git history** (created by fixture-builder):
- Commit 1: Initial project structure
- Commit 2: Add auth module
- Commit 3: Add API routes
- Commit 4: Add database layer
- Commit 5: Add password hashing
- Commit 6: Refactor session management
- Commit 7-10: Various changes for history depth

**Worktree** (created by fixture-builder):
- `sample-repo-worktree/` — linked worktree on branch `feature/oauth`
  - New file: `src/auth/oauth.ts` (OAuth2 provider integration)
  - Modified file: `src/auth/types.ts` (adds `OAuthToken` type)

---

### Harness Components

#### `fixture-builder.ts` — Programmatic Test Repo Creation

Creates the sample repo and worktree from scratch every time. This ensures tests
don't depend on committed fixtures that can rot.

```typescript
FixtureBuilder.create(tempDir)
  .addFile('src/auth/login.ts', LOGIN_SOURCE)
  .addFile('src/auth/session.ts', SESSION_SOURCE)
  .commit('Initial auth module')
  .addFile('src/api/routes.ts', ROUTES_SOURCE)
  .commit('Add API routes')
  .addWorktree('feature/oauth', '../sample-repo-worktree')
  .inWorktree((wt) => {
    wt.addFile('src/auth/oauth.ts', OAUTH_SOURCE);
    wt.modifyFile('src/auth/types.ts', TYPES_V2_SOURCE);
  })
  .build();  // → returns { repoDir, worktreeDir, repoId }
```

#### `mock-embedder.ts` — Deterministic Embedding Provider

A fake embedding provider that returns predictable vectors without downloading
any model. Uses a simple hash-based approach so that:
- Same input → same vector (deterministic)
- Similar strings → somewhat similar vectors (via shared token overlap)
- Different strings → different vectors

This lets us test search ranking, reranking, deduplication, and worktree overlay
merging without waiting for ONNX model downloads.

```typescript
const embedder = new MockEmbedder({ dimensions: 128 });
const v1 = await embedder.embed(['authentication login']);
const v2 = await embedder.embed(['user auth']);
// cosine(v1, v2) ≈ 0.6-0.8 (similar tokens → partial vector overlap)
```

Also useful for benchmarks — isolates storage/search perf from embedding perf.

#### `mock-storage.ts` — In-Memory Storage Backends

In-memory implementations of `VectorStore` and `MetadataStore` interfaces.
Same API as real LanceDB/SQLite wrappers but backed by arrays and Maps.

Use for:
- Unit tests where storage is a dependency but not the thing being tested
- Fast test runs (no disk I/O, no temp dir cleanup)
- Testing the indexer and searcher logic in isolation

#### `mcp-test-client.ts` — MCP Client for E2E Tests

Wraps the MCP client SDK to make E2E tests concise:

```typescript
const client = await McpTestClient.spawn('./context-engine serve');
const result = await client.callTool('semantic_search', { query: 'auth' });
expect(result.content[0].text).toContain('authenticateUser');
await client.close();
```

Supports both STDIO (spawn subprocess) and HTTP (connect to port) transports.

#### `temp-dir.ts` — Temp Directory Lifecycle

Every test that touches disk gets an isolated temp directory:

```typescript
const tmp = await TempDir.create('test-vector-store');
// ... test ...
await tmp.cleanup(); // removes everything
```

Automatically cleans up on test completion (including on failure).
Integrates with test framework's `afterEach` / `afterAll` hooks.

#### `assertions.ts` — Custom Test Matchers

Domain-specific assertions for readability:

```typescript
// Vector assertions
expect(vectorA).toBeCosineSimilarTo(vectorB, { threshold: 0.7 });
expect(vectorA).toBeCosineDissimilarTo(vectorC, { threshold: 0.3 });

// Chunk assertions
expect(chunk).toHaveSymbol('authenticateUser', 'function');
expect(chunk).toSpanLines(15, 42);
expect(chunks).toCoverFile('src/auth/login.ts'); // no gaps in line coverage

// Search result assertions
expect(results).toRankFirst('src/auth/login.ts');
expect(results).toContainFile('src/auth/session.ts');
expect(results).not.toContainFile('src/utils/config.py');

// Worktree assertions
expect(worktreeInfo).toBeLinkedWorktree();
expect(worktreeInfo).toShareRepoWith(mainWorktreeInfo);

// IR metric assertions
expect(evalRun).toHaveMRR({ min: 0.65 });
expect(evalRun).toHaveNDCG(10, { min: 0.55 });
expect(evalRun).not.toRegress(baselineRun, { maxDrop: 0.02 });

// Idempotency assertions
expect(stateAfterFirstIndex).toDeepEqual(stateAfterSecondIndex);

// Recovery assertions
expect(indexAfterCrashRecovery).toBeConsistent();
expect(indexAfterCrashRecovery).toHaveNoOrphanedVectors();
```

---

### Test Execution Tiers

```bash
# Unit tests (< 5s, no external deps)
bun test tests/unit/

# Integration (< 30s, real LanceDB/SQLite/tree-sitter/git)
bun test tests/integration/

# E2E (< 2 min, spawns MCP server)
bun test tests/e2e/

# Contract (< 10s, mock ↔ real parity)
bun test tests/contract/

# IR evaluation (< 5 min, quality metrics)
bun test tests/eval/

# Benchmarks (separate, track regressions)
bun test tests/benchmarks/ --bench

# Regression archive (< 30s, never delete these)
bun test tests/regression/

# All tiers
bun test
```

### CI Pipeline

```yaml
# Every push / PR
test:
  strategy:
    matrix:
      tier: [unit, integration, e2e, contract, regression]
  steps:
    - bun install
    - bun run build:fixtures
    - bun test tests/${{ matrix.tier }}/

# PRs only — quality gate
quality:
  steps:
    - bun install
    - bun run build:fixtures
    - bun test tests/eval/
    - bash: |
        # Fail if MRR drops > 2% vs main
        bun run tests/eval/eval-runner.ts --compare=main --max-drop=0.02

# Nightly — benchmarks
nightly:
  schedule: '0 2 * * *'
  steps:
    - bun test tests/benchmarks/ --bench
```

### Benchmark Tracking

| Benchmark | Metric | Target |
|-----------|--------|--------|
| Index 1K files | Wall time | < 30s |
| Index 1K files | Peak memory | < 200MB |
| Incremental re-index (1 file changed) | Wall time | < 500ms |
| Semantic search (10K chunks indexed) | p50 latency | < 100ms |
| Semantic search (10K chunks indexed) | p99 latency | < 500ms |
| Embedding batch (32 chunks) | Wall time | < 2s |

### Quality Metrics

| Metric | Minimum | Target | Stretch |
|--------|---------|--------|---------|
| MRR | 0.55 | 0.70 | 0.80 |
| NDCG@10 | 0.45 | 0.60 | 0.75 |
| P@5 | 0.50 | 0.65 | 0.80 |
| R@10 | 0.60 | 0.75 | 0.90 |
| Differential (vs ripgrep) false negatives | < 15% | < 8% | < 3% |

---

## Appendix: Decisions Log

Changes incorporated from oracle review (Gemini 3.1 Pro, 2026-03-01):

1. **LevelDB → SQLite (`bun:sqlite`)**: Relational metadata (worktree→path→blob
   mappings, symbol lookups) is painful in a KV store. SQLite is native to Bun,
   handles concurrent reads, and makes joins trivial.

2. **Worktree base index: blob-level, not path-level**: The original design mapped
   `repo:file:<path> → blobHash` globally. Two worktrees on different branches would
   overwrite each other's mappings. Fixed: base index stores blobs by `blobHash`
   (content-addressable). Each worktree resolves its own `HEAD` tree via
   `git ls-tree -r HEAD` to know which blobs are visible.

3. **Write-ahead log for dual-write consistency**: LanceDB + SQLite are two separate
   stores. Without a WAL, a crash between the two writes creates orphaned vectors.
   Fixed: intent recorded in SQLite `write_log` table before writing, reconciled
   on startup.

4. **Embedding worker thread**: ONNX inference blocks the event loop (200-500ms per
   batch). MCP transport becomes unresponsive during indexing. Fixed: embedding runs
   in a Worker thread with priority queue (search jumps ahead of index batches).

5. **Security layer**: Path jailing, secret file exclusion, code sandbox isolation
   (QuickJS WASM). Without this, a prompt-injected agent could read `.env` or
   `~/.ssh/id_rsa`.

6. **Resource throttling**: CPU niceness, memory budget, concurrency limits. Prevents
   indexing from pegging the user's machine.

7. **Walking skeleton build order**: Original plan was bottom-up (types → chunker →
   storage → ... → MCP server last). Changed to vertical slices: M1 delivers a
   working MCP server with dummy backends on Day 1, then real implementations are
   swapped in one at a time.

8. **Test harness trimmed**: Dropped mutation testing (Stryker), chaos/fault injection,
   property-based testing (fast-check), scaling harness, backward compat tests, and
   test isolation verification. Kept: unit, integration, e2e, contract, IR eval,
   regression archive, benchmarks. The dropped tiers can be added when specific
   failure modes emerge from real usage.
