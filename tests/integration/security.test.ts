import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TempDir } from "../harness/temp-dir.js";
import { ConfigSchema } from "../../src/config.js";
import { ContextEngine } from "../../src/engine/context-engine.js";

describe("Security guards", () => {
  const dirs: TempDir[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      dir.cleanup();
    }
  });

  it("rejects traversal and secret paths for file tools", async () => {
    const tmp = TempDir.create("ce-security");
    dirs.push(tmp);

    const sourceDir = join(tmp.path, "repo", "src");
    mkdirSync(sourceDir, { recursive: true });

    writeFileSync(join(sourceDir, "safe.ts"), "export const ok = true;\n");

    const config = ConfigSchema.parse({
      sources: [{ path: sourceDir }],
      dataDir: join(tmp.path, "data"),
      embedding: {
        provider: "local",
        localBackend: "mock",
        dimensions: 64,
      },
      watcher: {
        enabled: false,
      },
    });

    const engine = await ContextEngine.create(config);
    await engine.index();

    const depTraversal = await engine.getDependencies("../../etc/passwd");
    expect(depTraversal).toContain("Rejected path");

    const depSecret = await engine.getDependencies(".env");
    expect(depSecret).toContain("Rejected path");

    const summaryTraversal = await engine.getFileSummary("../../secret.txt");
    expect(summaryTraversal).toContain("Rejected path");

    await engine.close();
  });
});
