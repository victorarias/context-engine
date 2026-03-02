<p align="center">
  <h1 align="center">⚡ Context Engine</h1>
  <p align="center">
    <strong>Local-first code intelligence for AI agents</strong>
  </p>
  <p align="center">
    An open-source MCP server that indexes your codebase and gives any AI agent semantic search, symbol lookup, dependency analysis, and more — all running on your machine.
  </p>
  <p align="center">
    <a href="#quick-start">Quick Start</a> ·
    <a href="#connect-to-your-agent">Connect to Your Agent</a> ·
    <a href="#tools">Tools</a> ·
    <a href="#configuration">Configuration</a>
  </p>
</p>

> [!WARNING]
> **Work in progress.** Context Engine is under active development. Inspired by [Augment Code](https://www.augmentcode.com/)'s context engine approach, this project aims to bring that level of codebase understanding to any MCP-compatible agent. Expect rough edges, breaking changes, and missing features. Contributions and feedback are very welcome!

---

## What is this?

Most AI coding agents are limited to what fits in their context window. They grep, they read files one by one, and they lose track of the big picture. Context Engine fixes that.

It **indexes your entire codebase** — code, symbols, git history, even documentation URLs — into a local vector database, then exposes powerful search and code intelligence tools over the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/). Any MCP-compatible agent (Claude, Cursor, Zed, Pi, etc.) can connect and instantly understand your project.

**Key ideas:**

- 🏠 **Local-first** — Everything runs on your machine. No code leaves your laptop.
- ⚡ **Incremental** — Only re-indexes what changed. File watcher keeps things fresh automatically.
- 🧠 **Semantic search** — Find code by *intent*, not just string matching. "how auth tokens are refreshed" → relevant code.
- 🌳 **AST-aware chunking** — Understands code structure (functions, classes, interfaces) for 6 languages.
- 🔗 **Code intelligence** — Dependency graphs, reverse imports, symbol references — beyond just search.
- 🔌 **Universal** — Works with any MCP client. One index, many agents.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) (v1.0+)

### Install & run

```bash
git clone https://github.com/victorarias/context-engine.git
cd context-engine
bun install
```

Index your project and start the server:

```bash
# Index a codebase
bun run src/cli.ts index /path/to/your/project

# Start the MCP server (indexes on startup + watches for changes)
bun run src/cli.ts serve
```

That's it. The server is now running on STDIO, ready for an agent to connect.

### Useful commands

```bash
bun run src/cli.ts serve     # Start MCP server (STDIO or HTTP)
bun run src/cli.ts index .   # Index current directory
bun run src/cli.ts status    # Check index status
bun run src/cli.ts reindex   # Full rebuild
bun run src/cli.ts doctor    # Validate storage consistency
```

---

## Connect to Your Agent

Context Engine speaks MCP, so it plugs into any agent that supports MCP servers. Here's how to set it up for the most popular ones:

### Claude Code (Claude CLI)

Add to your `~/.claude/claude_desktop_config.json` (or project-level `.mcp.json`):

```json
{
  "mcpServers": {
    "context-engine": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/context-engine/src/cli.ts", "serve"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

Or create a `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "context-engine": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/context-engine/src/cli.ts", "serve"]
    }
  }
}
```

### Cursor

Go to **Settings → MCP Servers → Add Server** and configure:

```json
{
  "mcpServers": {
    "context-engine": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/context-engine/src/cli.ts", "serve"]
    }
  }
}
```

### Zed

Add to your Zed settings (`~/.config/zed/settings.json`):

```json
{
  "context_servers": {
    "context-engine": {
      "command": {
        "path": "bun",
        "args": ["run", "/absolute/path/to/context-engine/src/cli.ts", "serve"]
      }
    }
  }
}
```

### HTTP Mode (Any Client)

If your agent supports HTTP-based MCP, you can run Context Engine as an HTTP server:

Create a `context-engine.json` in your project root:

```json
{
  "sources": [{ "path": "./src" }],
  "server": {
    "transport": "http",
    "host": "127.0.0.1",
    "port": 3777
  }
}
```

Then start the server:

```bash
bun run src/cli.ts serve ./context-engine.json
```

The MCP endpoint will be available at `http://127.0.0.1:3777`.

### Generic MCP Client

Context Engine works with **any MCP-compatible client**. The server communicates via STDIO by default (or Streamable HTTP). Just point your client at:

```bash
bun run /path/to/context-engine/src/cli.ts serve
```

---

## Tools

Once connected, your agent gets access to these tools:

| Tool | What it does |
|------|-------------|
| **`semantic_search`** | Natural-language search over your codebase. Find code by intent, not keywords. |
| **`find_files`** | Find files by glob or substring, scoped to the index. |
| **`get_symbols`** | Look up function/class/type definitions by name, kind, or file. |
| **`get_file_summary`** | Quick structural overview of a file (chunks, symbols) without reading it. |
| **`get_recent_changes`** | Summarize recent git commits and changed files, optionally filtered by topic. |
| **`get_dependencies`** | Extract import dependencies for a file or directory (TS/JS/Go/Python/Rust/Kotlin). |
| **`find_importers`** | Reverse dependency lookup — which files import a given target. |
| **`find_references`** | Find symbol usages/call-sites (Go via gopls, TS/JS via compiler API). |
| **`execute`** | Batch multiple queries in one round trip via a TypeScript call plan. |
| **`status`** | Engine health, indexing state, coverage stats, and capability flags. |

