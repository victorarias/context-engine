#!/usr/bin/env bun

import { existsSync, rmSync } from "node:fs";
import { createMcpServer } from "./server/mcp-server.js";
import { attachHttp, attachStdio } from "./server/transports.js";
import { resolve } from "node:path";
import { ContextEngine } from "./engine/context-engine.js";
import { loadConfig } from "./config.js";
import { LanceVectorStore, SQLiteMetadataStore, checkStorageConsistency } from "./storage/index.js";
import { logError, logEvent } from "./observability/logger.js";

const args = process.argv.slice(2);
const command = args[0];

async function main() {
  switch (command) {
    case "serve":
      await serve();
      break;

    case "index":
      await index();
      break;

    case "status":
      await status();
      break;

    case "reindex":
      await reindex();
      break;

    case "doctor":
      await doctor();
      break;

    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run "context-engine help" for usage.');
      process.exit(1);
  }
}

async function serve() {
  const config = loadConfig(args[1]);
  logEvent("info", "cli.serve.start", {
    transport: config.server.transport,
    host: config.server.host,
    port: config.server.port,
    sources: config.sources.map((source) => source.path),
  });

  const engine = await ContextEngine.create(config);

  void (async () => {
    try {
      logEvent("info", "cli.serve.initial_index.start", {
        sources: config.sources.map((s) => s.path),
      });

      await engine.index(config.sources.map((s) => s.path));

      if (config.watcher.enabled) {
        await engine.startWatching();
      }

      logEvent("info", "cli.serve.initial_index.complete", {
        watcherEnabled: config.watcher.enabled,
      });
    } catch (error) {
      logError("cli.serve.initial_index.failed", error);
    }
  })();

  const server = createMcpServer(engine);
  const transportType = config.server.transport;

  if (transportType === "stdio") {
    await attachStdio(server);
    logEvent("info", "cli.serve.transport_ready", { transport: "stdio" });

    // Keep alive until stdin closes
    process.stdin.on("end", async () => {
      logEvent("info", "cli.serve.stdin_end");
      await engine.close();
      process.exit(0);
    });
    return;
  }

  const { httpServer } = await attachHttp(server, {
    host: config.server.host,
    port: config.server.port,
  });

  console.error(`HTTP MCP server listening on http://${config.server.host}:${config.server.port}/mcp`);
  logEvent("info", "cli.serve.transport_ready", {
    transport: "http",
    host: config.server.host,
    port: config.server.port,
    path: "/mcp",
  });

  const shutdown = async () => {
    logEvent("info", "cli.serve.shutdown");
    await engine.close();
    await new Promise<void>((resolveClose) => httpServer.close(() => resolveClose()));
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function index() {
  const dir = args[1] || ".";
  const config = loadConfig(dir);
  const engine = await ContextEngine.create(config);

  logEvent("info", "cli.index.start", { sources: config.sources.map((s) => s.path) });
  console.log(`Indexing ${config.sources.map((s) => s.path).join(", ")}...`);
  await engine.index(config.sources.map((s) => s.path));
  console.log("Done.");
  await engine.close();
  logEvent("info", "cli.index.complete");
}

async function status() {
  const config = loadConfig(args[1]);
  const engine = await ContextEngine.create(config);
  const s = await engine.status();
  console.log(`Indexing: ${s.indexing ? "in progress" : "idle"}`);
  console.log(`Embedding model: ${s.embeddingModel}`);
  console.log(`Worker: ${s.workerBusy ? "busy" : "idle"}`);
  console.log(`Watcher: ${config.watcher.enabled ? "enabled" : "disabled"}`);
  console.log(`Repos indexed: ${s.repos.length}`);
  for (const repo of s.repos) {
    console.log(`- ${repo.path}: ${repo.filesIndexed} files, ${repo.chunksStored} chunks`);
  }

  if (s.languageFileCounts && Object.keys(s.languageFileCounts).length > 0) {
    const languageSummary = Object.entries(s.languageFileCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([lang, count]) => `${lang}:${count}`)
      .join(", ");
    console.log(`Indexed languages: ${languageSummary}`);
  }

  if (s.capabilities) {
    const caps: string[] = [];
    if (s.capabilities.goReferencesBinary) {
      caps.push(`goReferencesBinary=${s.capabilities.goReferencesBinary}`);
    }
    if (s.capabilities.goReferencesSelection) {
      caps.push(`goReferencesSelection=${s.capabilities.goReferencesSelection}`);
    }
    if (s.capabilities.goDependencies) {
      caps.push(`goDependencies=${s.capabilities.goDependencies}`);
    }
    if (caps.length > 0) {
      console.log(`Capabilities: ${caps.join(", ")}`);
    }
  }

  await engine.close();
}

async function reindex() {
  const config = loadConfig(args[1]);
  const dataDir = config.dataDir;
  logEvent("info", "cli.reindex.start", { dataDir, sources: config.sources.map((s) => s.path) });

  try {
    if (existsSync(dataDir)) {
      rmSync(dataDir, { recursive: true, force: true });
    }
  } catch {
    // best effort
  }

  const engine = await ContextEngine.create(config);
  console.log(`Rebuilding index for ${config.sources.map((s) => s.path).join(", ")}...`);
  await engine.index(config.sources.map((s) => s.path));
  console.log("Reindex complete.");
  await engine.close();
  logEvent("info", "cli.reindex.complete");
}

async function doctor() {
  const config = loadConfig(args[1]);
  const fix = args.includes("--fix");
  logEvent("info", "cli.doctor.start", { dataDir: config.dataDir, fix });

  const metadata = new SQLiteMetadataStore({
    path: resolve(config.dataDir, "metadata.db"),
  });
  const vectors = new LanceVectorStore({
    uri: resolve(config.dataDir, "lancedb"),
    vectorDimensions: config.embedding.dimensions,
  });

  const report = await checkStorageConsistency(vectors, metadata);

  console.log(`Consistent: ${report.consistent ? "yes" : "no"}`);
  console.log(`Referenced chunks: ${report.referencedChunkIds}`);
  console.log(`Vector chunks: ${report.vectorChunkIds}`);
  if (report.missingVectors.length > 0) {
    console.log(`Missing vectors: ${report.missingVectors.length}`);
  }
  if (report.orphanVectors.length > 0) {
    console.log(`Orphan vectors: ${report.orphanVectors.length}`);
  }

  await vectors.close();
  await metadata.close();

  logEvent("info", "cli.doctor.complete", {
    consistent: report.consistent,
    missingVectors: report.missingVectors.length,
    orphanVectors: report.orphanVectors.length,
  });

  if (!report.consistent && fix) {
    console.log("Inconsistency detected — running full reindex (--fix)...");
    await reindex();
  }
}

function printHelp() {
  console.log(`
context-engine — Local-first code intelligence MCP server

Usage:
  context-engine serve [config-path]   Start MCP server (STDIO by default)
  context-engine index [dir]           Index a directory
  context-engine status                Show index status
  context-engine reindex [config-path] Rebuild index from scratch
  context-engine doctor [config-path] [--fix]  Run consistency checks (optionally auto-reindex)
  context-engine help                  Show this help

Config:
  Reads context-engine.json or .context-engine.json from the current directory,
  or specify a path explicitly.

Examples:
  context-engine serve                  # Start with auto-detected config
  context-engine serve ./project/       # Start with config from project dir
  context-engine index .                # Index current directory
  context-engine index /path/to/repo    # Index a specific repo
`.trim());
}

main().catch((err) => {
  logError("cli.fatal", err);
  console.error("Fatal error:", err.message);
  process.exit(1);
});
