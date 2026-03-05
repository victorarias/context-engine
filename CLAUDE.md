# Context Engine

Local-first code intelligence MCP server. Indexes source code into LanceDB vectors + SQLite metadata, serves semantic search, dependency graphs, symbol lookup, and reference finding via MCP tools.

## Quick Reference

```bash
bun test                    # Run all tests (unit + integration + e2e)
bun test tests/unit/        # Unit tests only
bun test tests/e2e/         # E2E tests only
bun run mcp                 # Start MCP server (stdio)
bun run src/cli.ts serve    # Same as above
bun run src/cli.ts index .  # Index current directory
bun run src/cli.ts doctor   # Check index consistency
```

## Architecture

### Three-phase indexing

1. **Scan + embed (parent process):** Walk files, chunk, embed via ONNX worker thread. Accumulate `ChunkRow[]` in memory. SQLite metadata writes happen inline.
2. **Vector write (subprocess or direct):** If ≥100 rows, spawn `lance-write-worker.ts` subprocess to write vectors to LanceDB — the subprocess exits after writing, freeing the Rust allocator's native memory. For <100 rows (e.g., watcher re-index), write directly in-process.
3. **Cleanup (parent):** Process deferred blob deletes via a fresh LanceDB connection with small cache.

### Storage layer

- **LanceDB** (`src/storage/vector-store.ts`) — Vector storage with Session cache caps (64 MB index + 32 MB metadata). The Rust allocator (jemalloc) never returns virtual pages to the OS, so the subprocess isolation is critical for keeping parent RSS low.
- **SQLite** (`src/storage/metadata-store.ts`) — File hashes, blob→chunk mappings, tree entries, dirty files, symbols.
- **WriteAheadLog** (`src/storage/write-log.ts`) — Dual-write coordination between LanceDB and SQLite. For subprocess writes, the order is: `markSqliteOk` → subprocess writes vectors → `markLanceOk`. Crash recovery handles the reversed order.

### Embedding

- Default: ONNX via lazy worker thread (`src/embeddings/worker-provider.ts`) with idle timeout — worker terminates after 60s of inactivity to release ONNX model memory (~100-150 MB).
- Fallback: mock embeddings (deterministic hash-based vectors for testing).

### MCP Tools

`semantic_search`, `find_files`, `get_symbols`, `get_file_summary`, `get_recent_changes`, `get_dependencies`, `find_importers`, `find_references`, `execute`, `status`

The `status` tool includes process diagnostics (PID, uptime, memory breakdown) for troubleshooting.

## Memory

LanceDB's Rust allocator retains native memory indefinitely. Key mitigations:

- **Subprocess vector writes** — Bulk writes happen in a child process that exits after indexing
- **Session cache caps** — 64 MB index + 32 MB metadata (LanceDB defaults are 6 GB + 1 GB)
- **Lazy ONNX worker** — Spawns on first embed, terminates after idle timeout
- **Optimize with close/reopen** — After compaction, close the connection to hint the allocator

### Profiling

```bash
# Memory profiler (compares baseline → index → search → close)
CE_LOG_LEVEL=warn bun run src/dev/memory-profile.ts /path/to/repo

# MCP tool smoke test (starts HTTP server, exercises all tools, monitors memory)
CE_LOG_LEVEL=error bun run src/dev/tool-smoke-test.ts /path/to/repo --port=3999

# macOS process memory (footprint is what Activity Monitor shows)
footprint <pid>
```

## Testing

- Test behavior, not implementation
- Don't test what's verified at compile time
- Mock stores (`tests/harness/mocks.ts`) implement the same interfaces as real stores
- The subprocess write path is only triggered for ≥100 accumulated rows, so integration tests (small fixtures) exercise the direct write path

## Project Structure

```
src/
  cli.ts                          # CLI entry point (serve, index, doctor, status)
  config.ts                       # Zod-based config with defaults
  types.ts                        # Core interfaces (Chunk, VectorStore, MetadataStore, etc.)
  engine/
    context-engine.ts             # Main engine — indexing, search, deps, refs
    lance-write-worker.ts         # Subprocess for LanceDB vector writes
    watcher.ts                    # File system polling watcher
    ts-dependency-service.ts      # TypeScript import graph
    py-dependency-service.ts      # Python import graph
    reranker.ts                   # Search result reranking
  storage/
    vector-store.ts               # LanceDB wrapper (ChunkRow, bufferAdd, optimize)
    metadata-store.ts             # SQLite wrapper
    write-log.ts                  # WAL for dual-write safety
    consistency-checker.ts        # Cross-store consistency checks
  embeddings/
    worker-provider.ts            # Lazy worker thread with priority queue
    local-onnx.ts                 # ONNX Runtime embedding (q8, constrained threads)
  server/
    mcp-server.ts                 # MCP tool registration and formatting
    transports.ts                 # STDIO and HTTP transport setup
  sources/
    local-fs.ts                   # File scanner with ignore list
    git-worktree.ts               # Git manifest and dirty file detection
  dev/
    memory-profile.ts             # Memory profiling script
    tool-smoke-test.ts            # MCP tool smoke test
```