---

## Configuration

Create a `context-engine.json` in your project root to customize behavior:

```json
{
  "sources": [
    { "path": "./src" },
    { "path": "../shared-lib", "include": ["**/*.ts"] }
  ],
  "embedding": {
    "provider": "local",
    "localBackend": "onnx",
    "model": "Xenova/all-MiniLM-L6-v2",
    "dimensions": 384,
    "fallbackToMock": true
  },
  "server": {
    "transport": "stdio"
  },
  "watcher": {
    "enabled": true,
    "debounceMs": 250
  },
  "gitHistory": {
    "enabled": true,
    "maxCommits": 1000
  },
  "docs": [
    { "url": "https://docs.example.com/api" }
  ]
}
```

### Embedding Providers

**Local ONNX (default)** — Runs entirely on your machine using `@huggingface/transformers`. No API keys needed.

```json
{
  "embedding": {
    "provider": "local",
    "localBackend": "onnx",
    "model": "Xenova/all-MiniLM-L6-v2",
    "dimensions": 384,
    "fallbackToMock": true
  }
}
```

**Vertex AI** — Use Google Cloud embeddings for higher quality at the cost of network calls.

```json
{
  "embedding": {
    "provider": "vertex",
    "projectId": "my-gcp-project",
    "location": "us-central1",
    "model": "text-embedding-005",
    "dimensions": 768
  }
}
```

Vertex auth: set `VERTEX_ACCESS_TOKEN`, or `GOOGLE_APPLICATION_CREDENTIALS`, or use `gcloud auth application-default login`.

### Storage

By default, index data lives in `~/.context-engine/<repo-hash>/` — no `.context-engine` folder cluttering your repo. You can override this with `"dataDir": "./my-index"` in the config.

### Supported Languages (AST Chunking)

Context Engine uses tree-sitter for structure-aware code chunking:

- TypeScript / JavaScript
- Python
- Go
- Rust
- Kotlin

Other file types fall back to a sliding-window text chunker.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    MCP Clients                               │
│  Claude  ·  Cursor  ·  Zed  ·  Pi  ·  Any MCP Agent        │
└──────────┬──────────────────────────────────────┬────────────┘
           │ STDIO                                │ HTTP
┌──────────▼──────────────────────────────────────▼────────────┐
│                   MCP Transport Layer                         │
├──────────────────────────────────────────────────────────────┤
│                    Security Layer                             │
│        Path jail · Secret exclusion · Input validation        │
├──────────────────────────────────────────────────────────────┤
│                      Tool Router                              │
│  semantic_search · find_files · get_symbols · get_dependencies│
│  find_importers · find_references · execute · status · ...    │
├──────────────────────────────────────────────────────────────┤
│                     Query Engine                              │
│        Query → Vector Search (LanceDB) → Reranker             │
├──────────────────────────────────────────────────────────────┤
│                   Indexing Pipeline                           │
│    Source Scanner → AST/Text Chunker → Embedding Worker →     │
│    Storage (LanceDB vectors + SQLite metadata)                │
├──────────────────────────────────────────────────────────────┤
│               Source Connectors & Watcher                     │
│    Local FS · Git Repos · Git History · Doc URLs              │
└──────────────────────────────────────────────────────────────┘
```

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full design document.

---

## Development

```bash
# Run all tests
bun test

# Individual test suites
bun run test:unit
bun run test:integration
bun run test:e2e
bun run test:quality        # eval + benchmarks + contract + regression

# MCP preflight check (useful before connecting agents)
bun run src/dev/mcp-probe.ts

# Embedding model comparison
bun run src/dev/embedding-bakeoff.ts -- \
  --repo ~/projects/myapp \
  --queries eval/exsin-queries.json \
  --candidates eval/embedding-candidates.json
```

### Environment Variables

| Variable | Description |
|----------|------------|
| `CE_LOG_LEVEL` | `debug` / `info` / `warn` / `error` |
| `CE_LOG_FILE` | Path to JSONL log file |
| `CE_LOG_STDERR` | Set to `0` to disable stderr logging |

---

## Roadmap

This is a work in progress. Some things on the radar:

- [ ] npm package for easier installation (`npx context-engine serve`)
- [ ] More languages for AST chunking (Java, C#, Ruby, ...)
- [ ] Smarter reranking (cross-encoder, LLM-based)
- [ ] Multi-repo support
- [ ] Project-level summaries and architecture maps
- [ ] Pre-built binaries (no Bun dependency)

Have ideas? Open an issue!

---

## License

[GPL-3.0](./LICENSE)
