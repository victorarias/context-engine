export const AST_SUPPORTED_LANGUAGES = new Set([
  "typescript",
  "javascript",
  "python",
]);

export function supportsAstChunking(language: string): boolean {
  return AST_SUPPORTED_LANGUAGES.has(language);
}
