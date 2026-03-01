import { describe, expect, it } from "bun:test";
import { ConfigSchema } from "../../src/config.js";
import { createEmbeddingProvider } from "../../src/embeddings/factory.js";

describe("createEmbeddingProvider", () => {
  it("creates local provider", async () => {
    const config = ConfigSchema.parse({
      embedding: { provider: "local", dimensions: 64 },
      sources: [{ path: "." }],
    });

    const provider = createEmbeddingProvider(config);
    expect(provider.modelId.startsWith("local-onnx/") || provider.modelId === "local-mock/worker").toBe(true);
    expect(provider.dimensions).toBe(64);
    await provider.close();
  });

  it("creates local onnx-capable provider", async () => {
    const config = ConfigSchema.parse({
      embedding: {
        provider: "local",
        localBackend: "onnx",
        model: "Xenova/all-MiniLM-L6-v2",
        dimensions: 64,
        fallbackToMock: true,
      },
      sources: [{ path: "." }],
    });

    const provider = createEmbeddingProvider(config);
    const vectors = await provider.embed(["hello"]);

    expect(vectors.length).toBe(1);
    expect(vectors[0].length).toBe(64);
    expect(provider.modelId.startsWith("local-onnx/") || provider.modelId === "local-mock/worker").toBe(true);

    await provider.close();
  });

  it("creates vertex provider", async () => {
    const config = ConfigSchema.parse({
      embedding: {
        provider: "vertex",
        projectId: "demo-project",
        location: "us-central1",
        model: "text-embedding-005",
        dimensions: 768,
      },
      sources: [{ path: "." }],
    });

    const provider = createEmbeddingProvider(config);
    expect(provider.modelId).toBe("vertex/text-embedding-005");
    expect(provider.dimensions).toBe(768);
    await provider.close();
  });
});
