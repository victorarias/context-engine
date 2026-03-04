# Python Language Intelligence Plan

Status: **in progress** (phases 1-3 + phase 4 core + phase 5 core implemented; includes PEP 420 namespace handling, multiline `__all__` chunk/symbol support, conditional-import confidence tagging, and `sys.path` literal-hint resolution)

## Problem

Context-engine has deep TS/JS intelligence (full compiler API, import graph, symbol
declarations, reference finding) and decent Go support, but Python is second-class.
Testing against a real Python project ([ReMe](https://github.com/zouyingcao/ReMe), 366 `.py` files)
exposed these gaps:

| Feature | TS/JS | Go | Python today | Gap |
|---|---|---|---|---|
| **AST chunking** | ✅ tree-sitter + baseline | ✅ tree-sitter + baseline | ✅ tree-sitter + baseline | Minor — misses decorators, nested classes |
| **Symbol extraction** | ✅ TS compiler declarations | ✅ regex | ⚠️ regex only | No method parent tracking, no decorator capture |
| **Dependency extraction** | ✅ TS compiler resolution | ✅ go.mod aware | ⚠️ regex — no resolution | `from .core import X` → raw `.core`, not resolved path |
| **Dependency classification** | ✅ internal/external | ✅ internal/stdlib/external | ❌ all shown as external | `classifyDependencyKind` doesn't know Python conventions |
| **Import graph (importers)** | ✅ full forward+reverse | ❌ | ❌ | `findImporters` returns 0 results for `.py` files |
| **Reference finding** | ✅ TS compiler find-refs | — heuristic | ⚠️ heuristic only | Works but noisy, no declaration awareness |
| **File summary** | ✅ | ✅ | ⚠️ | 0 symbols when index still building (race) |

## Approach: Tree-sitter + custom resolver (no language server)

### Why not pyright/pylsp?

We considered using pyright (available on npm) or pylsp as a language server:

- **pyright npm**: No programmatic API. It's a CLI/LSP binary only. We'd need to spawn
  a subprocess, speak LSP protocol, manage lifecycle — heavy for what we need.
  Also requires a Python environment to be configured (`venv`, `pythonPath`) to resolve
  third-party imports, which is user-friction for a "zero-config" tool.
- **pylsp**: Python-only, same subprocess/LSP overhead.
- **Neither is needed**: Python's import system is simpler than TS's. Unlike TS (which
  needs `tsconfig.json`, path aliases, `baseUrl`, project references, `.d.ts` resolution),
  Python imports follow a straightforward algorithm:
  - Relative imports use dots + `__init__.py` packages
  - Absolute imports resolve against the package root
  - No aliases, no remapping, no declaration files

We already have **tree-sitter Python** loaded and working. The tree-sitter Python grammar
exposes `import_statement`, `import_from_statement`, `dotted_name`, `relative_import` —
everything we need to build a proper import graph without any external process.

### Why this is analogous to what we did for TS

The `TsDependencyService` (1104 lines) does three things:
1. **Extract edges** — walk the AST for import/export declarations
2. **Resolve specifiers** — map raw specifiers to file paths
3. **Build reverse index** — `importersByTarget`, `importersBySpecifier`, `declarationsBySymbol`

For Python we need the same three steps, but the resolution algorithm is much simpler:
- `.foo` → sibling module in same package
- `..foo` → module in parent package
- `foo.bar` → either stdlib, installed package, or project-local module

We can resolve project-local imports by walking `__init__.py` files in the indexed roots.
Stdlib detection uses a static list. Everything else is "external/third-party" (and we
don't need to resolve those to files).

---

## Design

### New file: `src/engine/py-dependency-service.ts`

Mirrors `TsDependencyService` structure but ~400 lines (Python resolution is simpler).

```
┌─────────────────────────────────────────────────┐
│             PyDependencyService                  │
├─────────────────────────────────────────────────┤
│ rebuild(visiblePyFiles: string[])                │
│ applyDelta({ changed, removed, visible })        │
│ getFileEdges(file): PyDependencyEdge[]           │
│ findImporters(target, opts): string[]            │
│ getStats(): PyDependencyStats                    │
├─────────────────────────────────────────────────┤
│ Private:                                         │
│   extractImports(content, filePath): PyEdge[]    │  ← tree-sitter
│   resolveImport(spec, sourceFile): string|null   │  ← custom resolver
│   packageRoots: Map<string, string>              │  ← detected from __init__.py
│   depsByFile: Map<string, PyEdge[]>              │
│   importersByTarget: Map<string, Set<string>>    │
│   importersByModule: Map<string, Set<string>>    │
└─────────────────────────────────────────────────┘
```

### Data model

```typescript
type PyEdgeKind = "import" | "from-import" | "relative-import" | "dynamic";

interface PyDependencyEdge {
  sourceFile: string;           // relative path from root
  rawSpecifier: string;         // e.g. "..core.schema" or "os.path"
  importedNames: string[];      // e.g. ["MemoryNode", "Message"]
  resolvedTarget?: string;      // e.g. "reme/core/schema/__init__.py"
  edgeKind: PyEdgeKind;
  level: number;                // 0 = absolute, 1 = ".", 2 = "..", etc.
  confidence: "high" | "medium" | "low";
  unresolvedReason?: string;
}
```

### Import resolution algorithm

```
resolveImport(specifier, level, sourceFile, roots):

  1. If level > 0 (relative import):
     a. Compute base package from sourceFile path
        - Walk up `level` directory levels from sourceFile's directory
     b. Append dotted module path as subdirectory/file
     c. Check candidates in order:
        - {base}/{module}.py
        - {base}/{module}/__init__.py
     d. If found → return relative path from root, confidence "high"

  2. If level == 0 (absolute import):
     a. Split specifier into parts: "reme.core.schema" → ["reme", "core", "schema"]
     b. Try as project-local first:
        - Walk indexed roots, check {root}/{parts[0]}/__init__.py exists
        - If yes → resolve full dotted path to file, confidence "high"
     c. Check against PYTHON_STDLIB set → classify as stdlib, skip resolution
     d. Otherwise → external/third-party, confidence "low"
```

### Package root detection

On `rebuild()`, scan indexed `.py` files for `__init__.py` files to build a package map:

```typescript
// Maps top-level package name → absolute directory
// e.g. "reme" → "/home/user/projects/ReMe/reme"
packageRoots: Map<string, string>
```

This makes absolute import resolution fast: `from reme.core.schema import X`
→ look up `reme` in `packageRoots` → resolve `core/schema` relative to that.

---

## Implementation phases

### Phase 1: Python import extraction via tree-sitter

**Files touched:** `src/engine/py-dependency-service.ts` (new), `src/engine/context-engine.ts`

Use tree-sitter (already loaded for Python) to extract imports from the AST instead of
regex. Tree-sitter node types for Python imports (verified against the grammar):

```
import_statement
  ├── "import" keyword
  ├── dotted_name ("os", "os.path")
  │   └── identifier+ separated by "."
  └── aliased_import ("json as j")
      ├── dotted_name
      └── identifier (alias)

import_from_statement
  ├── "from" keyword
  ├── relative_import              ← present when dots are used
  │   ├── import_prefix (".", "..", "....") — child "." nodes, count = level
  │   └── dotted_name? ("core.schema")     — absent for bare "from . import X"
  ├── OR dotted_name               ← present for absolute "from X import Y"
  ├── "import" keyword
  └── dotted_name+ / aliased_import+ (comma-separated imported names)
```

**Extraction logic:**
- `import_prefix` child count of "." nodes = relative level
- `relative_import > dotted_name` = the module path after the dots
- Top-level `dotted_name` children after `import` keyword = imported names

Extract structured edges:
- `import os` → `{ rawSpecifier: "os", level: 0, edgeKind: "import", importedNames: ["os"] }`
- `from ..core.schema import MemoryNode` → `{ rawSpecifier: "core.schema", level: 2, edgeKind: "relative-import", importedNames: ["MemoryNode"] }`
- `from . import sibling` → `{ rawSpecifier: "", level: 1, edgeKind: "relative-import", importedNames: ["sibling"] }`

**Deliverable:** `extractImports(content, filePath)` returns structured `PyDependencyEdge[]`.

### Phase 2: Python import resolution

**Files touched:** `src/engine/py-dependency-service.ts`

Implement the resolution algorithm above. Key details:

1. **Package root detection** — scan `__init__.py` files in indexed file list
2. **Relative import resolution** — count dots, walk up from source, resolve to file
3. **Absolute import resolution** — match first segment against package roots, then resolve rest
4. **Stdlib detection** — static `Set<string>` of Python stdlib top-level modules
   (frozen per Python version; ~300 entries for 3.10+, can hardcode)
5. **Build reverse index** — `importersByTarget` + `importersByModule` maps (same pattern as TS service)

**Deliverable:** `rebuild()`, `applyDelta()`, `findImporters()`, `getFileEdges()` working.

### Phase 3: Integrate into context-engine

**Files touched:** `src/engine/context-engine.ts`

Wire `PyDependencyService` alongside `TsDependencyService`:

1. **`ensurePyDependencyGraph()`** — analogous to `ensureTsDependencyGraph()`
2. **`getDependencies()`** — for `.py` files, use `pyDeps.getFileEdges()` instead of regex `extractDependencies()`
3. **`findImporters()`** — merge results from `pyDeps.findImporters()` into existing pipeline
4. **`formatDependencyGroups()`** — add Python-aware classification:
   - **Internal** — resolves to a file in the indexed roots
   - **Stdlib** — matches the static stdlib set
   - **External** — everything else (pip packages)
5. **Incremental updates** — feed watcher deltas to `pyDeps.applyDelta()` alongside TS deltas
6. **Status** — include `pyDeps.getStats()` in status output

### Phase 4: Enhanced Python symbol extraction

**Files touched:** `src/chunker/ast-chunker.ts`

Improve tree-sitter Python chunking:

1. **Decorated functions/classes** — include `@decorator` lines in the chunk
2. **Methods** — detect `def` inside `class_definition`, set `symbolKind: "method"` and
   `parentSymbol` to the class name (already done for TS/Go, not Python)
3. **Module-level constants** — `NAME = ...` at top level → `symbolKind: "variable"`
4. **`__all__`** — parse `__all__ = [...]` to understand public API

### Phase 5: Python-aware `classifyDependencyKind`

**Files touched:** `src/engine/context-engine.ts`

Add Python branch to `formatDependencyGroups()` (like Go has `formatGoDependencyGroups()`):

```typescript
function formatPythonDependencyGroups(dependencies, context): string[] {
  // Three groups: Internal, Stdlib, External
  for (const dep of dependencies) {
    if (dep starts with "." or resolves to indexed file) → internal
    else if (PYTHON_STDLIB.has(topLevel(dep))) → stdlib
    else → external
  }
}
```

---

## Stdlib module list

Maintain a static set for Python 3.10+ (the most common baseline). ~300 modules:

```typescript
const PYTHON_STDLIB = new Set([
  "abc", "aifc", "argparse", "array", "ast", "asynchat", "asyncio", "asyncore",
  "atexit", "audioop", "base64", "bdb", "binascii", "binhex", "bisect",
  "builtins", "bz2", "calendar", "cgi", "cgitb", "chunk", "cmath", "cmd",
  "code", "codecs", "codeop", "collections", "colorsys", "compileall",
  "concurrent", "configparser", "contextlib", "contextvars", "copy", "copyreg",
  "cProfile", "crypt", "csv", "ctypes", "curses", "dataclasses", "datetime",
  "dbm", "decimal", "difflib", "dis", "distutils", "doctest", "email",
  "encodings", "enum", "errno", "faulthandler", "fcntl", "filecmp", "fileinput",
  "fnmatch", "fractions", "ftplib", "functools", "gc", "getopt", "getpass",
  "gettext", "glob", "grp", "gzip", "hashlib", "heapq", "hmac", "html",
  "http", "idlelib", "imaplib", "imghdr", "imp", "importlib", "inspect", "io",
  "ipaddress", "itertools", "json", "keyword", "lib2to3", "linecache",
  "locale", "logging", "lzma", "mailbox", "mailcap", "marshal", "math",
  "mimetypes", "mmap", "modulefinder", "multiprocessing", "netrc", "nis",
  "nntplib", "numbers", "operator", "optparse", "os", "ossaudiodev",
  "pathlib", "pdb", "pickle", "pickletools", "pipes", "pkgutil", "platform",
  "plistlib", "poplib", "posix", "posixpath", "pprint", "profile", "pstats",
  "pty", "pwd", "py_compile", "pyclbr", "pydoc", "queue", "quopri",
  "random", "re", "readline", "reprlib", "resource", "rlcompleter", "runpy",
  "sched", "secrets", "select", "selectors", "shelve", "shlex", "shutil",
  "signal", "site", "smtpd", "smtplib", "sndhdr", "socket", "socketserver",
  "sqlite3", "ssl", "stat", "statistics", "string", "stringprep", "struct",
  "subprocess", "sunau", "symtable", "sys", "sysconfig", "syslog",
  "tabnanny", "tarfile", "telnetlib", "tempfile", "termios", "test",
  "textwrap", "threading", "time", "timeit", "tkinter", "token", "tokenize",
  "tomllib", "trace", "traceback", "tracemalloc", "tty", "turtle",
  "turtledemo", "types", "typing", "unicodedata", "unittest", "urllib",
  "uuid", "venv", "warnings", "wave", "weakref", "webbrowser", "winreg",
  "winsound", "wsgiref", "xdrlib", "xml", "xmlrpc", "zipapp", "zipfile",
  "zipimport", "zlib", "_thread",
]);
```

---

## Complexity estimate

| Phase | Effort | Lines (est.) |
|-------|--------|-------------|
| Phase 1: tree-sitter import extraction | Small | ~100 |
| Phase 2: import resolution + reverse index | Medium | ~250 |
| Phase 3: context-engine integration | Medium | ~150 |
| Phase 4: enhanced symbol extraction | Small | ~80 |
| Phase 5: dependency classification | Small | ~50 |
| **Total** | | **~630** |

Compare: `ts-dependency-service.ts` is 1104 lines, but handles vastly more complexity
(tsconfig resolution, path aliases, project references, re-exports, type-only imports,
TS Program caching for find-references). Python needs none of that.

---

## Testing strategy

### Unit tests (`tests/unit/py-dependency-service.test.ts`)

1. **Import extraction** — verify tree-sitter extraction for:
   - `import os`
   - `import os.path`
   - `from os import path`
   - `from . import sibling`
   - `from ..core.schema import MemoryNode`
   - `from ....deeply.nested import X` (4 dots)
   - `import json as j`
   - `from collections import defaultdict, Counter`

2. **Import resolution** — verify path resolution for:
   - Relative imports at various levels
   - Absolute imports matching project packages
   - Stdlib detection (os, sys, pathlib → stdlib)
   - Third-party detection (pydantic, numpy → external)

3. **Reverse index** — verify `findImporters()` for:
   - File that is imported by many others (e.g. `reme/core/schema/memory_node.py`)
   - File imported via `__init__.py` re-export
   - File not imported by anyone

### Integration tests (`tests/integration/py-dependency.test.ts`)

Use the ReMe project (or a synthetic fixture) to verify end-to-end:
- `getDependencies("reme/reme.py")` returns internal/stdlib/external groups correctly
- `findImporters("reme/core/schema/memory_node.py")` finds 14+ importers
- Incremental update: add a new import to a file, verify graph updates

### Eval test

Run against ReMe and compare `findImporters` output against `grep -r` ground truth.

---

## Open questions

1. **`setup.py` / `pyproject.toml` package detection** — should we parse these to find
   package roots, or is `__init__.py` scanning sufficient? Leaning toward `__init__.py`
   only for v1 (simpler, works for all projects).

2. **Namespace packages** (PEP 420 — packages without `__init__.py`) — **implemented in current rollout**
   via directory-backed namespace resolution (`ns_pkg/tools` style modules resolve as internal targets).

3. **Conditional imports** (`try: import X except: import Y`) — **implemented in current rollout**.
   We include both edges, downgrade confidence one level, and annotate unresolved reasons
   with `conditional import context` for transparency.

4. **`sys.path` manipulation** — some projects do `sys.path.insert(...)`. Ignore for v1.
