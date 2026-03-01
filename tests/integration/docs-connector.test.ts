import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TempDir } from "../harness/temp-dir.js";
import { ConfigSchema } from "../../src/config.js";
import { ContextEngine } from "../../src/engine/context-engine.js";

describe("Docs connector", () => {
  const dirs: TempDir[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      dir.cleanup();
    }
  });

  it("indexes configured docs and returns search_docs results", async () => {
    const tmp = TempDir.create("ce-docs");
    dirs.push(tmp);

    const sourceDir = join(tmp.path, "repo", "src");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "main.ts"), "export const boot = true;\n");

    const docText = "Context Engine Guide\n\nOAuth setup instructions for local development and testing.";
    const docUrl = `data:text/plain,${encodeURIComponent(docText)}`;

    const config = ConfigSchema.parse({
      sources: [{ path: sourceDir }],
      dataDir: join(tmp.path, "data"),
      embedding: {
        provider: "local",
        localBackend: "mock",
        dimensions: 64,
      },
      docs: [{ url: docUrl }],
      watcher: {
        enabled: false,
      },
    });

    const engine = await ContextEngine.create(config);
    await engine.index();

    const results = await engine.searchDocs("OAuth setup instructions");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].filePath).toBe(docUrl);
    expect(results[0].content).toContain("Context Engine Guide");
    expect(results[0].content).toContain("OAuth setup instructions");

    const noResults = await engine.searchDocs("totally-missing-token");
    expect(noResults.length).toBe(0);

    await engine.close();
  });
});
