import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

describe("MCP Server HTTP E2E", () => {
  let client: Client;
  let transport: StreamableHTTPClientTransport;
  let processHandle: Subprocess;
  let tempDir: string;
  let port: number;

  const projectRoot = resolve(import.meta.dir, "../../");

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "context-engine-http-e2e-"));
    port = randomPort();

    const configPath = join(tempDir, "context-engine.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          sources: [{ path: join(projectRoot, "src") }],
          dataDir: join(tempDir, "data"),
          server: {
            transport: "http",
            host: "127.0.0.1",
            port,
          },
          watcher: { enabled: false },
        },
        null,
        2,
      ),
    );

    processHandle = Bun.spawn({
      cmd: ["bun", "run", "src/cli.ts", "serve", configPath],
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    await waitForHttpReady(port, 5000);

    transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    client = new Client({ name: "http-test-client", version: "1.0.0" });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close();

    if (processHandle && processHandle.exitCode === null) {
      processHandle.kill("SIGTERM");
      await processHandle.exited;
    }

    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("serves MCP tools over streamable HTTP", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(9);

    const status = await client.callTool({
      name: "status",
      arguments: {},
    });

    const statusText = (status.content[0] as { type: "text"; text: string }).text;
    expect(statusText).toContain("Indexing: idle");

    const sandbox = await client.callTool({
      name: "code_sandbox",
      arguments: {
        code: "output = { ok: (input as any).n + 1 };",
        input: { n: 1 },
      },
    });

    const sandboxText = (sandbox.content[0] as { type: "text"; text: string }).text;
    expect(sandboxText).toContain("\"ok\": true");
  });
});

function randomPort(): number {
  return 42000 + Math.floor(Math.random() * 2000);
}

async function waitForHttpReady(port: number, timeoutMs: number): Promise<void> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "GET",
      });

      // Any HTTP response means the listener is up.
      if (response.status >= 200 && response.status < 500) {
        return;
      }
    } catch {
      // ignore until next retry
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }

  throw new Error(`HTTP server did not become ready on port ${port}`);
}
