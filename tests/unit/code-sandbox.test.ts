import { describe, expect, it } from "bun:test";
import { runCodeSandbox } from "../../src/server/tools/code-sandbox.js";

describe("QuickJS code sandbox", () => {
  it("executes TypeScript with read-only input", async () => {
    const result = await runCodeSandbox(
      `
output = {
  doubled: (input as any).value * 2,
  hasProcess: typeof process !== "undefined",
};
`,
      { input: { value: 21 } },
    );

    expect(result).toEqual({ doubled: 42, hasProcess: false });
  });

  it("enforces timeout via QuickJS interrupt handler", async () => {
    await expect(runCodeSandbox("while (true) {}", { timeoutMs: 50 }))
      .rejects.toThrow("timed out");
  });
});
