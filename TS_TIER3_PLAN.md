# TypeScript Tier-3 Dependency Intelligence Plan

Status: planned

## Goal

Deliver production-grade TypeScript dependency intelligence (TS equivalent of gopls-level trust for dependency/refactor workflows) while preserving local-first speed and resilience.

## Scope

- Accurate per-file dependencies in TS/JS monorepos
- Reverse dependency lookup (`find_importers`)
- High-fidelity module resolution (`tsconfig` aware)
- Strong diagnostics/fallback transparency
- Incremental freshness under file changes

## Non-goals (initial rollout)

- Full symbol references for TS (separate later phase)
- Runtime-evaluated dynamic import resolution
- Replacing existing semantic/text indexing pipeline

---

## Architecture

## 1) TS daemon (separate process)

Use a dedicated Node/TypeScript daemon instead of embedding full TS program state in the MCP server process.

Responsibilities:
- Discover and load `tsconfig` graph
- Parse file directives (`preProcessFile` + AST fallback)
- Resolve modules (`resolveModuleName`) with project compiler options
- Maintain forward + reverse dependency graph
- Serve fast query APIs via IPC

Why separate process:
- isolates V8 memory pressure
- prevents TS runtime crashes from taking down MCP server
- allows restarts/recovery without full engine restart

## 2) Data model

Dependency edge:
- `sourceFile`
- `rawSpecifier`
- `resolvedTarget` (or unresolved reason)
- `edgeKind` (`import`, `side-effect`, `reexport`, `type-only`, `dynamic-literal`, `dynamic-unresolved`)
- `projectId`
- `confidence` (`high|medium|low`)

Indexes:
- forward: `file -> edges[]`
- reverse: `target -> importers[]`

## 3) APIs/tools

- `get_dependencies(path|dir, opts)`
- `find_importers(path|specifier, opts)`
- status additions:
  - ts daemon health
  - graph freshness
  - resolution success rate

---

## Phased implementation

## Phase 1 — Resolution core

- tsconfig discovery (`extends`, refs)
- file ownership mapping
- extraction of import/re-export forms
- module resolution with compiler options

Acceptance:
- path aliases (`baseUrl/paths`) resolved
- extension/index resolution stable
- unresolved outputs include reason

## Phase 2 — Reverse deps + incrementality

- reverse index build
- watcher-triggered incremental updates
- rename/delete stale-edge cleanup

Acceptance:
- reverse lookup latency target met
- no stale references after rename/delete

## Phase 3 — Edge semantics hardening

- classify type-only/runtime edges correctly
- better dynamic import classification
- barrel/re-export cycle handling

Acceptance:
- stable `edgeKind` tagging on fixture suite
- confidence labels on unresolved/ambiguous edges

## Phase 4 — TS symbol references (optional)

- selective program creation for targeted refs
- explicit fallback and diagnostics

Acceptance:
- references precision materially above grep in benchmark suite

---

## Edge-case matrix

- multiple tsconfigs owning a file
- pnpm/yarn workspaces and symlinks/realpath normalization
- JS+TS mixed repos (`allowJs`/`checkJs`)
- ESM/CJS interop and package `exports`
- `.d.ts`-only packages
- project references across package boundaries
- generated files / virtual modules
- dynamic imports with template literals
- barrel file cycles
- very large repos (memory guardrails)

---

## Manual verification process (required for rollout)

Run manual verification on a real repo before each phase promotion (default target: `~/projects/exsin`).

## A) Baseline health

1. Start/index with real source roots.
2. Run `status` and confirm:
   - indexed language counts plausible
   - capability flags correct
   - no stale/failed backend indicators

## B) Dependency correctness spot checks

For each class, sample 3–5 files:
- Go package files
- TS app files with relative imports
- TS files with path aliases
- re-export/barrel files

Verify:
- raw specifier is captured
- resolved target matches repo layout
- edge kind is sensible (type-only vs runtime where explicit)

## C) Reverse dependency checks

For selected target files:
- run `find_importers`
- compare with `rg` spot checks
- verify no obvious false negatives in key packages

## D) Change freshness checks

Manual edits in repo:
- rename a file
- move a directory
- change import specifier
- delete file

Then verify graph updates without restart and without stale edges.

## E) Ambiguity/fallback UX checks

Intentionally query ambiguous targets and broken paths.
Confirm output includes:
- requested vs actual backend
- fallback reason
- guidance/candidate suggestions

## F) External-agent usability pass (mandatory)

Run an independent agent pass (Claude) from the target repo:

```bash
cd ~/projects/exsin
claude --dangerously-skip-permissions -p "test the tools from context-engine and give me honest feedback about their usability"
```

Capture:
- top strengths
- top 3 failure modes
- concrete examples
- whether fallback messaging was understandable

Promote phase only after major usability blockers are addressed.

---

## Telemetry/SLIs

Track and alert on:
- resolution success rate
- graph freshness latency (change -> reflected)
- query latency p50/p95 (`get_dependencies`, `find_importers`)
- daemon memory usage
- unresolved edge count by reason
- fallback frequency by tool/backend

---

## Exit criteria for Tier-3

- reverse deps and direct deps are trusted by agents for refactor scoping
- fallback behavior is explicit and actionable
- no critical stale-graph bugs in manual verification suite
- external-agent usability pass reports no high-severity confusion blockers
