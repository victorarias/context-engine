import type { EmbeddingProvider } from "../types.js";

export type EmbedPriority = 0 | 1; // 0 = search, 1 = indexing

/**
 * Runtime embedding provider used by the engine.
 *
 * Extends the base EmbeddingProvider with scheduling and lifecycle hooks.
 */
export interface EmbeddingRuntimeProvider extends EmbeddingProvider {
  embedWithPriority(texts: string[], priority: EmbedPriority): Promise<Float32Array[]>;
  isBusy(): boolean;
  close(): Promise<void>;
}
