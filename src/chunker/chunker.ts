import type { Chunk, Chunker } from "../types.js";
import { TextChunker } from "./text-chunker.js";
import { AstChunker } from "./ast-chunker.js";
import { supportsAstChunking } from "./languages.js";

/**
 * Hybrid chunker router:
 * - AST chunking for supported languages
 * - Sliding-window fallback for unsupported languages or parse failures
 */
export class HybridChunker implements Chunker {
  constructor(
    private readonly astChunker: AstChunker = new AstChunker(),
    private readonly textChunker: Chunker = new TextChunker(),
  ) {}

  async warmup(): Promise<void> {
    await this.astChunker.warmupTreeSitter(["typescript", "javascript", "python"]);
  }

  getWarnings(): string[] {
    return this.astChunker.getTreeSitterWarnings();
  }

  chunk(content: string, filePath: string, language: string, repoId: string): Chunk[] {
    if (supportsAstChunking(language)) {
      try {
        const astChunks = this.astChunker.chunk(content, filePath, language, repoId);
        if (astChunks.length > 0) {
          return astChunks;
        }
      } catch {
        // fallback below
      }
    }

    return this.textChunker.chunk(content, filePath, language, repoId);
  }
}
