import { Language, Parser } from "web-tree-sitter";
import { fileURLToPath } from "node:url";

export type TreeSitterLanguage = "typescript" | "javascript" | "python" | "go" | "rust" | "kotlin";

const LANGUAGE_TO_WASM_CANDIDATES: Record<TreeSitterLanguage, string[]> = {
  typescript: [
    "@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm",
    "tree-sitter-wasms/out/tree-sitter-typescript.wasm",
  ],
  javascript: [
    "@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm",
    "tree-sitter-wasms/out/tree-sitter-javascript.wasm",
  ],
  python: [
    "@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm",
    "tree-sitter-wasms/out/tree-sitter-python.wasm",
  ],
  go: [
    "@vscode/tree-sitter-wasm/wasm/tree-sitter-go.wasm",
    "tree-sitter-wasms/out/tree-sitter-go.wasm",
  ],
  rust: [
    "@vscode/tree-sitter-wasm/wasm/tree-sitter-rust.wasm",
    "tree-sitter-wasms/out/tree-sitter-rust.wasm",
  ],
  kotlin: [
    "tree-sitter-wasms/out/tree-sitter-kotlin.wasm",
  ],
};

/**
 * Loads and caches tree-sitter parsers (WASM grammars) for supported languages.
 *
 * Loader is best-effort: failures are recorded as warnings and callers can fallback.
 */
export class TreeSitterLoader {
  private parserInitPromise: Promise<void> | null = null;
  private languages = new Map<TreeSitterLanguage, Language>();
  private parsers = new Map<TreeSitterLanguage, Parser>();
  private warnings: string[] = [];

  async warmup(langs: TreeSitterLanguage[] = ["typescript", "javascript", "python", "go", "rust"]): Promise<void> {
    await this.ensureParserRuntime();

    for (const lang of langs) {
      if (this.parsers.has(lang)) continue;

      try {
        const language = await this.loadLanguage(lang);
        const parser = new Parser();
        parser.setLanguage(language);

        this.languages.set(lang, language);
        this.parsers.set(lang, parser);
      } catch (error) {
        this.warnings.push(
          `tree-sitter warmup failed for ${lang}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  getParser(lang: TreeSitterLanguage): Parser | null {
    return this.parsers.get(lang) ?? null;
  }

  isReady(lang: TreeSitterLanguage): boolean {
    return this.parsers.has(lang);
  }

  getWarnings(): string[] {
    return [...this.warnings];
  }

  private async ensureParserRuntime(): Promise<void> {
    if (!this.parserInitPromise) {
      this.parserInitPromise = Parser.init();
    }
    await this.parserInitPromise;
  }

  private async loadLanguage(lang: TreeSitterLanguage): Promise<Language> {
    const candidates = LANGUAGE_TO_WASM_CANDIDATES[lang];
    const errors: string[] = [];

    for (const candidate of candidates) {
      try {
        const wasmUrl = import.meta.resolve(candidate);
        const wasmPath = wasmUrl.startsWith("file://") ? fileURLToPath(wasmUrl) : wasmUrl;
        return await Language.load(wasmPath);
      } catch (error) {
        errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(`No compatible wasm found. Attempts: ${errors.join(" | ")}`);
  }
}
