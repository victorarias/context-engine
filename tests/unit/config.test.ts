import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { loadConfig, ConfigSchema } from "../../src/config.js";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";

describe("Config", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ce-test-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  describe("ConfigSchema defaults", () => {
    it("produces valid config from empty object", () => {
      const config = ConfigSchema.parse({});
      expect(config.embedding.provider).toBe("local");
      expect(config.embedding.model).toBe("Xenova/all-MiniLM-L6-v2");
      expect(config.embedding.dimensions).toBe(768);
      expect(config.embedding.batchSize).toBe(32);
      expect(config.embedding.localBackend).toBe("onnx");
      expect(config.embedding.requestTimeoutMs).toBe(30000);
      expect(config.embedding.maxRetries).toBe(2);
      expect(config.embedding.retryBaseDelayMs).toBe(250);
      expect(config.performance.maxConcurrency).toBe(2);
      expect(config.performance.cpuThrottle).toBe("normal");
      expect(config.server.transport).toBe("stdio");
      expect(config.server.port).toBe(3777);
      expect(config.watcher.enabled).toBe(true);
      expect(config.watcher.debounceMs).toBe(250);
      expect(config.watcher.pollIntervalMs).toBe(750);
      expect(config.dataDir).toBe(".context-engine");
      expect(config.sources).toEqual([]);
    });

    it("merges partial config with defaults", () => {
      const config = ConfigSchema.parse({
        embedding: { provider: "vertex", model: "custom-model", projectId: "demo-project" },
        performance: { maxConcurrency: 4 },
      });
      expect(config.embedding.provider).toBe("vertex");
      expect(config.embedding.model).toBe("custom-model");
      expect(config.embedding.dimensions).toBe(768); // default kept
      expect(config.performance.maxConcurrency).toBe(4);
      expect(config.performance.cpuThrottle).toBe("normal"); // default kept
    });

    it("accepts local ONNX backend settings", () => {
      const config = ConfigSchema.parse({
        embedding: {
          provider: "local",
          localBackend: "onnx",
          model: "Xenova/all-MiniLM-L6-v2",
          fallbackToMock: true,
        },
      });

      expect(config.embedding.provider).toBe("local");
      expect(config.embedding.localBackend).toBe("onnx");
      expect(config.embedding.model).toBe("Xenova/all-MiniLM-L6-v2");
      expect(config.embedding.fallbackToMock).toBe(true);
    });
  });

  describe("loadConfig", () => {
    it("loads from explicit JSON path", () => {
      const configPath = join(tmpDir, "context-engine.json");
      writeFileSync(configPath, JSON.stringify({
        sources: [{ path: "." }],
        embedding: { provider: "vertex", projectId: "demo-project" },
      }));

      const config = loadConfig(configPath);
      expect(config.embedding.provider).toBe("vertex");
      expect(config.sources.length).toBe(1);
      // Source path should be resolved relative to config dir
      expect(config.sources[0].path).toBe(tmpDir);
    });

    it("discovers context-engine.json in directory", () => {
      writeFileSync(join(tmpDir, "context-engine.json"), JSON.stringify({
        embedding: { model: "discovered" },
      }));

      const config = loadConfig(tmpDir);
      expect(config.embedding.model).toBe("discovered");
    });

    it("discovers .context-engine.json (dotfile variant)", () => {
      writeFileSync(join(tmpDir, ".context-engine.json"), JSON.stringify({
        embedding: { model: "dotfile" },
      }));

      const config = loadConfig(tmpDir);
      expect(config.embedding.model).toBe("dotfile");
    });

    it("uses defaults when no config file found", () => {
      const config = loadConfig(tmpDir);
      expect(config.embedding.provider).toBe("local");
      expect(config.sources.length).toBe(1);
      expect(config.sources[0].path).toBe(tmpDir);
      expect(config.dataDir.startsWith(resolve(homedir(), ".context-engine"))).toBe(true);
      expect(config.dataDir.includes(".context-engine")).toBe(true);
      expect(config.dataDir.includes("nogit-")).toBe(true);
    });

    it("resolves relative source paths against config dir", () => {
      const configPath = join(tmpDir, "context-engine.json");
      writeFileSync(configPath, JSON.stringify({
        sources: [{ path: "./src" }, { path: "../other" }],
      }));

      const config = loadConfig(configPath);
      expect(config.sources[0].path).toBe(join(tmpDir, "src"));
      expect(config.sources[1].path).toBe(join(tmpDir, "..", "other"));
    });

    it("uses global derived dataDir when config omits dataDir", () => {
      const configPath = join(tmpDir, "context-engine.json");
      writeFileSync(configPath, JSON.stringify({
        sources: [{ path: "." }],
      }));

      const config = loadConfig(configPath);
      expect(config.dataDir.startsWith(resolve(homedir(), ".context-engine"))).toBe(true);
      expect(config.dataDir.includes(".context-engine")).toBe(true);
    });

    it("resolves dataDir relative to config dir", () => {
      const configPath = join(tmpDir, "context-engine.json");
      writeFileSync(configPath, JSON.stringify({
        dataDir: "./data",
      }));

      const config = loadConfig(configPath);
      expect(config.dataDir).toBe(join(tmpDir, "data"));
    });

    it("throws on missing explicit config file", () => {
      expect(() => loadConfig(join(tmpDir, "nonexistent.json")))
        .toThrow("Config file not found");
    });

    it("throws on invalid JSON", () => {
      const configPath = join(tmpDir, "context-engine.json");
      writeFileSync(configPath, "not json {{{");
      expect(() => loadConfig(configPath)).toThrow("Invalid JSON");
    });

    it("throws when vertex provider is missing projectId", () => {
      const configPath = join(tmpDir, "context-engine.json");
      writeFileSync(configPath, JSON.stringify({
        embedding: { provider: "vertex" },
      }));
      expect(() => loadConfig(configPath)).toThrow("projectId is required");
    });

    it("throws descriptive error on invalid config shape", () => {
      const configPath = join(tmpDir, "context-engine.json");
      writeFileSync(configPath, JSON.stringify({
        embedding: { provider: "invalid-provider" },
      }));
      expect(() => loadConfig(configPath)).toThrow("Invalid config");
    });
  });
});
