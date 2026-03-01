#!/usr/bin/env bun

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const EXPECTED_TOOLS = [
  "semantic_search",
  "find_files",
  "get_symbols",
  "get_file_summary",
  "get_recent_changes",
  "get_dependencies",
  "search_docs",
  "code_sandbox",
  "status",
] as const;

type Args = {
  config?: string;
  timeoutMs: number;
  stepTimeoutMs: number;
  query: string;
  logFile?: string;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = resolve(import.meta.dir, "../..");
  const configPath = args.config ? resolve(args.config) : createFastConfig(projectRoot);
  const logFile = args.logFile ? resolve(args.logFile) : join(tmpdir(), `context-engine-mcp-probe-${Date.now()}.log`);

  if (args.config && !existsSync(configPath)) {
    console.error("MCP probe: FAIL");
    console.error(`config: ${configPath}`);
    console.error(`error: Config file not found`);
    process.exit(1);
  }

  const env = {
    ...process.env,
    CE_LOG_LEVEL: "debug",
    CE_LOG_FILE: logFile,
    CE_LOG_STDERR: "0",
  } satisfies Record<string, string>;

  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", "src/cli.ts", "serve", configPath],
    cwd: projectRoot,
    env,
    stderr: "pipe",
  });

  const client = new Client({ name: "mcp-probe", version: "1.0.0" });
  const startedAt = performance.now();
  const steps: Array<{ name: string; durationMs: number; detail?: string }> = [];
  let connected = false;
  let finalExitCode = 0;

  try {
    await runStep("connect", args.stepTimeoutMs, steps, async () => {
      await client.connect(transport);
      connected = true;
    });

    let listedToolCount = 0;
    const listToolsStep = await runStep("listTools", args.stepTimeoutMs, steps, async () => {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();
      const missing = EXPECTED_TOOLS.filter((tool) => !names.includes(tool));
      if (missing.length > 0) {
        throw new Error(`Missing tools: ${missing.join(", ")}`);
      }
      listedToolCount = names.length;
    });
    listToolsStep.detail = `${listedToolCount} tools`;

    await runStep("status", args.stepTimeoutMs, steps, async () => {
      const result = (await client.callTool({ name: "status", arguments: {} })) as CallToolResult;
      const text = ((result.content?.[0] as { type: "text"; text: string } | undefined)?.text ?? "");
      if (!text.includes("Indexing:")) {
        throw new Error("status response missing 'Indexing:'");
      }
    });

    await runStep("semantic_search", args.stepTimeoutMs, steps, async () => {
      const result = (await client.callTool({
        name: "semantic_search",
        arguments: { query: args.query, limit: 3 },
      })) as CallToolResult;
      const text = ((result.content?.[0] as { type: "text"; text: string } | undefined)?.text ?? "");
      if (text.length === 0) {
        throw new Error("semantic_search returned empty content");
      }
    });

    const totalMs = performance.now() - startedAt;
    console.log("MCP probe: PASS");
    console.log(`config: ${configPath}`);
    console.log(`log: ${logFile}`);
    for (const step of steps) {
      const suffix = step.detail ? ` (${step.detail})` : "";
      console.log(`- ${step.name}: ${Math.round(step.durationMs)}ms${suffix}`);
    }
    console.log(`total: ${Math.round(totalMs)}ms`);
  } catch (error) {
    const totalMs = performance.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);

    console.error("MCP probe: FAIL");
    console.error(`config: ${configPath}`);
    console.error(`log: ${logFile}`);
    for (const step of steps) {
      const suffix = step.detail ? ` (${step.detail})` : "";
      console.error(`- ${step.name}: ${Math.round(step.durationMs)}ms${suffix}`);
    }
    console.error(`total: ${Math.round(totalMs)}ms`);
    console.error(`error: ${message}`);

    const tail = readLogTail(logFile, 60);
    if (tail.length > 0) {
      console.error("--- engine log tail ---");
      for (const line of tail) {
        console.error(line);
      }
    }

    finalExitCode = 1;
  } finally {
    if (connected) {
      await bestEffortCleanup("client.close", () => client.close(), 800);
    }

    await bestEffortCleanup("transport.close", () => transport.close(), 800);

    if (finalExitCode !== 0) {
      process.exit(finalExitCode);
    }
  }
}

async function runStep(
  name: string,
  timeoutMs: number,
  steps: Array<{ name: string; durationMs: number; detail?: string }>,
  fn: () => Promise<void>,
): Promise<{ name: string; durationMs: number; detail?: string }> {
  const stepStart = performance.now();
  await withTimeout(fn(), timeoutMs, name);
  const step = { name, durationMs: performance.now() - stepStart };
  steps.push(step);
  return step;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, stepName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${stepName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

async function bestEffortCleanup(name: string, fn: () => Promise<unknown>, timeoutMs: number): Promise<void> {
  try {
    await withTimeout(fn().then(() => undefined), timeoutMs, `${name} cleanup`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[mcp-probe] ${name} did not finish cleanly: ${message}`);
  }
}

function readLogTail(path: string, lines: number): string[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf-8");
  return content.split(/\r?\n/).filter(Boolean).slice(-lines);
}

function createFastConfig(projectRoot: string): string {
  const dir = mkdtempSync(join(tmpdir(), "context-engine-mcp-probe-"));
  const path = join(dir, "context-engine.json");

  writeFileSync(
    path,
    JSON.stringify(
      {
        sources: [{ path: join(projectRoot, "src") }],
        dataDir: join(dir, "data"),
        watcher: { enabled: false },
        server: { transport: "stdio" },
        embedding: {
          provider: "local",
          localBackend: "mock",
          dimensions: 64,
        },
      },
      null,
      2,
    ),
  );

  return path;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    timeoutMs: 20_000,
    stepTimeoutMs: 8_000,
    query: "context engine",
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    switch (token) {
      case "--config":
      case "-c":
        out.config = argv[++i];
        break;
      case "--timeout-ms":
        out.timeoutMs = Number(argv[++i] ?? out.timeoutMs);
        break;
      case "--step-timeout-ms":
        out.stepTimeoutMs = Number(argv[++i] ?? out.stepTimeoutMs);
        break;
      case "--query":
      case "-q":
        out.query = argv[++i] ?? out.query;
        break;
      case "--log-file":
        out.logFile = argv[++i];
        break;
      default:
        if (token.startsWith("--")) {
          throw new Error(`Unknown flag: ${token}`);
        }
        break;
    }
  }

  out.stepTimeoutMs = Math.min(out.stepTimeoutMs, out.timeoutMs);
  return out;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`MCP probe fatal error: ${message}`);
  process.exit(1);
});
