import type { SearchResult, SymbolInfo, EngineStatus } from "../types.js";

export interface Engine {
  search(query: string, options?: { worktreeId?: string; limit?: number; minScore?: number }): Promise<SearchResult[]>;
  findFiles(pattern: string, options?: { worktreeId?: string }): Promise<string[]>;
  getSymbols(query: { name?: string; filePath?: string; kind?: string; limit?: number }): Promise<SymbolInfo[]>;
  getFileSummary(filePath: string): Promise<string>;
  getRecentChanges(options?: string | { query?: string; limit?: number; since?: string }): Promise<string>;
  getDependencies(filePath: string, options?: { recursive?: boolean; maxFiles?: number }): Promise<string>;
  findImporters(target: string, options?: { limit?: number }): Promise<string>;
  findReferences(symbol: string, options?: { filePath?: string; includeDeclaration?: boolean; limit?: number }): Promise<string>;
  searchDocs(query: string): Promise<SearchResult[]>;
  status(): Promise<EngineStatus>;
  index(dirs?: string[]): Promise<void>;
  close(): Promise<void>;
}

/**
 * Stub engine that returns placeholder data.
 * This is the "dummy backend" for Milestone 1 — gets swapped for real
 * implementations as later milestones land.
 */
export class StubEngine implements Engine {
  async search(query: string, options?: { limit?: number; minScore?: number }): Promise<SearchResult[]> {
    return [
      {
        filePath: "src/example.ts",
        startLine: 1,
        endLine: 10,
        content: `// Placeholder result for query: "${query}"`,
        score: 0.95,
        language: "typescript",
        repoId: "stub-repo",
      },
    ];
  }

  async findFiles(pattern: string): Promise<string[]> {
    return [`src/placeholder-match-for-${pattern}`];
  }

  async getSymbols(query: { name?: string; filePath?: string; kind?: string; limit?: number }): Promise<SymbolInfo[]> {
    return [
      {
        name: query.name ?? "exampleFunction",
        kind: "function",
        filePath: query.filePath ?? "src/example.ts",
        startLine: 1,
        endLine: 15,
        repoId: "stub-repo",
      },
    ];
  }

  async getFileSummary(filePath: string): Promise<string> {
    return `Summary of ${filePath}:\n- This is a placeholder summary\n- Real implementation in Milestone 3+`;
  }

  async getRecentChanges(options?: string | { query?: string; limit?: number; since?: string }): Promise<string> {
    const query = typeof options === "string" ? options : options?.query;
    return `Recent changes${query ? ` related to "${query}"` : ""}:\n- (placeholder — git history indexing not yet implemented)`;
  }

  async getDependencies(filePath: string, _options?: { recursive?: boolean; maxFiles?: number }): Promise<string> {
    return `Dependencies for ${filePath}:\n- (placeholder — dependency analysis not yet implemented)`;
  }

  async findImporters(target: string): Promise<string> {
    return `Importers for ${target}:\n- (placeholder — reverse dependency search not yet implemented)`;
  }

  async findReferences(symbol: string): Promise<string> {
    return `References for ${symbol}:\n- (placeholder — reference search not yet implemented)`;
  }

  async searchDocs(query: string): Promise<SearchResult[]> {
    return [];
  }

  async status(): Promise<EngineStatus> {
    return {
      indexing: false,
      repos: [],
      embeddingModel: "none (stub)",
      workerBusy: false,
    };
  }

  async index(): Promise<void> {
    // No-op in stub
  }

  async close(): Promise<void> {
    // No-op
  }
}
