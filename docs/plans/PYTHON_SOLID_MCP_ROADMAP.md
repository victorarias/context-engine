# Python Solid MCP Roadmap

Status: **in progress (M1–M4 largely implemented; M5 quality-gate automation in progress)**
Owner: context-engine
Scope: Python intelligence stack (`get_dependencies`, `find_importers`, `find_references`, symbol/package surface, status/SLIs)

---

## 1) Goal

Move Python support from "works well in many cases" to **high-trust MCP quality** suitable for refactoring and production engineering workflows.

### Quality bar (target)

- `get_dependencies`: **High trust**
- `find_importers`: **High trust**
- `find_references` (Python): **High trust** (semantic-first, heuristic fallback)
- `status`: metrics must reflect true internal quality (not blended/noisy aggregates)
- Outputs include backend + confidence + caveats so users know what they can trust

---

## 2) Current strengths and gaps (from verification feedback)

## Strengths (retain)

- Relative import resolution is strong
- PEP 420 namespace support implemented
- Conditional import context tagging implemented
- `sys.path` literal hint resolution implemented
- Internal/stdlib/external grouping works

## Gaps (must address)

1. Python `find_references` still heuristic/noisy for common symbols
2. Package alias/environment resolution incomplete (`flowllm`-style cross-package aliasing)
3. `__init__.py` API surface underrepresented in symbol tools
4. Status KPIs are partially misleading (overall resolution mixes internal+stdlib+external)
5. Tool output has remaining noise (self-edges/non-code importers in some paths)

---

## 3) Architecture changes

## A. Python semantic backend abstraction

Add a dedicated interface for Python symbol/reference providers.

```ts
interface PythonSemanticProvider {
  name: "static" | "jedi" | "pyright";
  warmup(): Promise<void>;
  findReferences(input: {
    symbol: string;
    filePath?: string;
    includeDeclaration?: boolean;
    limit: number;
  }): Promise<{
    backend: string;
    confidence: "high" | "medium" | "low";
    references: string[];
    reason?: string;
    candidates?: string[];
  }>;

  findDefinitions?(input: { symbol: string; filePath?: string; limit: number }): Promise<...>;
}
```

### Provider strategy

- **Phase 1 provider:** `static` (existing graph + improved structural heuristics)
- **Phase 2 provider:** `jedi-daemon` (primary semantic backend)
- **Optional phase 3:** `pyright-lsp` provider for type-heavy codebases

Selection policy:
1) explicit configured backend
2) auto: jedi if available, else static
3) always fall back to heuristic with explicit warning

---

## B. Python package/environment resolver layer

Add a resolver that unifies package mapping and environment context.

Responsibilities:
- Parse `pyproject.toml` for package metadata
- Infer local package roots (`setuptools.packages.find`, `project.name`)
- Support alias map (config + discovered)
- Support editable installs / local path hints
- Classify each import edge as:
  - internal
  - stdlib
  - third-party
  - alias-resolved
  - unresolved

This resolver becomes the single source used by:
- `PyDependencyService`
- dependency grouping logic
- importer matching
- status KPIs

---

## C. Symbol model upgrade for package API surfaces

`__init__.py` files define API; treat them as first-class symbol producers.

Enhancements:
- Index re-export symbols from:
  - `from .x import Y`
  - `from .x import *` (tagged as wildcard export)
  - `__all__` literals/multiline blocks
- Add symbol metadata (`origin`, `isReExport`, `exportedFrom`)
- Add schema versioning + migration trigger for symbols

---

## D. Observability and trust contract

Status output should separate quality signals:

- `pyGraph.overallResolutionRate`
- `pyGraph.internalResolutionRate` (**primary KPI**)
- `pyGraph.unresolvedInternalEdges`
- `pyGraph.stdlibEdges`
- `pyGraph.externalEdges`
- `pyRefs.semanticBackendUsageRate`
- `pyRefs.heuristicFallbackRate`
- per-tool latency p50/p95 + sample counts

