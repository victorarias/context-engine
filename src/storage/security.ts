import { basename, isAbsolute, normalize, relative, resolve } from "node:path";

const SECRET_BASENAME_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/i,
  /^id_(rsa|ed25519)(\.pub)?$/i,
  /^.*\.(pem|key|p12|pfx|secret)$/i,
  /^credentials\.json$/i,
  /^tokens?\.json$/i,
  /^\.pypirc$/i,
  /^\.npmrc$/i,
];

const SECRET_PATH_SEGMENT_PATTERNS: RegExp[] = [
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)secrets?(\/|$)/i,
  /(^|\/)private(\/|$)/i,
];

export function isSecretPath(path: string): boolean {
  const normalized = normalizePath(path);
  const base = basename(normalized);

  if (SECRET_BASENAME_PATTERNS.some((pattern) => pattern.test(base))) {
    return true;
  }

  return SECRET_PATH_SEGMENT_PATTERNS.some((pattern) => pattern.test(`/${normalized}`));
}

export function isUnsafeTraversal(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized.split("/").includes("..");
}

export function isPathInsideRoots(path: string, roots: string[]): boolean {
  const absolutePath = resolve(path);

  return roots.some((root) => {
    const rootPath = resolve(root);
    return absolutePath === rootPath || absolutePath.startsWith(`${rootPath}/`);
  });
}

export function normalizePathForLookup(requestedPath: string, roots: string[]): string | null {
  const trimmed = requestedPath.trim();
  if (!trimmed) return null;

  if (isSecretPath(trimmed)) return null;

  if (isAbsolute(trimmed)) {
    if (!isPathInsideRoots(trimmed, roots)) return null;

    const absolute = resolve(trimmed);
    for (const root of roots) {
      const rel = normalizePath(relative(resolve(root), absolute));
      if (!rel.startsWith("../") && rel !== "..") {
        if (isSecretPath(rel)) return null;
        return rel;
      }
    }

    return null;
  }

  if (isUnsafeTraversal(trimmed)) return null;

  const normalized = normalizePath(trimmed);
  if (isSecretPath(normalized)) return null;
  return normalized;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}
