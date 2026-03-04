/**
 * Smoke test: starts context-engine against a real repo, exercises all MCP tools,
 * and monitors memory throughout. Tests Go, TypeScript, and Python support.
 *
 * Usage: bun run src/dev/tool-smoke-test.ts <repo-path> [--port=3999]
 */

import { ContextEngine } from "../engine/context-engine.js";
import { createMcpServer } from "../server/mcp-server.js";
import { attachHttp } from "../server/transports.js";
import { loadConfig } from "../config.js";
import { resolve } from "node:path";

const targetDir = process.argv[2];
if (!targetDir) {
  console.error("Usage: tool-smoke-test <repo-path>");
  process.exit(1);
}

const portFlag = process.argv.find((a) => a.startsWith("--port="));
const port = portFlag ? Number(portFlag.split("=")[1]) : 3999;
const absTarget = resolve(targetDir);

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function snap(label: string): { rss: number; native: number } {
  if (typeof Bun !== "undefined") Bun.gc(true);
  const mem = process.memoryUsage();
  const native = mem.rss - mem.heapUsed - mem.external;
  console.log(
    `  [MEM] ${label.padEnd(40)} rss=${mb(mem.rss).padStart(9)} native≈${mb(native).padStart(9)}`,
  );
  return { rss: mem.rss, native };
}

// ─── MCP JSON-RPC helpers ────────────────────────────────────────────

let requestId = 1;

const MCP_HEADERS = {
  "Content-Type": "application/json",
  "Accept": "application/json, text/event-stream",
};

async function mcpInitialize(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: requestId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "smoke-test", version: "1.0" },
      },
    }),
  });
  const sessionId = res.headers.get("mcp-session-id") ?? "";
  // Consume body (may be SSE or JSON)
  await res.text();
  return sessionId;
}

async function callTool(
  baseUrl: string,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: unknown; isError?: boolean }> {
  const id = requestId++;
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      ...MCP_HEADERS,
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });

  const contentType = res.headers.get("content-type") ?? "";

  // SSE response — parse events to find our JSON-RPC result
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        const event = JSON.parse(line.slice(6));
        if (event.id === id) {
          if (event.error) return { content: event.error, isError: true };
          return event.result ?? { content: null };
        }
      } catch { /* skip non-JSON lines */ }
    }
    return { content: "no matching response in SSE stream", isError: true };
  }

  // Plain JSON response
  const json = (await res.json()) as any;
  if (json.error) {
    return { content: json.error, isError: true };
  }
  return json.result ?? { content: null };
}

function extractText(result: { content: unknown }): string {
  if (Array.isArray(result.content)) {
    return result.content.map((c: any) => c.text ?? "").join("\n");
  }
  return JSON.stringify(result.content);
}

// ─── Test suite ──────────────────────────────────────────────────────

interface TestResult {
  tool: string;
  description: string;
  ok: boolean;
  detail: string;
  durationMs: number;
}

