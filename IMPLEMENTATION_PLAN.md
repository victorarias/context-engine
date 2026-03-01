# Context Engine MCP — Implementation Plan

Last updated: 2026-03-01 (all milestones implemented)

This plan operationalizes `ARCHITECTURE.md` into execution-ready work.

## Progress Snapshot

- **M1 (Walking Skeleton): ✅ Complete**
  - MCP server + STDIO transport live
  - 9 tools registered and callable (including `code_sandbox`)
  - CLI commands (`serve`, `index`, `status`) implemented
  - E2E MCP tests passing
- **M2 (Storage): ✅ Complete**
  - LanceDB vector store implemented
  - SQLite metadata store + migrations implemented
  - Write-ahead log helper implemented
  - Cross-store consistency checker implemented (`missingVectors` / `orphanVectors` report)
  - Startup WAL reconciliation integrated and tested in `ContextEngine.create()`
- **M3 (Text Chunker + Indexing): ✅ Complete**
  - Sliding-window text chunker implemented
  - Local recursive scanner implemented
  - Incremental hash-based reindex implemented
  - Real indexing pipeline wired (scan → chunk → embed(worker local backend) → storage)
  - Delete handling implemented
- **M4 (Embedding Worker): ✅ Complete**
  - Worker-thread embedding runtime + IPC implemented
  - Priority queue + indexing backpressure implemented
  - Engine now uses provider factory (`local` | `vertex`)
  - Vertex provider implemented with retry/token-refresh logic (`src/embeddings/vertex.ts`)
  - Local ONNX embedder implemented in worker (`src/embeddings/local-onnx.ts`)
  - Provider-switch tests added (local mock/onnx fallback + vertex unit tests)
  - Default rollout policy documented: `localBackend = onnx` with `fallbackToMock = true`
- **M5 (AST Chunker): ✅ Complete**
  - `src/chunker/ast-chunker.ts` added (TS/JS + Python symbol extraction)
  - tree-sitter WASM loader/registry integrated (`src/chunker/tree-sitter-loader.ts`)
  - `src/chunker/chunker.ts` hybrid router added (AST-first, text fallback)
  - Engine indexing now promotes symbol metadata from AST chunks
  - Snapshot regression tests added for AST chunk outputs
- **M6 (Source connectors + worktree correctness): ✅ Complete**
  - Git worktree detection implemented (`src/sources/git-worktree.ts`)
  - HEAD tree manifest parsing implemented (`git ls-tree -r HEAD`)
  - Branch-isolation integration test added (`tests/integration/git-worktree.test.ts`)
  - Blob-level dedup across sibling worktrees implemented (shared blob reused once)
  - Search visibility now resolves by worktree manifest + dirty overlay (overlay wins)
  - Worktree-aware polling watcher integrated with debounce + safety ignores (`src/engine/watcher.ts`)
  - Git history connector implemented (`src/sources/git-history.ts` + `get_recent_changes`)
  - Docs connector implemented (`src/sources/doc-fetcher.ts` + real `search_docs`)
- **M7 (Search quality + eval): ✅ Complete**
  - Reranker integrated (`src/engine/reranker.ts`) with score fusion (vector + symbol/path + recency)
  - Golden query set added (`tests/eval/golden-queries.json`)
  - Eval runner + IR metrics added (`tests/eval/eval-runner.test.ts`, `tests/harness/ir-metrics.ts`)
  - Differential semantic-vs-ripgrep checks added (`tests/eval/differential.test.ts`)
- **M8 (Hardening + security): ✅ Complete**
  - Path jail + secret denylist implemented (`src/storage/security.ts`, scanner + file tools integrated)
  - Streamable HTTP transport implemented (`src/server/transports.ts`, `tests/e2e/mcp-http.test.ts`)
  - Code sandbox tool added (`code_sandbox`, QuickJS WASM isolated execution)
  - Recovery commands added (`reindex`, `doctor --fix`) and status output polished

Validation status (latest):
- `bun test` ✅ (89 passing)
- `bun run test:integration` ✅
- `bun run test:e2e` ✅

## 1) Critical Path

1. **M1** walking skeleton (MCP connectivity)
2. **M2** storage core (LanceDB + SQLite + WAL)
3. **M3** first real indexing (text chunking + scanner)
4. **M4** real embeddings in worker thread
5. **M6** worktree manifest + overlay correctness *(highest correctness risk)*
6. **M7** quality gates (IR eval)
7. **M8** security/hardening before release

> M5 (AST chunker) can proceed after M4, but should not block worktree correctness.

---

## 2) Milestone Checklist

## M1 — Walking Skeleton ✅

### Tasks
- [x] Create server bootstrap + STDIO transport
- [x] Register tool set with schemas + handlers (now 9 tools including `code_sandbox`)
- [x] Add config loader with defaults/validation
- [x] Add stub engine interface used by all tools
- [x] Add CLI commands: `serve`, `index`, `status`
- [x] Add E2E MCP test for tool listing + basic calls

### Exit Criteria
- [x] MCP client can connect and successfully call all tools
- [x] Invalid args return descriptive tool errors (no process crash)
- [x] `bun test tests/e2e/mcp-stdio.test.ts` passes

### Commit
`feat(m1): walking skeleton server with stub tools`

---

## M2 — Real Storage (LanceDB + SQLite + WAL) ✅

