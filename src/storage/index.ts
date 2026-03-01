export { SQLiteMetadataStore, type SQLiteMetadataStoreOptions } from "./metadata-store.js";
export { LanceVectorStore, type LanceVectorStoreOptions } from "./vector-store.js";
export { WriteAheadLog, type WriteOperation, type WriteLogEntry } from "./write-log.js";
export { checkStorageConsistency, type ConsistencyReport } from "./consistency-checker.js";
export {
  isSecretPath,
  isUnsafeTraversal,
  isPathInsideRoots,
  normalizePathForLookup,
} from "./security.js";
export { MIGRATIONS, PRAGMAS, STORAGE_SCHEMA_VERSION } from "./schemas.js";