async function runTests(baseUrl: string, sessionId: string, lang: string): Promise<TestResult[]> {
  const results: TestResult[] = [];

  async function test(
    tool: string,
    description: string,
    args: Record<string, unknown>,
    validate: (text: string, raw: any) => string | null,
  ) {
    const start = Date.now();
    try {
      const result = await callTool(baseUrl, sessionId, tool, args);
      const durationMs = Date.now() - start;
      const text = extractText(result);

      if (result.isError) {
        results.push({ tool, description, ok: false, detail: `Error: ${text}`, durationMs });
        return;
      }

      const error = validate(text, result);
      results.push({
        tool,
        description,
        ok: !error,
        detail: error ?? `OK (${text.length} chars)`,
        durationMs,
      });
    } catch (err: any) {
      results.push({
        tool,
        description,
        ok: false,
        detail: `Exception: ${err.message}`,
        durationMs: Date.now() - start,
      });
    }
  }

  // ── status ──
  await test("status", "engine status", {}, (text) => {
    if (!text.includes("Indexing")) return "missing Indexing field";
    return null;
  });

  // ── semantic_search ──
  const searchQueries: Record<string, string> = {
    go: "handler",
    typescript: "component",
    python: "recognition",
  };
  await test("semantic_search", `search for "${searchQueries[lang] ?? "function"}"`, {
    query: searchQueries[lang] ?? "function",
    limit: 5,
  }, (text) => {
    if (text.length < 20) return "results too short";
    return null;
  });

  // ── find_files ──
  const filePatterns: Record<string, string> = {
    go: "*.go",
    typescript: "*.tsx",
    python: "*.py",
  };
  await test("find_files", `find ${filePatterns[lang]} files`, {
    pattern: filePatterns[lang] ?? "*",
    limit: 10,
  }, (text) => {
    if (!text || text.length < 5) return "no files found";
    return null;
  });

  // ── get_symbols ──
  await test("get_symbols", "list symbols", {
    limit: 10,
  }, (text) => {
    if (text.length < 10) return "no symbols found";
    return null;
  });

  // ── get_file_summary ──
  const summaryFiles: Record<string, string> = {
    go: "main.go",
    typescript: "src/app.tsx",
    python: "src/main.py",
  };
  // Find a real file first
  const findResult = await callTool(baseUrl, sessionId, "find_files", {
    pattern: filePatterns[lang] ?? "*",
    limit: 1,
  });
  const findText = extractText(findResult);
  const firstFile = findText.split("\n").find((l) => l.trim().length > 0)?.trim();

  if (firstFile) {
    // extract just the file path (may have other text around it)
    const pathMatch = firstFile.match(/[\w/._-]+\.\w+/);
    if (pathMatch) {
      await test("get_file_summary", `summary of ${pathMatch[0]}`, {
        path: pathMatch[0],
      }, (text) => {
        if (text.length < 10) return "summary too short";
        return null;
      });
    }
  }

  // ── get_dependencies ──
  if (firstFile) {
    const pathMatch = firstFile.match(/[\w/._-]+\.\w+/);
    if (pathMatch) {
      await test("get_dependencies", `deps of ${pathMatch[0]}`, {
        path: pathMatch[0],
      }, (text) => {
        return null;
      });
    }
  }

  // ── find_importers ──
  if (firstFile) {
    const pathMatch = firstFile.match(/[\w/._-]+\.\w+/);
    if (pathMatch) {
      await test("find_importers", `importers of ${pathMatch[0]}`, {
        target: pathMatch[0],
      }, (text) => {
        return null;
      });
    }
  }

  // ── find_references ──
  const refSymbols: Record<string, string> = {
    go: "Handler",
    typescript: "App",
    python: "recognize",
  };
  await test("find_references", `references to "${refSymbols[lang]}"`, {
    symbol: refSymbols[lang] ?? "main",
  }, (text) => {
    return null;
  });

  // ── get_recent_changes ──
  await test("get_recent_changes", "recent git changes", {
    limit: 5,
  }, (text) => {
    // May be empty if no recent commits
    return null;
  });

  return results;
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  // Detect language
  const { existsSync } = await import("node:fs");
  let lang = "unknown";
  if (existsSync(resolve(absTarget, "go.mod"))) lang = "go";
  else if (existsSync(resolve(absTarget, "tsconfig.json"))) lang = "typescript";
  else if (existsSync(resolve(absTarget, "package.json"))) lang = "typescript";
  else if (existsSync(resolve(absTarget, "pyproject.toml"))) lang = "python";
  else if (existsSync(resolve(absTarget, "setup.py"))) lang = "python";

  console.log(`\n${"=".repeat(80)}`);
  console.log(`  Smoke test: ${absTarget}`);
  console.log(`  Language: ${lang} | Port: ${port}`);
  console.log(`${"=".repeat(80)}\n`);

  snap("0. baseline");

  const config = loadConfig(absTarget);
  config.server.transport = "http";
  config.server.port = port;
  config.embedding.localBackend = "mock";
  config.watcher.enabled = false;

  const engine = await ContextEngine.create(config);
  snap("1. engine created");

  // Index
  console.log("\n  Indexing...");
  const indexStart = Date.now();
  await engine.index(config.sources.map((s) => s.path));
  const indexMs = Date.now() - indexStart;
  console.log(`  Indexed in ${(indexMs / 1000).toFixed(1)}s`);
  const afterIndex = snap("2. indexed");

  // Start HTTP server
  const server = createMcpServer(engine);
  const { httpServer } = await attachHttp(server, { host: "127.0.0.1", port });
  const baseUrl = `http://127.0.0.1:${port}`;

  // Initialize MCP session
  const sessionId = await mcpInitialize(baseUrl);
  snap("3. MCP server ready");

  // Run tool tests
  console.log("\n  Running tool tests...\n");
  const testResults = await runTests(baseUrl, sessionId, lang);

  // Memory after tools
  const afterTools = snap("4. after all tools");

  // Print results
  console.log(`\n  ${"─".repeat(76)}`);
  console.log(`  ${"Tool".padEnd(22)} ${"Test".padEnd(30)} ${"ms".padStart(6)}  Result`);
  console.log(`  ${"─".repeat(76)}`);

  let passed = 0;
  let failed = 0;
  for (const r of testResults) {
    const icon = r.ok ? "PASS" : "FAIL";
    console.log(
      `  ${r.tool.padEnd(22)} ${r.description.padEnd(30)} ${String(r.durationMs).padStart(6)}  ${icon}  ${r.ok ? "" : r.detail}`,
    );
    if (r.ok) passed++;
    else failed++;
  }

  console.log(`  ${"─".repeat(76)}`);
  console.log(`  ${passed} passed, ${failed} failed\n`);

  // Memory summary
  console.log(`  Memory: rss=${mb(afterTools.rss)} native≈${mb(afterTools.native)} (after tools)`);
  console.log(`          rss=${mb(afterIndex.rss)} native≈${mb(afterIndex.native)} (after index)\n`);

  // Cleanup
  await new Promise<void>((resolveClose) => httpServer.close(() => resolveClose()));
  await engine.close();
  snap("5. closed");

  console.log();

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