### Tasks
- [x] Implement `VectorStore` (LanceDB wrapper)
- [x] Implement `MetadataStore` (SQLite wrapper)
- [x] Add schema migrations (`blobs`, `tree_entries`, `dirty_files`, `symbols`, `index_state`, `write_log`)
- [x] Implement WAL helper: `beginIntent`, `markLanceOk`, `markSqliteOk`, `finalize`, `reconcile`
- [x] Add consistency checker (vector rows ↔ metadata references)

### Exit Criteria
- [x] Crash simulation during dual-write leaves no permanent inconsistencies
- [x] Startup reconciliation resolves incomplete WAL entries in the full pipeline
- [x] Integration tests pass for storage modules on clean startup (`metadata`, `vector`, `write-log`)

### Commit
`feat(m2): lancedb/sqlite storage with wal reconciliation`

---

## M3 — Text Chunker + Real Indexing ✅

### Tasks
- [x] Implement sliding-window chunker with overlap + line tracking
- [x] Implement recursive local scanner + include/exclude globs
- [x] Add incremental content hashing (skip unchanged files)
- [x] Wire indexer pipeline: scan → chunk → embed(worker local backend) → write storage
- [x] Add delete handling (remove vectors/chunks for deleted files)

### Exit Criteria
- [x] `context-engine index .` produces stored chunks
- [x] Reindex after single-file edit only updates changed file chunks
- [x] Search returns real snippets (not placeholders)

### Commit
`feat(m3): text chunking and incremental indexing pipeline`

---

## M4 — Embedding Worker ✅

### Tasks
- [x] Add worker-thread embed runtime + IPC
- [x] Implement priority queue (search > index)
- [x] Add backpressure (max in-flight indexing batches)
- [x] Implement local ONNX provider in worker (`@huggingface/transformers`)
- [x] Add provider abstraction for local/vertex parity

### Exit Criteria
- [x] Search requests remain responsive during indexing
- [x] Worker health status exposed via `status`
- [x] Embedding consistency tests pass (shape + similarity sanity)

### Commit
`feat(m4): worker-based embedding pipeline with priority scheduling`

---

## M5 — AST Chunker ✅

### Tasks
- [x] Add tree-sitter WASM loader + language registry (full target)
- [x] Implement TS/JS/Python extraction of symbols + boundaries (baseline)
- [x] Add fallback to text chunker on unsupported language or parse error
- [x] Add snapshot tests for chunk structure

### Exit Criteria
- [x] Symbol extraction tests pass for fixture repo
- [x] Parse failures degrade gracefully (no indexing crash)

### Commit
`feat(m5): ast-aware chunking with fallback`

---

## M6 — Source Connectors + Worktree Correctness ✅

### Tasks
- [x] Implement git worktree detection
- [x] Implement per-worktree HEAD tree manifest (`git ls-tree -r HEAD`)
- [x] Implement blob dedup across branches
- [x] Implement dirty-file overlay indexing
- [x] Add watcher with debounce + ignore safety defaults
- [x] Add git history connector
- [x] Add docs ingestion connector

### Exit Criteria
- [x] Same-path different-branch file content stays isolated by worktree
- [x] Shared blobs indexed once across branches
- [x] Watcher remains stable under rapid filesystem churn

### Commit
`feat(m6): worktree-aware indexing and source connectors`

---

## M7 — Search Quality + Eval ✅

### Tasks
- [x] Implement reranker (similarity + recency + symbol/path boosts)
- [x] Implement worktree-aware filtering for visible chunks only
- [x] Build golden query set + relevance labels
- [x] Add eval runner + baseline comparison gate
- [x] Add differential test vs ripgrep

### Exit Criteria
- [x] MRR/NDCG meet minimum thresholds
- [x] Differential quality checks in place for regression detection

### Commit
`feat(m7): reranking and ir quality evaluation gates`

---

## M8 — Hardening + Security ✅

### Tasks
- [x] Implement path jail enforcement in all path-taking tools
- [x] Add hard secret-file denylist enforcement
- [x] Implement isolated sandbox runner with strict timeout (`code_sandbox` QuickJS WASM)
- [x] Add crash recovery command + corruption detection/rebuild flow (`reindex`, `doctor --fix`)
- [x] Add Streamable HTTP transport
- [x] Add status/progress polish

### Exit Criteria
- [x] Security tests pass (path traversal + secret exposure protections)
- [x] Crash/restart scenarios maintain index consistency (WAL + doctor/reindex flow)
- [x] HTTP transport interoperates with MCP clients

### Commit
`feat(m8): security hardening, recovery, and http transport`

---

## 3) CI Rollout Plan

### Phase A (immediately)
- PR checks: `unit`, `integration`, `e2e`, `contract`, `regression`

### Phase B (after M7)
- Add quality gate job (`tests/eval/`) with baseline diff check

### Phase C (after M8)
- Add nightly benchmarks

---

## 4) Definition of Done (global)

A milestone is done only if:
1. Feature scope implemented.
2. Test assertions automated and passing.
3. No flaky tests in 3 consecutive local runs.
4. Docs updated (`ARCHITECTURE.md` + module README/comments).
5. No untriaged TODOs in production paths.

---

## 5) Next Action (recommended now)

All planned milestones are implemented.
Next recommended step: wire CI release gates (eval regression thresholds + benchmark jobs) and package a release.
