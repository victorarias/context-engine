export { LocalFileScanner } from "./local-fs.js";
export {
  detectGitWorktree,
  listGitWorktrees,
  getHeadTreeManifest,
  getDirtyPaths,
  isGitRepository,
  type HeadTreeEntry,
} from "./git-worktree.js";
export {
  getRecentGitChanges,
  type GitHistoryEntry,
  type GitHistoryQueryOptions,
} from "./git-history.js";
export {
  fetchDocument,
  chunkDocument,
  type FetchedDocument,
} from "./doc-fetcher.js";
