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
    <a href="#connect-to-other-agents">Other Agents</a> ·
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

**1. Install [Bun](https://bun.sh/)** (v1.0+)

**2. Clone and install:**

```bash
git clone https://github.com/victorarias/context-engine.git ~/tools/context-engine
cd ~/tools/context-engine
bun install
```

**3. Add it to your agent:**

```bash
# Add to all your projects (recommended)
claude mcp add -s user context-engine bun run ~/tools/context-engine/src/cli.ts serve

# Or add to just the current project
claude mcp add context-engine bun run ~/tools/context-engine/src/cli.ts serve
```

That's it. Next time Claude starts, Context Engine will index your project and your agent gets semantic search, symbol lookup, dependency analysis, and more.

> Context Engine indexes whichever directory your agent opens (`cwd`). No config file needed — it uses sensible defaults (local ONNX embeddings, file watcher, common directories like `node_modules` excluded).

---

## Connect to Other Agents

The Quick Start above covers Claude Code. Here's how to connect other MCP clients.

### Cursor

Go to **Settings → MCP Servers → Add Server**:

```json
{
  "mcpServers": {
    "context-engine": {
      "command": "bun",
      "args": ["run", "/home/you/tools/context-engine/src/cli.ts", "serve"]
    }
  }
}
```

Cursor sets `cwd` to the open workspace, so Context Engine indexes whatever project you have open.

### Zed

Add to your Zed settings (`~/.config/zed/settings.json`):

```json
{
  "context_servers": {
    "context-engine": {
      "command": {
        "path": "bun",
        "args": ["run", "/home/you/tools/context-engine/src/cli.ts", "serve"]
      }
    }
  }
}
```

### Project-level `.mcp.json`

To share Context Engine config with your team, create a `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "context-engine": {
      "command": "bun",
      "args": ["run", "/home/you/tools/context-engine/src/cli.ts", "serve"]
    }
  }
}
```

Works with Claude Code, Cursor, and other agents that read `.mcp.json`.

### HTTP Mode

For agents that support HTTP-based MCP, create a `context-engine.json` in your project:

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
bun run ~/tools/context-engine/src/cli.ts serve ~/projects/my-app/context-engine.json
```

The MCP endpoint will be available at `http://127.0.0.1:3777`.

### Generic MCP Client

Context Engine works with **any MCP-compatible client**. The server communicates via STDIO by default (or Streamable HTTP). Point your client at:

```bash
bun run /path/to/context-engine/src/cli.ts serve [/path/to/project]
```

---

## Tools

Once connected, your agent gets access to these tools:

| Tool | What it does |
|------|-------------|
| **`semantic_search`** | Natural-language search over your codebase. Find code by intent, not keywords (with optional file/language filters like `*.go` and `codeOnly=true` for code-focused results). |
| **`find_files`** | Find files by glob or substring, scoped to the index. |
| **`get_symbols`** | Look up function/class/type definitions by name, kind, or file. |
| **`get_file_summary`** | Quick structural overview of a file in a stable sectioned format (`[file]`, `[index]`, `[context]`, `[imports]`, `[derived]`, `[symbols]`): line count, language, index state, package/module hint, top-level doc comment, imports, and chunks/symbols from the index — with live-file fallback when stored metadata is missing. |
| **`get_recent_changes`** | Summarize recent git commits and changed files, optionally filtered by topic. |
| **`get_dependencies`** | Extract import dependencies for a file or directory (TS/JS/Go/Python/Rust/Kotlin). |
| **`find_importers`** | Reverse dependency lookup — which files import a given target. |
| **`find_references`** | Find symbol usages/call-sites (Go via gopls, TS/JS via compiler API), with nearby symbol suggestions for stale names and optional call-site context snippets. |
| **`execute`** | Batch multiple queries in one round trip via a TypeScript call plan. |
| **`status`** | Engine health, indexing state, coverage stats, and capability flags. |

> API naming convention: prefer **camelCase** parameters (e.g. `minScore`, `filePattern`, `codeOnly`). Snake_case aliases are kept for backward compatibility.

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

### CLI Commands

Most users don't need these — the MCP server handles indexing automatically. But they're useful for debugging or manual maintenance:

```bash
bun run ~/tools/context-engine/src/cli.ts serve [path]     # Start MCP server (used by agents)
bun run ~/tools/context-engine/src/cli.ts index [path]     # Index without starting server
bun run ~/tools/context-engine/src/cli.ts status [path]    # Check index status
bun run ~/tools/context-engine/src/cli.ts reindex [path]   # Full rebuild
bun run ~/tools/context-engine/src/cli.ts doctor [path]    # Validate storage consistency
```

All commands accept a project path or config file as the last argument.

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
- [ ] Multi-repo support (index multiple repos in a single instance so agents can search across them in one query — useful when your system spans several tightly-coupled repos)
- [ ] Project-level summaries and architecture maps
- [ ] Pre-built binaries (no Bun dependency)

Have ideas? Open an issue!

---

## License

[GPL-3.0](./LICENSE)
