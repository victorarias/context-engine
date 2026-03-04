import { readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { DEFAULT_IGNORE_DIRS } from "../sources/local-fs.js";

export type WatchChangeKind = "added" | "modified" | "deleted";

export interface WatchChange {
  root: string;
  path: string;
  kind: WatchChangeKind;
}

export interface WorktreeWatcherOptions {
  roots: string[];
  onChange: (changes: WatchChange[]) => Promise<void> | void;
  debounceMs?: number;
  pollIntervalMs?: number;
  ignoreNames?: string[];
  ignorePaths?: string[];
}

const DEFAULT_IGNORE_NAMES = DEFAULT_IGNORE_DIRS;

interface FileEntry {
  signature: string;
}

export class WorktreeWatcher {
  private readonly roots: string[];
  private readonly onChange: (changes: WatchChange[]) => Promise<void> | void;
  private readonly debounceMs: number;
  private readonly pollIntervalMs: number;
  private readonly ignoreNames: Set<string>;
  private readonly ignorePaths: string[];

  private readonly snapshots = new Map<string, Map<string, FileEntry>>();
  private readonly pendingChanges = new Map<string, WatchChange>();

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private emitting = false;

  constructor(options: WorktreeWatcherOptions) {
    this.roots = options.roots.map((root) => resolve(root));
    this.onChange = options.onChange;
    this.debounceMs = Math.max(25, options.debounceMs ?? 250);
    this.pollIntervalMs = Math.max(50, options.pollIntervalMs ?? 750);
    this.ignoreNames = new Set([...(options.ignoreNames ?? []), ...DEFAULT_IGNORE_NAMES]);
    this.ignorePaths = (options.ignorePaths ?? []).map((path) => resolve(path));
  }

  async start(): Promise<void> {
    if (this.running) return;

    for (const root of this.roots) {
      this.snapshots.set(root, this.scanRoot(root));
    }

    this.running = true;
    this.pollTimer = setInterval(() => {
      this.poll().catch(() => {
        // suppress watcher loop errors to keep server alive
      });
    }, this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.pendingChanges.clear();
  }

  isRunning(): boolean {
    return this.running;
  }

  private async poll(): Promise<void> {
    if (!this.running || this.emitting) return;

    let detectedNewChanges = false;

    for (const root of this.roots) {
      const previous = this.snapshots.get(root) ?? new Map<string, FileEntry>();
      const next = this.scanRoot(root);
      if (this.collectDiff(root, previous, next)) {
        detectedNewChanges = true;
      }
      this.snapshots.set(root, next);
    }

    if (this.pendingChanges.size > 0 && (detectedNewChanges || !this.debounceTimer)) {
      this.scheduleEmit();
    }
  }

  private collectDiff(
    root: string,
    previous: Map<string, FileEntry>,
    next: Map<string, FileEntry>,
  ): boolean {
    let changed = false;

    for (const [path, entry] of next.entries()) {
      const prev = previous.get(path);
      if (!prev) {
        changed = this.queueChange({ root, path, kind: "added" }) || changed;
        continue;
      }

      if (prev.signature !== entry.signature) {
        changed = this.queueChange({ root, path, kind: "modified" }) || changed;
      }
    }

    for (const path of previous.keys()) {
      if (!next.has(path)) {
        changed = this.queueChange({ root, path, kind: "deleted" }) || changed;
      }
    }

    return changed;
  }

  private queueChange(change: WatchChange): boolean {
    const key = `${change.root}::${change.path}`;
    const previous = this.pendingChanges.get(key);
    this.pendingChanges.set(key, change);

    if (!previous) return true;
    return previous.kind !== change.kind;
  }

  private scheduleEmit(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.emitChanges().catch(() => {
        // suppress callback errors from breaking watcher loop
      });
    }, this.debounceMs);
  }

  private async emitChanges(): Promise<void> {
    if (!this.running || this.pendingChanges.size === 0) return;

    const changes = Array.from(this.pendingChanges.values())
      .sort((a, b) => a.path.localeCompare(b.path));

    this.pendingChanges.clear();
    this.emitting = true;

    try {
      await this.onChange(changes);
    } finally {
      this.emitting = false;
    }
  }

  private scanRoot(root: string): Map<string, FileEntry> {
    const out = new Map<string, FileEntry>();

    walk(root, {
      root,
      ignoreNames: this.ignoreNames,
      ignorePaths: this.ignorePaths,
      out,
    });

    return out;
  }
}

function walk(
  dir: string,
  context: {
    root: string;
    ignoreNames: Set<string>;
    ignorePaths: string[];
    out: Map<string, FileEntry>;
  },
): void {
  let entries: ReturnType<typeof readdirSync>;

  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);

    if (shouldIgnore(entry.name, fullPath, context.ignoreNames, context.ignorePaths)) {
      continue;
    }

    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      walk(fullPath, context);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    const rel = normalizePath(relative(context.root, fullPath));
    context.out.set(rel, {
      signature: `${stat.mtimeMs}:${stat.size}`,
    });
  }
}

function shouldIgnore(name: string, fullPath: string, ignoreNames: Set<string>, ignorePaths: string[]): boolean {
  if (ignoreNames.has(name)) return true;

  const normalized = resolve(fullPath);
  for (const ignorePath of ignorePaths) {
    if (normalized === ignorePath || normalized.startsWith(`${ignorePath}/`)) {
      return true;
    }
  }

  return false;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}
