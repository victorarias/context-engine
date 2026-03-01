import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TempDir } from "../harness/temp-dir.js";
import { ConfigSchema } from "../../src/config.js";
import { ContextEngine } from "../../src/engine/context-engine.js";

describe("Differential semantic search vs ripgrep", () => {
  const dirs: TempDir[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      dir.cleanup();
    }
  });

  it("returns at least one overlap file for token-like queries", async () => {
    const tmp = TempDir.create("ce-diff");
    dirs.push(tmp);

    const sourceDir = join(tmp.path, "repo", "src");
    mkdirSync(join(sourceDir, "auth"), { recursive: true });

    writeFileSync(
      join(sourceDir, "auth", "oauth.ts"),
      "export const oauthExchangeToken = () => 'oauth-token';\n",
    );
    writeFileSync(
      join(sourceDir, "auth", "password.ts"),
      "export const verifyPasswordHash = () => true;\n",
    );

    const config = ConfigSchema.parse({
      sources: [{ path: sourceDir }],
      dataDir: join(tmp.path, "data"),
      embedding: {
        provider: "local",
        localBackend: "mock",
        dimensions: 64,
      },
      watcher: { enabled: false },
    });

    const engine = await ContextEngine.create(config);
    await engine.index();

    const queries = ["oauthExchangeToken", "verifyPasswordHash"];

    for (const query of queries) {
      const semantic = await engine.search(query, { limit: 5 });
      const semanticFiles = new Set(semantic.map((result) => result.filePath));

      const rg = Bun.spawnSync({
        cmd: ["rg", "--files-with-matches", "--fixed-strings", query, sourceDir],
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(rg.exitCode === 0 || rg.exitCode === 1).toBe(true);

      const rgFiles = rg.stdout
        .toString()
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((path) => path.replace(`${sourceDir}/`, ""));

      if (rgFiles.length === 0) {
        continue;
      }

      const overlap = rgFiles.filter((path) => semanticFiles.has(path));
      expect(overlap.length).toBeGreaterThan(0);
    }

    await engine.close();
  });
});
