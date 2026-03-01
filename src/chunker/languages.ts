export const AST_SUPPORTED_LANGUAGES = new Set([
  "typescript",
  "javascript",
  "python",
  "go",
  "rust",
  "kotlin",
]);

export function supportsAstChunking(language: string): boolean {
  return AST_SUPPORTED_LANGUAGES.has(language);
}
