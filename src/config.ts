import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

// ─── Schema ────────────────────────────────────────────────────────────

const SourceSchema = z.object({
  path: z.string(),
  include: z.array(z.string()).default(["**/*"]),
  exclude: z.array(z.string()).default([
    "**/node_modules/**",
    "**/.git/**",
    "**/dist/**",
    "**/build/**",
    "**/.next/**",
    "**/coverage/**",
    "**/__pycache__/**",
    "**/target/**",
    "**/vendor/**",
  ]),
});

const EmbeddingSchema = z
  .object({
    provider: z.enum(["local", "vertex"]).default("local"),
    model: z.string().default("nomic-embed-text-v1.5"),
    dimensions: z.number().default(768),
    batchSize: z.number().default(32),

    // Local provider specific
    localBackend: z.enum(["mock", "onnx"]).default("mock"),
    cacheDir: z.string().optional(),
    fallbackToMock: z.boolean().default(true),

    // Vertex AI specific
    projectId: z.string().optional(),
    location: z.string().default("us-central1"),
    publisher: z.string().default("google"),
    autoTruncate: z.boolean().default(true),
    outputDimensions: z.number().optional(),
    requestTimeoutMs: z.number().default(30000),
    maxRetries: z.number().default(2),
    retryBaseDelayMs: z.number().default(250),
  })
  .superRefine((value, ctx) => {
    if (value.provider === "vertex" && !value.projectId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["projectId"],
        message: "projectId is required when embedding.provider = 'vertex'",
      });
    }
  });

const PerformanceSchema = z.object({
  maxConcurrency: z.number().default(2),
  cpuThrottle: z.enum(["low", "normal", "high"]).default("normal"),
  maxMemoryMB: z.number().default(2048),
  indexingPriority: z.enum(["background", "foreground"]).default("background"),
});

const ServerSchema = z.object({
  transport: z.enum(["stdio", "http"]).default("stdio"),
  port: z.number().default(3777),
  host: z.string().default("127.0.0.1"),
});

const GitHistorySchema = z.object({
  enabled: z.boolean().default(true),
  maxCommits: z.number().default(1000),
});

const WatcherSchema = z.object({
  enabled: z.boolean().default(true),
  debounceMs: z.number().int().min(25).default(250),
  pollIntervalMs: z.number().int().min(50).default(750),
});

export const ConfigSchema = z.object({
  sources: z.array(SourceSchema).default([]),
  embedding: EmbeddingSchema.default({
    provider: "local",
    model: "nomic-embed-text-v1.5",
    dimensions: 768,
    batchSize: 32,
    localBackend: "mock",
    fallbackToMock: true,
    requestTimeoutMs: 30000,
    maxRetries: 2,
    retryBaseDelayMs: 250,
  }),
  performance: PerformanceSchema.default({
    maxConcurrency: 2,
    cpuThrottle: "normal",
    maxMemoryMB: 2048,
    indexingPriority: "background",
  }),
  server: ServerSchema.default({
    transport: "stdio",
    port: 3777,
    host: "127.0.0.1",
  }),
  dataDir: z.string().default(".context-engine"),
  gitHistory: GitHistorySchema.default({
    enabled: true,
    maxCommits: 1000,
  }),
  watcher: WatcherSchema.default({
    enabled: true,
    debounceMs: 250,
    pollIntervalMs: 750,
  }),
  docs: z.array(z.object({
    url: z.string(),
    selector: z.string().optional(),
  })).default([]),
});

export type Config = z.infer<typeof ConfigSchema>;

// ─── Loader ────────────────────────────────────────────────────────────

const CONFIG_FILENAMES = ["context-engine.json", ".context-engine.json"];

/**
 * Load config from a file path or search for it in the given directory.
 * Merges with defaults for any missing fields.
 */
export function loadConfig(pathOrDir?: string): Config {
  // If explicit path given, load it
  if (pathOrDir && pathOrDir.endsWith(".json")) {
    return parseConfigFile(pathOrDir);
  }

  // Search for config file in directory
  const dir = pathOrDir ? resolve(pathOrDir) : process.cwd();
  for (const filename of CONFIG_FILENAMES) {
    const configPath = resolve(dir, filename);
    if (existsSync(configPath)) {
      return parseConfigFile(configPath);
    }
  }

  // No config file found — use defaults, add current dir as source
  return ConfigSchema.parse({
    sources: [{ path: dir }],
  });
}

function parseConfigFile(filePath: string): Config {
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    throw new Error(`Config file not found: ${absPath}`);
  }

  const raw = readFileSync(absPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in config file: ${absPath}`);
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config in ${absPath}:\n${issues}`);
  }

  // Resolve relative source paths against config file directory
  const configDir = dirname(absPath);
  const config = result.data;
  config.sources = config.sources.map((s) => ({
    ...s,
    path: resolve(configDir, s.path),
  }));
  config.dataDir = resolve(configDir, config.dataDir);

  return config;
}
