import { describe, expect, it } from "bun:test";
import { TextChunker } from "../../src/chunker/text-chunker.js";

describe("TextChunker", () => {
  it("splits content into overlapping line windows", () => {
    const chunker = new TextChunker({ windowLines: 4, overlapLines: 1 });
    const content = [
      "l1",
      "l2",
      "l3",
      "l4",
      "l5",
      "l6",
      "l7",
    ].join("\n");

    const chunks = chunker.chunk(content, "src/a.ts", "typescript", "repo");

    expect(chunks.length).toBe(2);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(4);
    expect(chunks[1].startLine).toBe(4);
    expect(chunks[1].endLine).toBe(7);
  });

  it("returns empty for empty content", () => {
    const chunker = new TextChunker();
    const chunks = chunker.chunk("", "a.ts", "typescript", "repo");
    expect(chunks).toEqual([]);
  });

  it("throws on invalid overlap settings", () => {
    expect(() => new TextChunker({ windowLines: 5, overlapLines: 5 })).toThrow();
    expect(() => new TextChunker({ windowLines: 5, overlapLines: 6 })).toThrow();
  });
});
