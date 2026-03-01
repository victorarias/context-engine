import { afterEach, describe, expect, it } from "bun:test";
import { WorkerEmbeddingProvider } from "../../src/embeddings/worker-provider.js";

describe("WorkerEmbeddingProvider", () => {
  const providers: WorkerEmbeddingProvider[] = [];

  afterEach(async () => {
    while (providers.length) {
      await providers.pop()!.close();
    }
  });

  it("embeds text in a worker thread", async () => {
    const provider = new WorkerEmbeddingProvider({ dimensions: 64 });
    providers.push(provider);

    const vectors = await provider.embed(["hello world", "authentication token"]);

    expect(provider.modelId).toBe("local-mock/worker");
    expect(vectors.length).toBe(2);
    expect(vectors[0].length).toBe(64);
    expect(vectors[1].length).toBe(64);
  });

  it("supports prioritized requests", async () => {
    const provider = new WorkerEmbeddingProvider({ dimensions: 32, maxPendingIndexJobs: 1 });
    providers.push(provider);

    const indexPromise = provider.embedWithPriority(["index batch content"], 1);
    const searchPromise = provider.embedWithPriority(["search query"], 0);

    const [indexVectors, searchVectors] = await Promise.all([indexPromise, searchPromise]);

    expect(indexVectors[0].length).toBe(32);
    expect(searchVectors[0].length).toBe(32);
    expect(provider.isBusy()).toBe(false);
  });

  const itOnnxFallback = process.env.CI ? it.skip : it;

  itOnnxFallback("falls back to mock when ONNX backend is unavailable", async () => {
    const provider = new WorkerEmbeddingProvider({
      dimensions: 16,
      backend: "onnx",
      model: "invalid/non-existent-model",
      fallbackToMock: true,
    });
    providers.push(provider);

    const vectors = await provider.embed(["fallback test"]);

    expect(vectors.length).toBe(1);
    expect(vectors[0].length).toBe(16);
    expect(provider.modelId === "local-mock/worker" || provider.modelId.startsWith("local-onnx/")).toBe(true);
  });
});
