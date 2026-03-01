import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { Chunk } from "../types.js";

export interface RankedCandidate {
  path: string;
  chunk: Chunk;
  baseScore: number;
}

export interface RerankedCandidate extends RankedCandidate {
  score: number;
}

export function rerankCandidates(
  query: string,
  candidates: RankedCandidate[],
  options: { roots: string[] },
): RerankedCandidate[] {
  const queryTokens = tokenize(query);

  const ranked = candidates.map((candidate) => {
    const symbolBoost = candidate.chunk.symbolName
      ? tokenCoverage(queryTokens, tokenize(candidate.chunk.symbolName)) * 0.15
      : 0;

    const pathBoost = tokenCoverage(queryTokens, tokenize(candidate.path)) * 0.1;
    const recencyBoost = computeRecencyBoost(candidate.path, options.roots);

    const score =
      candidate.baseScore * 0.75 +
      symbolBoost +
      pathBoost +
      recencyBoost;

    return {
      ...candidate,
      score,
    };
  });

  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

function computeRecencyBoost(path: string, roots: string[]): number {
  const now = Date.now();

  for (const root of roots) {
    const absolute = resolve(root, path);

    try {
      const stat = statSync(absolute);
      const ageMs = Math.max(0, now - stat.mtimeMs);
      const oneDay = 24 * 60 * 60 * 1000;
      const freshness = Math.max(0, 1 - ageMs / (30 * oneDay));
      return freshness * 0.08;
    } catch {
      // try next root
    }
  }

  return 0;
}

function tokenize(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter(Boolean);
}

function tokenCoverage(queryTokens: string[], candidateTokens: string[]): number {
  if (queryTokens.length === 0 || candidateTokens.length === 0) return 0;

  const candidateSet = new Set(candidateTokens);
  let matched = 0;

  for (const token of queryTokens) {
    if (candidateSet.has(token)) {
      matched += 1;
    }
  }

  return matched / queryTokens.length;
}
