import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TempDir } from "../harness/temp-dir.js";
import { ConfigSchema } from "../../src/config.js";
import { ContextEngine } from "../../src/engine/context-engine.js";

describe("python adversarial regression suite", () => {
  const dirs: TempDir[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      dir.cleanup();
    }
  });

  it("stays robust on ambiguous symbols, bad paths, and non-code noise", async () => {
    const tmp = TempDir.create("ce-py-adversarial");
    dirs.push(tmp);

    const sourceDir = join(tmp.path, "repo", "src");
    mkdirSync(join(sourceDir, "pkg"), { recursive: true });

    writeFileSync(join(sourceDir, "pkg", "__init__.py"), "");
    writeFileSync(join(sourceDir, "pkg", "base.py"), "class Base:\n    def execute(self, value):\n        return value\n");
    writeFileSync(join(sourceDir, "pkg", "impl.py"), "from .base import Base\n\nclass Impl(Base):\n    def execute(self, value):\n        return value + 1\n");
    writeFileSync(join(sourceDir, "pkg", "runner.py"), "from .base import Base\n\ndef run():\n    return Base().execute(5)\n");
    writeFileSync(join(sourceDir, "pkg", "notes.md"), "execute execute execute\nfrom .base import Base\n");

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
        referencesBackend: "static",
      },
    });

    const engine = await ContextEngine.create(config);
    await engine.index();

    const anchored = await engine.findReferences("execute", {
      filePath: "pkg/base.py",
      limit: 20,
    });
    expect(anchored).toContain("Actual backend: python-static");
    expect(anchored).toContain("pkg/impl.py");
    expect(anchored).toContain("[override]");
    expect(anchored).not.toContain("pkg/notes.md");

    const srcPrefixed = await engine.findReferences("execute", {
      filePath: "src/pkg/base.py",
      limit: 20,
    });
    expect(srcPrefixed).not.toContain("Python file not found on disk");
    expect(srcPrefixed).toContain("pkg/impl.py");

    const missingImporters = await engine.findImporters("src/pkg/missing.py");
    expect(missingImporters).toContain("Hint: target path was not found on disk");

    const missingSymbol = await engine.findReferences("DefinitelyMissingSymbolXYZ", {
      filePath: "pkg/base.py",
      limit: 10,
    });
    expect(missingSymbol).toContain("No references found.");
    expect(missingSymbol).toContain("Requested backend: python-static");

    await engine.close();
  });
});
