import { describe, expect, it } from "bun:test";
import { normalizePathForLookup, isSecretPath } from "../../src/storage/security.js";

describe("security helpers", () => {
  it("detects secret paths", () => {
    expect(isSecretPath("src/.env")).toBe(true);
    expect(isSecretPath("src/secrets/token.txt")).toBe(true);
    expect(isSecretPath("src/main.ts")).toBe(false);
  });

  it("normalizes safe paths and rejects unsafe ones", () => {
    const roots = ["/tmp/project/src"];

    expect(normalizePathForLookup("module/a.ts", roots)).toBe("module/a.ts");
    expect(normalizePathForLookup("../etc/passwd", roots)).toBeNull();
    expect(normalizePathForLookup(".env", roots)).toBeNull();
  });
});