All user-visible reference/dependency responses should include backend metadata.

---

## 4) Milestones

## Milestone M1 — Reference trust foundation (2–4 days)

### Deliverables

1. `PythonSemanticProvider` abstraction
2. static provider integration in `find_references`
3. noise controls in fallback references:
   - avoid comments/docstrings where possible
   - prefer call-site shaped matches over plain token matches
4. self-edge filtering + non-code importer filtering in importer output

### Acceptance criteria

- `find_references` response always states backend + confidence
- false positives reduced on common names (`execute`, `run`, `main`) in synthetic fixtures
- importer output excludes self-file and non-code files by default

---

## Milestone M2 — Package resolver correctness (3–5 days)

### Deliverables

1. `python-package-resolver.ts` module
2. pyproject parsing and package root inference
3. alias map support (`python.importAliases` in config)
4. resolver adoption in `PyDependencyService`

### Acceptance criteria

- cross-package alias fixtures resolve as internal/alias-resolved
- internal resolution KPI improves materially on ReMe-like fixtures
- unresolved reasons are explicit and categorized

---

## Milestone M3 — Jedi semantic backend (4–7 days)

### Deliverables

1. `python-jedi-provider.ts` process manager/daemon
2. backend selection and fallback policy
3. semantic references for Python files (definition-anchored when possible)

### Acceptance criteria

- `find_references` for common methods is scoped and substantially less noisy
- fallback rate metric available in status
- graceful degradation when Jedi unavailable

---

## Milestone M4 — Package API symbol parity (2–4 days)

### Deliverables

1. re-export symbol extraction in `__init__.py`
2. symbol schema versioning + migration trigger
3. `get_file_summary`/`get_symbols` show package API symbols

### Acceptance criteria

- barrel files no longer appear as symbol-black-holes
- `__all__` entries visible in symbol tools
- migration path tested on existing metadata stores

---

## Milestone M5 — Quality gates and release criteria (2–3 days)

### Deliverables

1. fixture repos + golden outputs
2. adversarial suite automation
3. CI thresholds for correctness + latency

### Acceptance criteria

- regressions on fixture outputs fail CI
- internal resolution and reference precision tracked over time
- p50/p95 regression budget enforced per tool

## Execution status (Mar 2026)

- ✅ **M1 landed**
  - `PythonSemanticProvider` contract added and wired into Python `find_references`
  - backend/confidence/fallback metadata now included in responses
  - static backend noise controls added (doc/comment suppression, call-shape preference)
  - importer defaults filter self-edges + non-code files

- ✅ **M2 landed**
  - `python-package-resolver` + `pyproject-parser` added
  - config-driven + pyproject-driven alias mapping (`python.importAliases`)
  - alias-aware Python dependency resolution integrated; status now reports alias-resolved edges

- ✅ **M3 landed**
  - Jedi provider integrated with backend selection/fallback
  - status now exposes backend usage counters + fallback rates
  - graceful degrade to static/heuristic confirmed
  - dedicated CI Jedi gate added (`python-jedi` job, `bun run test:jedi`)

- ✅ **M4 landed**
  - `__init__.py` re-export symbols surfaced in symbol tools
  - symbol schema versioning + migration/refresh trigger implemented
  - Python method symbol parity improved in fallback extractor

- ✅ **M5 landed**
  - fixture/golden automation added (`tests/fixtures/python/solid-mcp-repo`, `tests/eval/python-mcp-golden.v1.json`, `tests/eval/python-mcp-golden.test.ts`)
  - adversarial regression suite added (`tests/regression/python-adversarial-suite.test.ts`)
  - warm latency p95 quality gates added for Python MCP tools (`tests/benchmarks/python-tool-latency-bench.test.ts`)
  - quality pipeline enforces these via `test:quality` in CI

### Latest external verification feedback loop (Claude, non-interactive)

