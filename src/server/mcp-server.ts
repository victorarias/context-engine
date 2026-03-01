import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Engine } from "../engine/engine.js";
import { runCodeSandbox } from "./tools/code-sandbox.js";

/**
 * Create and configure the MCP server with all tools wired to the engine.
 */
export function createMcpServer(engine: Engine): McpServer {
  const server = new McpServer(
    {
      name: "context-engine",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // ─── semantic_search ──────────────────────────────────────────────

  server.registerTool("semantic_search", {
    description:
      "Search the codebase using natural language. Returns relevant code snippets " +
      "ranked by semantic similarity. Use this to find code related to a concept, " +
      "feature, or question.",
    inputSchema: {
      query: z.string().describe("Natural language search query"),
      limit: z.number().optional().default(10).describe("Max results to return"),
      worktreeId: z.string().optional().describe("Scope search to a specific worktree"),
    },
  }, async (args) => {
    const results = await engine.search(args.query, {
      limit: args.limit,
      worktreeId: args.worktreeId,
    });

    if (results.length === 0) {
      return { content: [{ type: "text", text: "No results found." }] };
    }

    const text = results
      .map((r, i) => {
        const header = `### ${i + 1}. ${r.filePath}:${r.startLine}-${r.endLine}` +
          (r.symbolName ? ` (${r.symbolKind}: ${r.symbolName})` : "") +
          ` [score: ${r.score.toFixed(3)}]`;
        return `${header}\n\`\`\`${r.language}\n${r.content}\n\`\`\``;
      })
      .join("\n\n");

    return { content: [{ type: "text", text }] };
  });

  // ─── find_files ───────────────────────────────────────────────────

  server.registerTool("find_files", {
    description:
      "Find files matching a glob pattern or name substring. " +
      "Returns file paths. Use this to locate specific files.",
    inputSchema: {
      pattern: z.string().describe("Glob pattern or file name substring (e.g. '*.ts', 'auth')"),
      worktreeId: z.string().optional().describe("Scope to a specific worktree"),
    },
  }, async (args) => {
    const files = await engine.findFiles(args.pattern, {
      worktreeId: args.worktreeId,
    });

    if (files.length === 0) {
      return { content: [{ type: "text", text: "No files found." }] };
    }

    return { content: [{ type: "text", text: files.join("\n") }] };
  });

  // ─── get_symbols ──────────────────────────────────────────────────

  server.registerTool("get_symbols", {
    description:
      "Find symbol definitions (functions, classes, interfaces, types) by name or file. " +
      "Returns symbol locations with line numbers.",
    inputSchema: {
      name: z.string().optional().describe("Symbol name (partial match)"),
      filePath: z.string().optional().describe("File path to list symbols from"),
      kind: z.string().optional().describe("Symbol kind: function, class, interface, type, etc."),
    },
  }, async (args) => {
    const symbols = await engine.getSymbols(args);

    if (symbols.length === 0) {
      return { content: [{ type: "text", text: "No symbols found." }] };
    }

    const text = symbols
      .map((s) => `${s.kind} ${s.name} — ${s.filePath}:${s.startLine}-${s.endLine}`)
      .join("\n");

    return { content: [{ type: "text", text }] };
  });

  // ─── get_file_summary ─────────────────────────────────────────────

  server.registerTool("get_file_summary", {
    description:
      "Get a summary of a file: its exports, key symbols, purpose, and relationships. " +
      "Cheaper than reading the whole file.",
    inputSchema: {
      path: z.string().describe("File path to summarize"),
    },
  }, async (args) => {
    const summary = await engine.getFileSummary(args.path);
    return { content: [{ type: "text", text: summary }] };
  });

  // ─── get_recent_changes ───────────────────────────────────────────

  server.registerTool("get_recent_changes", {
    description:
      "Get recent git changes, optionally filtered by a query. " +
      "Returns commit messages and changed files.",
    inputSchema: {
      query: z.string().optional().describe("Filter changes related to this topic"),
    },
  }, async (args) => {
    const changes = await engine.getRecentChanges(args.query);
    return { content: [{ type: "text", text: changes }] };
  });

  // ─── get_dependencies ─────────────────────────────────────────────

  server.registerTool("get_dependencies", {
    description:
      "Get the import/dependency graph for a file. Shows what it imports and what imports it.",
    inputSchema: {
      path: z.string().describe("File path to analyze dependencies for"),
    },
  }, async (args) => {
    const deps = await engine.getDependencies(args.path);
    return { content: [{ type: "text", text: deps }] };
  });

  // ─── search_docs ──────────────────────────────────────────────────

  server.registerTool("search_docs", {
    description:
      "Search indexed documentation (external URLs configured in context-engine.json). " +
      "Returns relevant doc snippets.",
    inputSchema: {
      query: z.string().describe("Search query for documentation"),
    },
  }, async (args) => {
    const results = await engine.searchDocs(args.query);

    if (results.length === 0) {
      return { content: [{ type: "text", text: "No documentation results found." }] };
    }

    const text = results
      .map((r, i) => `### ${i + 1}. ${r.filePath}\n${r.content}`)
      .join("\n\n");

    return { content: [{ type: "text", text }] };
  });

  // ─── code_sandbox ────────────────────────────────────────────────

  server.registerTool("code_sandbox", {
    description:
      "Run small TypeScript snippets in an isolated VM context with read-only input. " +
      "Set `output` in your code to return data.",
    inputSchema: {
      code: z.string().describe("TypeScript code to execute. Assign final value to `output`."),
      input: z.unknown().optional().describe("Read-only input object available as `input` in sandbox."),
      timeoutMs: z.number().optional().default(5000).describe("Execution timeout in milliseconds."),
    },
  }, async (args) => {
    try {
      const result = await runCodeSandbox(args.code, {
        input: args.input,
        timeoutMs: args.timeoutMs,
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ok: true, result }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2),
        }],
      };
    }
  });

  // ─── status ───────────────────────────────────────────────────────

  server.registerTool("status", {
    description: "Get the current status of the context engine: indexing progress, repos, worker state.",
  }, async () => {
    const s = await engine.status();
    const lines = [
      `Indexing: ${s.indexing ? "in progress" : "idle"}`,
      `Embedding model: ${s.embeddingModel}`,
      `Worker: ${s.workerBusy ? "busy" : "idle"}`,
      `Repos: ${s.repos.length === 0 ? "(none indexed)" : ""}`,
    ];
    for (const r of s.repos) {
      lines.push(`  ${r.path} — ${r.filesIndexed} files, ${r.chunksStored} chunks`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  });

  return server;
}
