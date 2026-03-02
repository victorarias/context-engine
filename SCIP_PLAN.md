# SCIP Integration Plan (Future Work)

Status: planned, not implemented.

## Why SCIP later

Current direction is local-first, zero-config indexing with fast incremental updates.
SCIP should be added as an **optional precision layer** for references/call-graph quality,
not as a mandatory indexing path.

## Goals

1. Improve reference/definition precision for large Go and polyglot repos.
2. Keep baseline workflow unchanged when SCIP/indexers are unavailable.
3. Preserve current latency for semantic search + file/symbol tooling.

## Non-goals

- Replacing existing chunk/vector pipeline.
- Requiring build success for all indexing.
- Making SCIP mandatory for basic tool operation.

## Architecture fit

SCIP data should be a sidecar store used by precision tools (`find_references`, future impact analysis), while:
- semantic search remains vector/index based
- chunking remains available as fallback

## Milestones

### M0 — Design + data model
- Define SQLite tables for SCIP symbols/occurrences/relationships.
- Define repo/worktree + commit compatibility rules.
- Define merge policy when both SCIP and heuristic results exist.

Exit criteria:
- ADR approved for storage schema and query semantics.

### M1 — Optional ingestion pipeline
- Add config block:
  - `scip.enabled`
  - `scip.indexers` (per language)
  - `scip.onFailure` (`warn|disable|fail`)
- Add ingestion command hooks (manual first):
  - read SCIP index files
  - validate and persist into sidecar tables

Exit criteria:
- Ingestion works on sample Go repo without affecting existing index commands.

### M2 — Query integration (read path)
- Add backend arbitration for references:
  1) SCIP if available/fresh
  2) language service (e.g. gopls)
  3) heuristic fallback
- Add status visibility:
  - SCIP freshness per repo
  - active backend per language

Exit criteria:
- `find_references` returns SCIP-backed results when available, fallback otherwise.

### M3 — Freshness + incremental updates
- Track commit/HEAD affinity for SCIP snapshots.
- Mark SCIP data stale on repo changes.
- Optional background refresh orchestration.

Exit criteria:
- stale/fresh behavior is explicit and test-covered.

## Risks

- Indexer/toolchain drift across languages.
- Build-dependent failures in partially broken repos.
- Storage bloat for large monorepos.

## Mitigations

- Make SCIP strictly optional.
- Preserve non-SCIP fallback paths.
- Add per-language toggles and clear status diagnostics.

## Success metrics

- Higher precision@k for `find_references` on benchmark repos.
- Lower false-positive rate vs heuristic mode.
- No regression in baseline startup/indexing UX when SCIP disabled.
