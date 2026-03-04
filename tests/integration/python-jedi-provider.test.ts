import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TempDir } from "../harness/temp-dir.js";
import { ConfigSchema } from "../../src/config.js";
import { ContextEngine } from "../../src/engine/context-engine.js";

function hasJedi(pythonExecutable: string): boolean {
  const probe = spawnSync(pythonExecutable, ["-c", "import jedi; print('ok')"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return probe.status === 0 && (probe.stdout ?? "").includes("ok");
}

describe("Python Jedi backend", () => {
  it("activates Jedi references when backend is configured", async () => {
    const pythonExecutable = process.env.CE_PYTHON_EXECUTABLE ?? "python3";
    const jediAvailable = hasJedi(pythonExecutable);
    const requireJedi = process.env.CE_REQUIRE_JEDI === "1";

    if (!jediAvailable) {
      if (requireJedi) {
        throw new Error(`CE_REQUIRE_JEDI=1 but Jedi is unavailable for '${pythonExecutable}'`);
      }

      // Optional test outside dedicated CI job.
      expect(jediAvailable).toBe(false);
      return;
    }

    const tmp = TempDir.create("ce-python-jedi");

    try {
      const sourceDir = join(tmp.path, "repo", "src");
      mkdirSync(join(sourceDir, "pkg"), { recursive: true });

      writeFileSync(join(sourceDir, "pkg", "__init__.py"), "");
      writeFileSync(
        join(sourceDir, "pkg", "base.py"),
        "class BaseOp:\n    def execute(self, x):\n        return x\n",
      );
      writeFileSync(
        join(sourceDir, "pkg", "runner.py"),
        "from .base import BaseOp\n\ndef run():\n    return BaseOp().execute(3)\n",
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
        python: {
          referencesBackend: "jedi",
          jedi: {
            pythonExecutable,
            requestTimeoutMs: 6000,
          },
        },
      });

      const engine = await ContextEngine.create(config);
      await engine.index();

      const refs = await engine.findReferences("execute", {
        filePath: "pkg/base.py",
        includeDeclaration: true,
        limit: 20,
      });

      expect(refs).toContain("Requested backend: python-jedi");
      expect(refs).toContain("Actual backend: python-jedi");
      expect(refs).toContain("pkg/base.py");

      const status = await engine.status();
      expect((status.pyReferenceBackends?.pythonJedi ?? 0)).toBeGreaterThan(0);

      await engine.close();
    } finally {
      tmp.cleanup();
    }
  }, 30_000);
});
