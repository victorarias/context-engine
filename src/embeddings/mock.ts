import type { EmbeddingProvider } from "../types.js";

/**
 * Deterministic embedding provider for local-first development and tests.
 *
 * Same text -> same vector, no network/model downloads.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly modelId = "mock-embed-v1";
  readonly dimensions: number;

  constructor(dimensions = 128) {
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.toVector(text));
  }

  private toVector(text: string): Float32Array {
    const vec = new Float32Array(this.dimensions);

    // token-ish hashing by words for slightly better semantic behavior
    const tokens = text.toLowerCase().split(/[^a-z0-9_]+/g).filter(Boolean);
    for (const token of tokens) {
      let hash = 2166136261;
      for (let i = 0; i < token.length; i++) {
        hash ^= token.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }

      const idx = Math.abs(hash) % this.dimensions;
      vec[idx] += 1;
      vec[(idx + 17) % this.dimensions] += 0.5;
    }

    // fallback so empty-ish text isn't all zeros
    if (tokens.length === 0) {
      vec[0] = 1;
    }

    // L2 normalize
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;

    return vec;
  }
}
