import { describe, expect, it } from "bun:test";
import { chunkDocument } from "../../src/sources/doc-fetcher.js";

describe("doc-fetcher helpers", () => {
  it("chunks long docs into overlapping pieces", () => {
    const content = new Array(60).fill("Authentication and session token notes.").join(" ");
    const chunks = chunkDocument(content, { maxChars: 200, overlapChars: 50 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length > 0)).toBe(true);
    expect(chunks[0]).toContain("Authentication");
  });
});
