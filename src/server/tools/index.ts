/**
 * Canonical MCP tool names exposed by this server.
 * Keeping these centralized avoids drift between docs/tests/server registration.
 */
export const TOOL_NAMES = [
  "semantic_search",
  "find_files",
  "get_symbols",
  "get_file_summary",
  "get_recent_changes",
  "get_dependencies",
  "search_docs",
  "code_sandbox",
  "status",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];
