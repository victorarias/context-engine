import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Attach an MCP server to STDIO transport.
 */
export async function attachStdio(server: McpServer): Promise<StdioServerTransport> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return transport;
}

export async function attachHttp(
  server: McpServer,
  options: { host: string; port: number; path?: string },
): Promise<{ transport: StreamableHTTPServerTransport; httpServer: Server }> {
  const path = options.path ?? "/mcp";

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  await server.connect(transport);

  const httpServer = createServer((req, res) => {
    const url = req.url ?? "";

    if (!url.startsWith(path)) {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: `Not found: ${url}` }));
      return;
    }

    transport.handleRequest(req, res).catch((error) => {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    httpServer.once("error", rejectListen);
    httpServer.listen(options.port, options.host, () => {
      httpServer.off("error", rejectListen);
      resolveListen();
    });
  });

  return { transport, httpServer };
}
