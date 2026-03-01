import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { TempDir } from "../harness/temp-dir.js";
import {
  detectGitWorktree,
  getHeadTreeManifest,
  listGitWorktrees,
} from "../../src/sources/git-worktree.js";
import { ConfigSchema } from "../../src/config.js";
import { ContextEngine } from "../../src/engine/context-engine.js";

describe("Git worktree support", () => {
  const dirs: TempDir[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      dir.cleanup();
    }
  });

  it("detects worktrees and branch-specific HEAD manifests", async () => {
    const tmp = TempDir.create("ce-git-wt");
    dirs.push(tmp);

    const { mainPath, featurePath } = createRepoWithFeatureWorktree(tmp.path);

    const mainInfo = detectGitWorktree(mainPath);
    const featureInfo = detectGitWorktree(featurePath);

    expect(mainInfo).not.toBeNull();
    expect(featureInfo).not.toBeNull();
    expect(mainInfo!.repoId).toBe(featureInfo!.repoId);
    expect(mainInfo!.worktreeId).not.toBe(featureInfo!.worktreeId);
    expect(mainInfo!.branch).toContain("main");
    expect(featureInfo!.branch).toContain("feature");

    const listed = listGitWorktrees(mainPath);
    expect(listed.length).toBeGreaterThanOrEqual(2);
    expect(listed.some((w) => w.path === mainInfo!.path)).toBe(true);
    expect(listed.some((w) => w.path === featureInfo!.path)).toBe(true);

    const mainManifest = getHeadTreeManifest(mainPath);
    const featureManifest = getHeadTreeManifest(featurePath);

    const mainApp = mainManifest.find((e) => e.path === "src/app.ts");
    const featureApp = featureManifest.find((e) => e.path === "src/app.ts");

    expect(mainApp).toBeDefined();
    expect(featureApp).toBeDefined();
    expect(mainApp!.blobHash).not.toBe(featureApp!.blobHash);
  });

  it("deduplicates shared blobs across sibling worktrees", async () => {
    const tmp = TempDir.create("ce-wt-dedup");
    dirs.push(tmp);

    const { mainPath, featurePath } = createRepoWithFeatureWorktree(tmp.path, {
      featureToken: null,
    });

    const mainOnlyConfig = ConfigSchema.parse({
      sources: [{ path: mainPath }],
      dataDir: join(tmp.path, "data-main-only"),
      embedding: {
        provider: "local",
        localBackend: "mock",
        dimensions: 64,
      },
    });

    const mainOnlyEngine = await ContextEngine.create(mainOnlyConfig);
    await mainOnlyEngine.index();
    const mainOnlyChunks = (await mainOnlyEngine.status()).repos[0]?.chunksStored ?? 0;
    await mainOnlyEngine.close();

    const bothConfig = ConfigSchema.parse({
      sources: [{ path: mainPath }, { path: featurePath }],
      dataDir: join(tmp.path, "data-both"),
      embedding: {
        provider: "local",
        localBackend: "mock",
        dimensions: 64,
      },
    });

    const bothEngine = await ContextEngine.create(bothConfig);
    await bothEngine.index();
    const bothChunks = (await bothEngine.status()).repos[0]?.chunksStored ?? 0;

    expect(mainOnlyChunks).toBeGreaterThan(0);
    expect(bothChunks).toBe(mainOnlyChunks);

    await bothEngine.close();
  });

  it("keeps search results isolated per worktree", async () => {
    const tmp = TempDir.create("ce-wt-search");
    dirs.push(tmp);

    const { mainPath, featurePath } = createRepoWithFeatureWorktree(tmp.path);
    const mainInfo = detectGitWorktree(mainPath)!;
    const featureInfo = detectGitWorktree(featurePath)!;

    const config = ConfigSchema.parse({
      sources: [{ path: mainPath }, { path: featurePath }],
      dataDir: join(tmp.path, "data"),
      embedding: {
        provider: "local",
        localBackend: "mock",
        dimensions: 64,
      },
    });

    const engine = await ContextEngine.create(config);
    await engine.index();

    const mainResults = await engine.search("main-branch-only-token", {
      worktreeId: mainInfo.worktreeId,
      limit: 5,
    });
    expect(mainResults.length).toBeGreaterThan(0);
    expect(mainResults.every((r) => r.worktreeId === mainInfo.worktreeId)).toBe(true);
    expect(mainResults.some((r) => r.content.includes("main-branch-only-token"))).toBe(true);

    const featureResults = await engine.search("feature-branch-only-token", {
      worktreeId: featureInfo.worktreeId,
      limit: 5,
    });
    expect(featureResults.length).toBeGreaterThan(0);
    expect(featureResults.every((r) => r.worktreeId === featureInfo.worktreeId)).toBe(true);
    expect(featureResults.some((r) => r.content.includes("feature-branch-only-token"))).toBe(true);

    // cross-check: main worktree should not leak feature-specific content
    const noLeak = await engine.search("feature-branch-only-token", {
      worktreeId: mainInfo.worktreeId,
      limit: 5,
    });
    expect(noLeak.some((r) => r.content.includes("feature-branch-only-token"))).toBe(false);

    await engine.close();
  });
});

function createRepoWithFeatureWorktree(
  baseDir: string,
  options?: { featureToken?: string | null },
): { mainPath: string; featurePath: string } {
  const mainPath = join(baseDir, "repo-main");
  const featurePath = join(baseDir, "repo-feature");

  mkdirSync(join(mainPath, "src"), { recursive: true });

  runGit(mainPath, ["init"]);
  runGit(mainPath, ["config", "user.email", "test@example.com"]);
  runGit(mainPath, ["config", "user.name", "Test User"]);

  runGit(mainPath, ["checkout", "-b", "main"]);

  writeFileSync(
    join(mainPath, "src", "app.ts"),
    "export const branchToken = 'main-branch-only-token';\n",
  );
  runGit(mainPath, ["add", "."]);
  runGit(mainPath, ["commit", "-m", "main commit"]);

  runGit(mainPath, ["checkout", "-b", "feature/worktree"]);

  const featureToken = options?.featureToken === undefined
    ? "feature-branch-only-token"
    : options.featureToken;
  if (featureToken !== null) {
    writeFileSync(
      join(mainPath, "src", "app.ts"),
      `export const branchToken = '${featureToken}';\n`,
    );
    runGit(mainPath, ["add", "."]);
    runGit(mainPath, ["commit", "-m", "feature commit"]);
  }

  runGit(mainPath, ["checkout", "main"]);
  runGit(mainPath, ["worktree", "add", featurePath, "feature/worktree"]);

  return { mainPath, featurePath };
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
