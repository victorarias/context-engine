import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TempDir } from "../harness/temp-dir.js";
import { parsePyProject } from "../../src/engine/python-resolver/pyproject-parser.js";
import { PythonPackageResolver } from "../../src/engine/python-resolver/python-package-resolver.js";

describe("Python package resolver", () => {
  it("parses project metadata and alias section from pyproject", () => {
    const tmp = TempDir.create("pyproject-parse");

    try {
      const path = join(tmp.path, "pyproject.toml");
      writeFileSync(
        path,
        `[project]
name = "reme_ai"
dependencies = [
  "flowllm[reme]>=0.2.0",
  "pydantic>=2.0.0"
]

[tool.setuptools.packages.find]
include = ["reme*", "reme_ai*"]

[tool.context_engine.python.importAliases]
"flowllm.core" = "reme.core"
`,
      );

      const parsed = parsePyProject(path);
      expect(parsed.projectName).toBe("reme_ai");
      expect(parsed.dependencies).toContain("flowllm[reme]>=0.2.0");
      expect(parsed.packageIncludes).toContain("reme*");
      expect(parsed.aliasMap["flowllm.core"]).toBe("reme.core");
    } finally {
      tmp.cleanup();
    }
  });

  it("combines configured aliases with pyproject heuristics", () => {
    const tmp = TempDir.create("pyproject-resolver");

    try {
      mkdirSync(join(tmp.path, "repo"), { recursive: true });
      writeFileSync(
        join(tmp.path, "repo", "pyproject.toml"),
        `[project]
name = "reme_ai"
dependencies = ["flowllm[reme]>=0.2.0"]

[tool.setuptools.packages.find]
include = ["reme*", "reme_ai*"]
`,
      );

      const resolver = new PythonPackageResolver([join(tmp.path, "repo")], {
        importAliases: {
          "vendor.pkg": "internal.pkg",
        },
      });

      const candidates = resolver.resolveCandidates("flowllm.core.schema");
      expect(candidates).toContain("flowllm.core.schema");
      expect(candidates).toContain("reme.core.schema");

      const configured = resolver.resolveCandidates("vendor.pkg.api");
      expect(configured).toContain("internal.pkg.api");
    } finally {
      tmp.cleanup();
    }
  });
});
