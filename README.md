# Context Engine MCP

Local-first MCP server for code indexing and semantic search.

## Current Status

- ✅ M1 Walking skeleton (MCP server + tools)
- ✅ M2 Storage layer (LanceDB + SQLite + WAL + consistency checks)
- ✅ M3 Text indexing pipeline (scanner + chunker + incremental indexing)
- ✅ M4 embedding worker runtime complete (priority + backpressure + local/vertex providers)
- ✅ M5 AST chunking baseline complete (tree-sitter loader + snapshots)
- ✅ M6 source connector/worktree correctness complete (git worktree + dedup + watcher + git history + docs)
- ✅ M7 search quality/eval complete (reranker + golden queries + IR metrics + differential checks)
- ✅ M8 hardening complete (path jail + secret denylist + HTTP transport + QuickJS sandbox + recovery commands)
- ✅ All planned milestones implemented

## Quick Start

```bash
bun install

# Index source code (uses context-engine.json if present)
bun run mcp:index

# Start MCP server (STDIO or HTTP via config)
bun run mcp

# Check status
bun run mcp:status

# Validate storage consistency
bun run mcp:doctor

# Fast MCP preflight (connect + listTools + status + semantic_search)
bun run mcp:probe

# Full rebuild if needed
bun run src/cli.ts reindex
```

`bun run mcp` (`serve`) now performs an initial index and (by default) starts the worktree-aware watcher.
Pass a custom config/path with `bun run mcp -- ./path/to/context-engine.json`.
`get_recent_changes` now returns real git commit/file history for indexed git roots.
`search_docs` now returns real matches from configured documentation sources.
`code_sandbox` runs TypeScript snippets in QuickJS WASM isolation with timeout protection.
HTTP MCP transport is supported via `server.transport = "http"`.

## Config

Create `context-engine.json`:

```json
{
  "sources": [{ "path": "./src" }],
  "dataDir": "./.context-engine",
  "embedding": {
    "provider": "local",
    "localBackend": "mock",
    "model": "nomic-embed-text-v1.5",
    "dimensions": 768,
    "fallbackToMock": true
  },
  "server": { "transport": "stdio", "host": "127.0.0.1", "port": 3777 },
  "watcher": {
    "enabled": true,
    "debounceMs": 250,
    "pollIntervalMs": 750
  },
  "gitHistory": {
    "enabled": true,
    "maxCommits": 1000
  },
  "docs": [
    { "url": "https://example.com/docs/getting-started" }
  ]
}
```

Supported embedding providers are **only**:
- `local`
- `vertex`

Default rollout policy:
- `embedding.provider = "local"`
- `embedding.localBackend = "mock"` (safe default)
- ONNX is opt-in via `localBackend: "onnx"`

Local backend modes:
- `mock` (fast, deterministic, default)
- `onnx` (real local embeddings via `@huggingface/transformers`)

Local ONNX example:

```json
{
  "embedding": {
    "provider": "local",
    "localBackend": "onnx",
    "model": "Xenova/all-MiniLM-L6-v2",
    "dimensions": 384,
    "cacheDir": "./.context-engine/models",
    "fallbackToMock": true
  }
}
```

Notes for ONNX mode:
- Uses `@huggingface/transformers` in the worker thread.
- If optional native dependencies are blocked by Bun, run `bun pm untrusted` and approve required installs.
- With `fallbackToMock: true`, startup will fall back to mock embeddings if ONNX init fails.

Vertex example:

```json
{
  "embedding": {
    "provider": "vertex",
    "projectId": "my-gcp-project",
    "location": "us-central1",
    "model": "text-embedding-005",
    "dimensions": 768,
    "requestTimeoutMs": 30000,
    "maxRetries": 2,
    "retryBaseDelayMs": 250
  }
}
```

Vertex auth:
- Set `VERTEX_ACCESS_TOKEN`, or
- Run `gcloud auth application-default login` and the provider will use ADC token via gcloud.

## Test

```bash
bun test
bun run test:unit
bun run test:integration
bun run test:e2e
bun run test:quality
```

All test scripts run with engine debug logging enabled and write JSONL logs to:

- `.context-engine/test-logs/unit.log`
- `.context-engine/test-logs/integration.log`
- `.context-engine/test-logs/e2e.log`
- `.context-engine/test-logs/eval.log`
- `.context-engine/test-logs/bench.log`
- `.context-engine/test-logs/contract.log`
- `.context-engine/test-logs/regression.log`

Runtime logging controls:

- `CE_LOG_LEVEL=debug|info|warn|error`
- `CE_LOG_FILE=/path/to/log.jsonl`
- `CE_LOG_STDERR=0` to disable stderr log output

MCP stuck-debug workflow (recommended before external-agent runs):

```bash
# quick, bounded probe with timing per step + engine log tail on failure
bun run mcp:probe

# probe with your real config
bun run mcp:probe -- --config ./context-engine.json --step-timeout-ms 8000
```

## Key Files

- `src/engine/context-engine.ts` — indexing/search orchestration
- `src/engine/reranker.ts` — score fusion reranker
- `src/engine/watcher.ts` — worktree-aware polling watcher + debounce
- `src/storage/vector-store.ts` — LanceDB wrapper
- `src/storage/metadata-store.ts` — SQLite metadata wrapper
- `src/storage/write-log.ts` — dual-write WAL
- `src/storage/security.ts` — path jail + secret denylist helpers
- `src/chunker/text-chunker.ts` — sliding window chunker
- `src/chunker/ast-chunker.ts` — AST-aware symbol chunking (TS/JS/Python)
- `src/chunker/tree-sitter-loader.ts` — tree-sitter WASM grammar loader
- `src/chunker/chunker.ts` — hybrid AST/text chunker router
- `src/sources/local-fs.ts` — local filesystem scanner
- `src/sources/git-worktree.ts` — git worktree detection + HEAD manifest parsing
- `src/sources/git-history.ts` — git log connector used by `get_recent_changes`
- `src/sources/doc-fetcher.ts` — docs fetch + extraction used by `search_docs`
- `src/server/transports.ts` — STDIO + Streamable HTTP transports
- `src/server/tools/code-sandbox.ts` — isolated TypeScript sandbox runner

See `ARCHITECTURE.md` and `IMPLEMENTATION_PLAN.md` for detailed design + milestone tracking.

## License

GNU General Public License v3.0 only (`GPL-3.0`). See `LICENSE`.
