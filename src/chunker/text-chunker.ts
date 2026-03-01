import { createHash } from "node:crypto";
import type { Chunk, Chunker } from "../types.js";

export interface TextChunkerOptions {
  windowLines?: number;
  overlapLines?: number;
}

export class TextChunker implements Chunker {
  private readonly windowLines: number;
  private readonly overlapLines: number;

  constructor(options: TextChunkerOptions = {}) {
    this.windowLines = options.windowLines ?? 80;
    this.overlapLines = options.overlapLines ?? 20;

    if (this.windowLines <= 0) {
      throw new Error(`windowLines must be > 0, got ${this.windowLines}`);
    }
    if (this.overlapLines < 0 || this.overlapLines >= this.windowLines) {
      throw new Error(
        `overlapLines must be >= 0 and < windowLines (${this.windowLines}), got ${this.overlapLines}`,
      );
    }
  }

  chunk(content: string, filePath: string, language: string, repoId: string): Chunk[] {
    if (!content.length) return [];

    const lines = content.split(/\r?\n/);
    if (lines.length === 0) return [];

    const chunks: Chunk[] = [];
    const step = this.windowLines - this.overlapLines;

    for (let start = 0; start < lines.length; start += step) {
      const endExclusive = Math.min(start + this.windowLines, lines.length);
      const slice = lines.slice(start, endExclusive);
      const text = slice.join("\n").trimEnd();
      if (!text) continue;

      const startLine = start + 1;
      const endLine = endExclusive;
      const id = makeChunkId(filePath, startLine, endLine, text);

      chunks.push({
        id,
        content: text,
        filePath,
        startLine,
        endLine,
        language,
        repoId,
      });

      if (endExclusive >= lines.length) break;
    }

    return chunks;
  }
}

function makeChunkId(filePath: string, startLine: number, endLine: number, content: string): string {
  const hash = createHash("sha1")
    .update(filePath)
    .update(":")
    .update(String(startLine))
    .update(":")
    .update(String(endLine))
    .update(":")
    .update(content)
    .digest("hex")
    .slice(0, 16);

  return `${filePath}:${startLine}-${endLine}:${hash}`;
}
