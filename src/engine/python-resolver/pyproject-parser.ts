import { existsSync, readFileSync } from "node:fs";

export interface PyProjectInfo {
  projectName?: string;
  dependencies: string[];
  packageIncludes: string[];
  aliasMap: Record<string, string>;
}

export function parsePyProject(pyprojectPath: string): PyProjectInfo {
  if (!existsSync(pyprojectPath)) {
    return {
      dependencies: [],
      packageIncludes: [],
      aliasMap: {},
    };
  }

  let raw: string;
  try {
    raw = readFileSync(pyprojectPath, "utf-8");
  } catch {
    return {
      dependencies: [],
      packageIncludes: [],
      aliasMap: {},
    };
  }

  const lines = raw.split(/\r?\n/);

  const dependencies: string[] = [];
  const packageIncludes: string[] = [];
  const aliasMap: Record<string, string> = {};

  let projectName: string | undefined;
  let section = "";
  let inDependencies = false;
  let inIncludes = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1] ?? "";
      inDependencies = false;
      inIncludes = false;
      continue;
    }

    if (section === "project" && !projectName) {
      const nameMatch = trimmed.match(/^name\s*=\s*"([^"]+)"\s*$/);
      if (nameMatch?.[1]) {
        projectName = nameMatch[1].trim();
      }
    }

    if (section === "project") {
      if (/^dependencies\s*=\s*\[/.test(trimmed)) {
        inDependencies = true;
        collectInlineArrayValues(trimmed, dependencies);
        if (trimmed.includes("]")) {
          inDependencies = false;
        }
        continue;
      }

      if (inDependencies) {
        collectInlineArrayValues(trimmed, dependencies);
        if (trimmed.includes("]")) {
          inDependencies = false;
        }
        continue;
      }
    }

    if (section === "tool.setuptools.packages.find") {
      if (/^include\s*=\s*\[/.test(trimmed)) {
        inIncludes = true;
        collectInlineArrayValues(trimmed, packageIncludes);
        if (trimmed.includes("]")) {
          inIncludes = false;
        }
        continue;
      }

      if (inIncludes) {
        collectInlineArrayValues(trimmed, packageIncludes);
        if (trimmed.includes("]")) {
          inIncludes = false;
        }
        continue;
      }
    }

    if (
      section === "tool.context_engine.python.importAliases"
      || section === "tool.context-engine.python.importAliases"
      || section === "tool.contextEngine.python.importAliases"
    ) {
      const kv = trimmed.match(/^"?([^"=]+)"?\s*=\s*"([^"]+)"\s*$/);
      if (kv?.[1] && kv?.[2]) {
        aliasMap[kv[1].trim()] = kv[2].trim();
      }
    }
  }

  return {
    projectName,
    dependencies: unique(dependencies),
    packageIncludes: unique(packageIncludes),
    aliasMap,
  };
}

function collectInlineArrayValues(line: string, out: string[]): void {
  for (const quoted of line.matchAll(/"([^"]+)"/g)) {
    if (quoted[1]) {
      out.push(quoted[1]);
    }
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));
}