- Confirmed improvements:
  - importer-noise regression for re-exported modules fixed (e.g. `memory_chunk.py` down to direct importers)
  - `find_references` now reports backend/fallback reasons consistently
  - `src/` path handling improved with canonicalization + actionable hints
  - method symbols (`kind=method`) now returned
- Remaining high-priority gap:
  - optional importer transitive re-export tracing policy (`__init__.py` bridge) is still conservative by default

---

## 5) File-level implementation map

## New files

- `src/engine/python-semantics/provider.ts`
- `src/engine/python-semantics/static-provider.ts`
- `src/engine/python-semantics/jedi-provider.ts`
- `src/engine/python-resolver/python-package-resolver.ts`
- `src/engine/python-resolver/pyproject-parser.ts`
- `tests/unit/python-package-resolver.test.ts`
- `tests/unit/python-semantics-provider.test.ts`
- `tests/integration/python-references.test.ts`
- `tests/fixtures/python/*` (multi-repo fixtures)

## Existing files to modify

- `src/engine/context-engine.ts`
  - route Python refs through provider abstraction
  - backend metadata in responses
  - importer filtering defaults
- `src/engine/py-dependency-service.ts`
  - use package resolver abstraction
  - emit richer edge classification/reasons
- `src/types.ts`
  - extend status contract with Python reference/dependency KPIs
- `src/server/mcp-server.ts`
  - render extended status metrics

---

## 6) Configuration additions

Proposed config keys:

```json
{
  "python": {
    "referencesBackend": "auto", // auto|static|jedi|pyright
    "importAliases": {
      "flowllm.core": "reme.core"
    },
    "excludeImporterExtensions": [".md", ".txt"],
    "showSelfEdges": false,
    "jedi": {
      "pythonExecutable": "python3",
      "projectRoot": ".",
      "requestTimeoutMs": 4000
    }
  }
}
```

---

## 7) Evaluation suite design

## Fixture repos (must-have)

1. Relative imports depth and package boundaries
2. Conditional + `TYPE_CHECKING` imports
3. Barrel `__init__.py` with multiline `__all__`
4. PEP 420 namespace packages
5. Alias-mapped multi-package repo
6. `sys.path` manipulation patterns
7. Circular imports + lazy imports

## Golden checks

- `get_dependencies`: exact grouped outputs (Internal/Stdlib/External/Alias)
- `find_importers`: no self/no markdown noise by default
- `find_references`: precision/recall thresholds for labeled symbols
- `status`: internal vs overall KPIs consistent

## KPIs

- `pyGraph.internalResolutionRate` target: **>85%** on fixture suites
- `find_references` false-positive rate target: **<15%** on common symbol set
- `find_references` semantic-backend usage target: **>80%** when backend available
- latency guardrails (warm, p95):
  - `get_dependencies` < 50ms
  - `find_importers` < 250ms
  - `find_references` < 400ms (static) / < 700ms (jedi)

---

## 8) Risks and mitigations

1. **Jedi dependency drift / env mismatch**
   - Mitigation: provider health checks + explicit fallback + status reporting

2. **Resolver complexity across packaging styles**
   - Mitigation: resolver contract + fixture-first test design

3. **Schema migration surprises**
   - Mitigation: versioned symbol schema + deterministic reindex path

4. **Latency regressions from semantic backend**
   - Mitigation: timeout budget + caching + p95 CI thresholds

---

## 9) Definition of done (solid MCP)

Python support is "solid" when all below are true:

- `find_references` uses semantic backend by default when available
- common-name reference queries are reliable for refactoring tasks
- alias/namespace/relative imports resolve consistently in dependency graph
- package API symbols are visible in symbol tools
- status exposes internal-quality KPIs and fallback rates clearly
- fixture + adversarial suites gate merges in CI

---

## 10) Immediate next execution step

Post-M5 follow-ups:

- Decide and document policy toggle for transitive importer tracing through `__init__.py` re-exports
- Add longer-running real-repo fixture sweeps (nightly) in addition to synthetic latency gates
