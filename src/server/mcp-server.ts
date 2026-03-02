import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Engine } from "../engine/engine.js";
import { runCodeSandbox } from "./tools/code-sandbox.js";
import { logError, logEvent } from "../observability/logger.js";

function summarizeArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object") return {};

  const input = args as Record<string, unknown>;
  const summary: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      summary[key] = value.length > 120 ? `${value.slice(0, 120)}…` : value;
      continue;
    }

    if (Array.isArray(value)) {
      summary[key] = `array(${value.length})`;
      continue;
    }

    if (value && typeof value === "object") {
      summary[key] = "object";
      continue;
    }

    summary[key] = value;
  }

  return summary;
}

async function withToolLogging<T>(toolName: string, args: unknown, fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  logEvent("debug", "mcp.tool.start", {
    toolName,
    args: summarizeArgs(args),
  });

  try {
    const result = await fn();
    logEvent("debug", "mcp.tool.complete", {
      toolName,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    logError("mcp.tool.failed", error, {
      toolName,
      args: summarizeArgs(args),
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}

const SCRIPTABLE_TOOL_NAMES = [
  "semantic_search",
  "find_files",
  "get_symbols",
  "get_file_summary",
  "get_recent_changes",
  "get_dependencies",
  "find_references",
  "status",
] as const;

type ScriptableToolName = (typeof SCRIPTABLE_TOOL_NAMES)[number];

type ScriptedToolCall = {
  tool: ScriptableToolName;
  args: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isScriptableToolName(value: string): value is ScriptableToolName {
  return (SCRIPTABLE_TOOL_NAMES as readonly string[]).includes(value);
}

function parseScriptedCalls(raw: unknown, maxCalls: number): ScriptedToolCall[] {
  const parsedMaxCalls = Number.isFinite(maxCalls) ? Math.max(1, Math.floor(maxCalls)) : 8;
  const source = Array.isArray(raw)
    ? raw
    : (isRecord(raw) && Array.isArray(raw.calls) ? raw.calls : null);

  if (!source) {
    throw new Error(
      "execute output must be an array of tool calls or { calls: [...] }. " +
      "Example: output = [{ tool: 'find_files', args: { pattern: '*.ts' } }];",
    );
  }

  if (source.length === 0) {
    throw new Error("execute output.calls must contain at least 1 tool call.");
  }

  if (source.length > parsedMaxCalls) {
    throw new Error(`execute output has ${source.length} calls, exceeding maxCalls=${parsedMaxCalls}.`);
  }

  const calls: ScriptedToolCall[] = [];

  for (let i = 0; i < source.length; i++) {
    const entry = source[i];
    if (!isRecord(entry)) {
      throw new Error(`Call #${i + 1} must be an object.`);
    }

    const tool = entry.tool;
    if (typeof tool !== "string" || !isScriptableToolName(tool)) {
      throw new Error(
        `Call #${i + 1} has unsupported tool '${String(tool)}'. ` +
        `Allowed tools: ${SCRIPTABLE_TOOL_NAMES.join(", ")}.`,
      );
    }

    const args = isRecord(entry.args) ? entry.args : {};
    calls.push({ tool, args });
  }

  return calls;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) {
    return value;
  }

  throw new Error(`Missing required string field '${field}'.`);
}

function formatSearchResults(results: Awaited<ReturnType<Engine["search"]>>): string {
  if (results.length === 0) {
    return "No results found.";
  }

  return results
    .map((r, i) => {
      const header = `### ${i + 1}. ${r.filePath}:${r.startLine}-${r.endLine}` +
        (r.symbolName ? ` (${r.symbolKind}: ${r.symbolName})` : "") +
        ` [score: ${r.score.toFixed(3)}]`;
      return `${header}\n\`\`\`${r.language}\n${r.content}\n\`\`\``;
    })
    .join("\n\n");
}

function formatStatus(status: Awaited<ReturnType<Engine["status"]>>): string {
  const lines = [
    `Indexing: ${status.indexing ? "in progress" : "idle"}`,
    `Embedding model: ${status.embeddingModel}`,
    `Worker: ${status.workerBusy ? "busy" : "idle"}`,
    `Repos: ${status.repos.length === 0 ? "(none indexed)" : ""}`,
  ];

  for (const repo of status.repos) {
    lines.push(`  ${repo.path} — ${repo.filesIndexed} files, ${repo.chunksStored} chunks`);
  }

  if (status.languageFileCounts && Object.keys(status.languageFileCounts).length > 0) {
    const summary = Object.entries(status.languageFileCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([lang, count]) => `${lang}:${count}`)
      .join(", ");
    lines.push(`Indexed languages: ${summary}`);
  }

  if (status.capabilities) {
    const caps: string[] = [];
    if (status.capabilities.goReferencesBinary) {
      caps.push(`goReferencesBinary=${status.capabilities.goReferencesBinary}`);
    }
    if (status.capabilities.goReferencesSelection) {
      caps.push(`goReferencesSelection=${status.capabilities.goReferencesSelection}`);
    }
    if (status.capabilities.goDependencies) {
      caps.push(`goDependencies=${status.capabilities.goDependencies}`);
    }
    if (caps.length > 0) {
      lines.push(`Capabilities: ${caps.join(", ")}`);
    }
  }

  return lines.join("\n");
}

async function executeScriptedCall(engine: Engine, call: ScriptedToolCall): Promise<string> {
  switch (call.tool) {
    case "semantic_search": {
      const query = requiredString(call.args.query, "query");
      const limit = optionalNumber(call.args.limit);
      const worktreeId = optionalString(call.args.worktreeId);
      const results = await engine.search(query, { limit, worktreeId });
      return formatSearchResults(results);
    }

    case "find_files": {
      const pattern = requiredString(call.args.pattern, "pattern");
      const worktreeId = optionalString(call.args.worktreeId);
      const files = await engine.findFiles(pattern, { worktreeId });
      return files.length === 0 ? "No files found." : files.join("\n");
    }

    case "get_symbols": {
      const symbols = await engine.getSymbols({
        name: optionalString(call.args.name),
        filePath: optionalString(call.args.filePath),
        kind: optionalString(call.args.kind),
      });

      if (symbols.length === 0) {
        return "No symbols found.";
      }

      return symbols
        .map((s) => `${s.kind} ${s.name} — ${s.filePath}:${s.startLine}-${s.endLine}`)
        .join("\n");
    }

    case "get_file_summary": {
      const path = requiredString(call.args.path, "path");
      return engine.getFileSummary(path);
    }

    case "get_recent_changes": {
      const query = optionalString(call.args.query);
      return engine.getRecentChanges(query);
    }

    case "get_dependencies": {
      const path = requiredString(call.args.path, "path");
      return engine.getDependencies(path, {
        recursive: call.args.recursive === true,
        maxFiles: optionalNumber(call.args.maxFiles),
      });
    }

    case "find_references": {
      const symbol = requiredString(call.args.symbol, "symbol");
      return engine.findReferences(symbol, {
        filePath: optionalString(call.args.filePath),
        includeDeclaration: call.args.includeDeclaration === true,
        limit: optionalNumber(call.args.limit),
      });
    }

    case "status": {
      const status = await engine.status();
      return formatStatus(status);
    }
  }
}

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

  logEvent("info", "mcp.server.created", {
    name: "context-engine",
    version: "0.1.0",
  });

  // ─── semantic_search ──────────────────────────────────────────────

  server.registerTool("semantic_search", {
    description:
      "What: Natural-language concept search over indexed chunks (symbol-sized chunks for AST languages, " +
      "~80-line windows with overlap otherwise). " +
      "Use when: you know behavior/intent but not exact identifiers. " +
      "Prefer over: grep for exploratory discovery. " +
      "Not for: exact literal matches or usage counting.",
    inputSchema: {
      query: z.string().describe("Natural language query (e.g. 'how auth tokens are refreshed')"),
      limit: z.number().optional().default(10).describe("Max results to return"),
      worktreeId: z.string().optional().describe("Scope search to a specific worktree"),
    },
  }, async (args) => withToolLogging("semantic_search", args, async () => {
    const results = await engine.search(args.query, {
      limit: args.limit,
      worktreeId: args.worktreeId,
    });

    return { content: [{ type: "text", text: formatSearchResults(results) }] };
  }));

  // ─── find_files ───────────────────────────────────────────────────

  server.registerTool("find_files", {
    description:
      "What: Find files from the current index (configured source roots + visible worktree overlay), " +
      "by glob or substring. " +
      "Use when: you want index-scoped discovery consistent with other context-engine tools. " +
      "Prefer over: filesystem glob when index scope matters. " +
      "Not for: searching file contents (or discovering files not yet indexed).",
    inputSchema: {
      pattern: z.string().describe("Glob pattern or file name substring (e.g. '*.ts', 'auth')"),
      worktreeId: z.string().optional().describe("Scope to a specific worktree"),
    },
  }, async (args) => withToolLogging("find_files", args, async () => {
    const files = await engine.findFiles(args.pattern, {
      worktreeId: args.worktreeId,
    });

    if (files.length === 0) {
      return { content: [{ type: "text", text: "No files found." }] };
    }

    return { content: [{ type: "text", text: files.join("\n") }] };
  }));

  // ─── get_symbols ──────────────────────────────────────────────────

  server.registerTool("get_symbols", {
    description:
      "What: Lookup symbol definitions (function/class/interface/type) by name, kind, or file. " +
      "Use when: you need definition locations quickly. " +
      "Prefer over: grep for definition lookups. " +
      "Not for: finding all usages/call-sites.",
    inputSchema: {
      name: z.string().optional().describe("Symbol name (partial match)"),
      filePath: z.string().optional().describe("File path to list symbols from"),
      kind: z.string().optional().describe("Symbol kind: function, class, interface, type, etc."),
    },
  }, async (args) => withToolLogging("get_symbols", args, async () => {
    const symbols = await engine.getSymbols(args);

    if (symbols.length === 0) {
      return { content: [{ type: "text", text: "No symbols found." }] };
    }

    const text = symbols
      .map((s) => `${s.kind} ${s.name} — ${s.filePath}:${s.startLine}-${s.endLine}`)
      .join("\n");

    return { content: [{ type: "text", text }] };
  }));

  // ─── get_file_summary ─────────────────────────────────────────────

  server.registerTool("get_file_summary", {
    description:
      "What: Fast structural summary of an indexed file (chunk count + symbol count + up to 8 symbol entries). " +
      "Use when: triaging large/unfamiliar files. " +
      "Prefer over: opening full source immediately. " +
      "Not for: line-level logic review.",
    inputSchema: {
      path: z.string().describe("File path to summarize"),
    },
  }, async (args) => withToolLogging("get_file_summary", args, async () => {
    const summary = await engine.getFileSummary(args.path);
    return { content: [{ type: "text", text: summary }] };
  }));

  // ─── get_recent_changes ───────────────────────────────────────────

  server.registerTool("get_recent_changes", {
    description:
      "What: Summarize recent commits and touched files across indexed git roots (optionally filtered). " +
      "Use when: you need quick historical context around a feature/topic. " +
      "Prefer over: raw git log for fast orientation. " +
      "Not for: exact patch/blame-level inspection.",
    inputSchema: {
      query: z.string().optional().describe("Filter changes related to this topic"),
    },
  }, async (args) => withToolLogging("get_recent_changes", args, async () => {
    const changes = await engine.getRecentChanges(args.query);
    return { content: [{ type: "text", text: changes }] };
  }));

  // ─── get_dependencies ─────────────────────────────────────────────

  server.registerTool("get_dependencies", {
    description:
      "What: Extract direct import dependencies for a file (or for all files in a directory). " +
      "Supports Go import blocks + TS/JS/Python/Rust/Kotlin import patterns. " +
      "Use when: scoping refactor impact quickly. " +
      "Prefer over: manual import scanning. " +
      "Not for: reverse dependency or full transitive graph analysis.",
    inputSchema: {
      path: z.string().describe("File path or directory path to analyze"),
      recursive: z.boolean().optional().default(false).describe("When path is a directory: include nested files recursively."),
      maxFiles: z.number().optional().default(50).describe("When path is a directory: maximum files to scan."),
    },
  }, async (args) => withToolLogging("get_dependencies", args, async () => {
    const deps = await engine.getDependencies(args.path, {
      recursive: args.recursive,
      maxFiles: args.maxFiles,
    });
    return { content: [{ type: "text", text: deps }] };
  }));

  // ─── find_references ─────────────────────────────────────────────

  server.registerTool("find_references", {
    description:
      "What: Find symbol usages/call-sites. " +
      "Use when: assessing refactor impact or tracing where an API is used. " +
      "Prefer over: grep for semantics-aware Go references (uses gopls when target is resolvable). " +
      "Not for: declaration lookup (use get_symbols). Pass `filePath` for ambiguous/common symbols.",
    inputSchema: {
      symbol: z.string().describe("Symbol name to find references for (e.g. 'Start', 'NewClient')"),
      filePath: z.string().optional().describe("Optional file path containing the declaration (improves precision)."),
      includeDeclaration: z.boolean().optional().default(false).describe("Include declaration location when backend supports it."),
      limit: z.number().optional().default(50).describe("Maximum references to return."),
    },
  }, async (args) => withToolLogging("find_references", args, async () => {
    const text = await engine.findReferences(args.symbol, {
      filePath: args.filePath,
      includeDeclaration: args.includeDeclaration,
      limit: args.limit,
    });
    return { content: [{ type: "text", text }] };
  }));

  // ─── execute ─────────────────────────────────────────────────────

  server.registerTool("execute", {
    description:
      "What: Run multiple context-engine queries in one round trip using a TypeScript call plan. " +
      "Use when: a task needs batched/fan-out lookups or repeatable analysis workflows. " +
      "Prefer over: many sequential tool calls. " +
      "Not for: arbitrary host scripting or side effects (no filesystem/network/process access).",
    inputSchema: {
      code: z.string().describe(
        "TypeScript plan builder. Assign `output` to an array or { calls: [...] } where each call is { tool, args }. " +
        "Example: output = [{ tool: 'find_files', args: { pattern: '*.ts' } }, { tool: 'find_references', args: { symbol: 'Start' } }]. " +
        "Allowed tools: semantic_search, find_files, get_symbols, get_file_summary, get_recent_changes, get_dependencies, find_references, status.",
      ),
      input: z.unknown().optional().describe("Read-only input object available as `input` in sandbox."),
      timeoutMs: z.number().optional().default(5000).describe("Sandbox execution timeout in milliseconds."),
      maxCalls: z.number().optional().default(8).describe("Max number of scripted tool calls to execute."),
    },
  }, async (args) => withToolLogging("execute", args, async () => {
    try {
      const scriptOutput = await runCodeSandbox(args.code, {
        input: args.input,
        timeoutMs: args.timeoutMs,
      });

      const calls = parseScriptedCalls(scriptOutput, args.maxCalls);
      const results: Array<{
        index: number;
        tool: ScriptableToolName;
        args: Record<string, unknown>;
        text: string;
      }> = [];

      for (let i = 0; i < calls.length; i++) {
        const call = calls[i];
        const text = await executeScriptedCall(engine, call);
        results.push({
          index: i + 1,
          tool: call.tool,
          args: call.args,
          text,
        });
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ok: true, callsExecuted: results.length, results }, null, 2),
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
  }));

  // ─── status ───────────────────────────────────────────────────────

  server.registerTool("status", {
    description:
      "What: Engine readiness + coverage snapshot (indexing state, worker activity, model warnings, repo stats, indexed language counts, capability flags). " +
      "Use when: results look stale/empty, boundaries are unclear, or output is surprising. " +
      "Prefer over: guessing engine freshness/support. " +
      "Not for: code discovery.",
  }, async () => withToolLogging("status", {}, async () => {
    const s = await engine.status();
    return { content: [{ type: "text", text: formatStatus(s) }] };
  }));

  return server;
}
