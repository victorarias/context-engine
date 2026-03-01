import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

describe("MCP Server E2E", () => {
  let client: Client;
  let transport: StdioClientTransport;
  let tempDir: string;
  let configPath: string;
  const projectRoot = resolve(import.meta.dir, "../../");

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "context-engine-e2e-"));
    configPath = join(tempDir, "context-engine.json");

    const docsText = "Context Engine documentation getting started guide with local indexing tips.";
    const docsUrl = `data:text/plain,${encodeURIComponent(docsText)}`;

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          sources: [{ path: join(projectRoot, "src") }],
          docs: [{ url: docsUrl }],
          dataDir: join(tempDir, "data"),
          server: { transport: "stdio" },
          watcher: { enabled: false },
        },
        null,
        2,
      ),
    );

    // Build a real index first so tools return meaningful results.
    const indexRun = Bun.spawnSync({
      cmd: ["bun", "run", "src/cli.ts", "index", configPath],
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    if (indexRun.exitCode !== 0) {
      throw new Error(`Index failed:\n${indexRun.stderr.toString()}`);
    }

    transport = new StdioClientTransport({
      command: "bun",
      args: ["run", "src/cli.ts", "serve", configPath],
      cwd: projectRoot,
    });

    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("lists all registered tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    expect(names).toContain("semantic_search");
    expect(names).toContain("find_files");
    expect(names).toContain("get_symbols");
    expect(names).toContain("get_file_summary");
    expect(names).toContain("get_recent_changes");
    expect(names).toContain("get_dependencies");
    expect(names).toContain("search_docs");
    expect(names).toContain("status");
    expect(names).toContain("code_sandbox");
    expect(names.length).toBe(9);
  });

  it("semantic_search returns text content (not crash)", async () => {
    const result = (await client.callTool({
      name: "semantic_search",
      arguments: { query: "write ahead log" },
    })) as CallToolResult;

    expect(result.content).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text.length).toBeGreaterThan(0);
  });

  it("find_files returns matches", async () => {
    const result = (await client.callTool({
      name: "find_files",
      arguments: { pattern: "*.ts" },
    })) as CallToolResult;

    expect(result.content).toBeDefined();
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain(".ts");
  });

  it("get_symbols returns symbols for indexed files", async () => {
    const result = (await client.callTool({
      name: "get_symbols",
      arguments: { name: "ContextEngine" },
    })) as CallToolResult;

    expect(result.content).toBeDefined();
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("ContextEngine");
  });

  it("get_file_summary returns summary for indexed file", async () => {
    const result = (await client.callTool({
      name: "get_file_summary",
      arguments: { path: "src/engine/context-engine.ts" },
    })) as CallToolResult;

    expect(result.content).toBeDefined();
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("File:");
    expect(text).toContain("Symbols:");
  });

  it("get_recent_changes returns output", async () => {
    const result = (await client.callTool({
      name: "get_recent_changes",
      arguments: { query: "auth" },
    })) as CallToolResult;

    expect(result.content).toBeDefined();
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text.length).toBeGreaterThan(0);
    expect(
      text.includes("Recent changes") ||
      text.includes("No git history sources detected") ||
      text.includes("No recent changes matched query"),
    ).toBe(true);
  });

  it("get_dependencies returns output", async () => {
    const result = (await client.callTool({
      name: "get_dependencies",
      arguments: { path: "src/engine/context-engine.ts" },
    })) as CallToolResult;

    expect(result.content).toBeDefined();
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Dependencies");
  });

  it("search_docs returns indexed documentation", async () => {
    const result = (await client.callTool({
      name: "search_docs",
      arguments: { query: "getting started" },
    })) as CallToolResult;

    expect(result.content).toBeDefined();
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Context Engine documentation");
    expect(text).toContain("getting started");
  });

  it("status returns engine state", async () => {
    const result = (await client.callTool({
      name: "status",
      arguments: {},
    })) as CallToolResult;

    expect(result.content).toBeDefined();
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Indexing: idle");
    expect(text).toContain("Embedding model");
  });

  it("code_sandbox executes ts snippets with read-only input", async () => {
    const result = (await client.callTool({
      name: "code_sandbox",
      arguments: {
        code: "output = { doubled: (input as any).value * 2 };",
        input: { value: 21 },
      },
    })) as CallToolResult;

    expect(result.content).toBeDefined();
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("\"ok\": true");
    expect(text).toContain("\"doubled\": 42");
  });

  it("semantic_search with limit option works", async () => {
    const result = (await client.callTool({
      name: "semantic_search",
      arguments: { query: "engine", limit: 5 },
    })) as CallToolResult;

    expect(result.content).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);
  });
});
