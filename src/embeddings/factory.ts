import type { Config } from "../config.js";
import { WorkerEmbeddingProvider } from "./worker-provider.js";
import { VertexEmbeddingProvider } from "./vertex.js";
import type { EmbeddingRuntimeProvider } from "./runtime.js";

export function createEmbeddingProvider(config: Config): EmbeddingRuntimeProvider {
  const embedding = config.embedding;

  if (embedding.provider === "local") {
    return new WorkerEmbeddingProvider({
      dimensions: embedding.dimensions,
      maxPendingIndexJobs: config.performance.maxConcurrency,
      backend: embedding.localBackend,
      model: embedding.model,
      cacheDir: embedding.cacheDir,
      fallbackToMock: embedding.fallbackToMock,
    });
  }

  if (embedding.provider === "vertex") {
    if (!embedding.projectId) {
      throw new Error("embedding.projectId is required for provider=vertex");
    }

    return new VertexEmbeddingProvider({
      projectId: embedding.projectId,
      location: embedding.location,
      publisher: embedding.publisher,
      model: embedding.model,
      dimensions: embedding.dimensions,
      autoTruncate: embedding.autoTruncate,
      outputDimensions: embedding.outputDimensions,
      requestTimeoutMs: embedding.requestTimeoutMs,
      maxRetries: embedding.maxRetries,
      retryBaseDelayMs: embedding.retryBaseDelayMs,
    });
  }

  throw new Error(`Unsupported embedding provider: ${(embedding as any).provider}`);
}
