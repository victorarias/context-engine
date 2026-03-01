import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export class TempDir {
  static create(prefix = "context-engine-test"): TempDir {
    const path = mkdtempSync(join(tmpdir(), `${prefix}-`));
    return new TempDir(path);
  }

  constructor(public readonly path: string) {}

  cleanup(): void {
    if (existsSync(this.path)) {
      rmSync(this.path, { recursive: true, force: true });
    }
  }
}
