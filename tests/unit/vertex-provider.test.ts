import { afterEach, describe, expect, it, mock } from "bun:test";
import { VertexEmbeddingProvider } from "../../src/embeddings/vertex.js";

describe("VertexEmbeddingProvider", () => {
  const originalEnv = process.env.VERTEX_ACCESS_TOKEN;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.VERTEX_ACCESS_TOKEN;
    else process.env.VERTEX_ACCESS_TOKEN = originalEnv;

    globalThis.fetch = originalFetch;
  });

  it("embeds via Vertex predict endpoint", async () => {
    process.env.VERTEX_ACCESS_TOKEN = "test-token";

    const fetchMock = mock(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toContain("aiplatform.googleapis.com");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-token");

      return new Response(
        JSON.stringify({
          predictions: [
            { embeddings: { values: [0.1, 0.2, 0.3] } },
            { embeddings: { values: [0.4, 0.5, 0.6] } },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    globalThis.fetch = fetchMock as any;

    const provider = new VertexEmbeddingProvider({
      projectId: "demo-project",
      location: "us-central1",
      model: "text-embedding-005",
      dimensions: 3,
    });

    const vectors = await provider.embed(["hello", "world"]);
    expect(vectors.length).toBe(2);
    expect(vectors[0][0]).toBeCloseTo(0.1, 5);
    expect(vectors[0][1]).toBeCloseTo(0.2, 5);
    expect(vectors[0][2]).toBeCloseTo(0.3, 5);
    expect(vectors[1][0]).toBeCloseTo(0.4, 5);
    expect(vectors[1][1]).toBeCloseTo(0.5, 5);
    expect(vectors[1][2]).toBeCloseTo(0.6, 5);
    expect(provider.isBusy()).toBe(false);
  });

  it("refreshes token and retries on 401", async () => {
    const tokenProvider = mock(async (opts?: { forceRefresh?: boolean }) => {
      if (opts?.forceRefresh) return "fresh-token";
      return "stale-token";
    });

    let calls = 0;
    const fetchMock = mock(async (_url: string | URL, init?: RequestInit) => {
      calls++;
      const auth = (init?.headers as Record<string, string>).Authorization;

      if (calls === 1) {
        expect(auth).toBe("Bearer stale-token");
        return new Response("unauthorized", { status: 401 });
      }

      expect(auth).toBe("Bearer fresh-token");
      return new Response(
        JSON.stringify({ predictions: [{ embeddings: { values: [0.9, 0.1] } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const provider = new VertexEmbeddingProvider({
      projectId: "demo-project",
      dimensions: 2,
      tokenProvider,
      fetchImpl: fetchMock as any,
      sleepFn: async () => {},
      maxRetries: 2,
      retryBaseDelayMs: 1,
    });

    const vectors = await provider.embed(["hello"]);
    expect(vectors.length).toBe(1);
    expect(calls).toBe(2);
    expect(tokenProvider).toHaveBeenCalledTimes(2);
  });

  it("retries retriable status codes", async () => {
    let calls = 0;
    const fetchMock = mock(async () => {
      calls++;
      if (calls === 1) {
        return new Response("busy", { status: 503 });
      }

      return new Response(
        JSON.stringify({ predictions: [{ embeddings: { values: [0.2, 0.8] } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const provider = new VertexEmbeddingProvider({
      projectId: "demo-project",
      dimensions: 2,
      tokenProvider: async () => "token",
      fetchImpl: fetchMock as any,
      sleepFn: async () => {},
      maxRetries: 2,
      retryBaseDelayMs: 1,
    });

    const vectors = await provider.embed(["hello"]);
    expect(vectors.length).toBe(1);
    expect(calls).toBe(2);
  });
});
