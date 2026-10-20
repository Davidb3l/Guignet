import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyDiff,
  captureWorktreeDiff,
  changedFiles,
  createIsolatedWorkspace,
  fileDiff,
  git,
  numstat,
  worktreeAdd,
} from "../src/core/git.ts";

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "guignet-git-test-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

/** Read a text file with line endings normalized (Windows autocrlf checks out CRLF). */
async function txt(path: string): Promise<string> {
  return (await readFile(path, "utf-8")).replaceAll("\r\n", "\n");
}

async function must(args: string[], cwd: string): Promise<string> {
  const r = await git(args, cwd);
  if (!r.ok) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A repo with a base commit; the caller adds the "fix" commit on top. */
async function initRepo(): Promise<{ repo: string; base: string }> {
  const repo = await tmp();
  await must(["init", "-q"], repo);
  await must(["config", "user.email", "t@t.co"], repo);
  await must(["config", "user.name", "t"], repo);
  await must(["config", "commit.gpgsign", "false"], repo);
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "a.ts"), "export const x = 1;\n");
  await writeFile(join(repo, "src", "b.ts"), "export const y = 1;\n");
  await must(["add", "-A"], repo);
  await must(["commit", "-qm", "base"], repo);
  return { repo, base: await must(["rev-parse", "HEAD"], repo) };
}

async function commitAll(repo: string, msg: string): Promise<string> {
  await must(["add", "-A"], repo);
  await must(["commit", "-qm", msg], repo);
  return must(["rev-parse", "HEAD"], repo);
}

// --- G4: the agent workspace is isolated from the source repo ---

describe("createIsolatedWorkspace (leak firewall)", () => {
  async function seeded() {
    const { repo, base } = await initRepo();
    // The held-out FIX lives on a later commit and on a side branch.
    await writeFile(join(repo, "a.ts"), "export const x = 2; // THE-SECRET-FIX\n");
    await writeFile(join(repo, "fix-only.ts"), "export const fixed = true;\n");
    const fix = await commitAll(repo, "fix: the real fix");
    await must(["branch", "side", fix], repo);
    await must(["tag", "v-fix", fix], repo);
    const dest = join(await tmp(), "ws");
    const r = await createIsolatedWorkspace(repo, base, dest);
    expect(r).toEqual({ ok: true });
    return { repo, base, fix, dest };
  }

  test("the fix commit's objects are unreachable and history is exactly one commit", async () => {
    const { fix, dest, base } = await seeded();
    expect((await git(["cat-file", "-e", fix], dest)).ok).toBe(false);
    expect((await git(["cat-file", "-e", base], dest)).ok).toBe(false); // even the real base sha is gone
    const all = (await must(["log", "--all", "--format=%H"], dest)).split("\n").filter(Boolean);
    expect(all).toHaveLength(1);
    expect(await must(["rev-list", "--all", "--count"], dest)).toBe("1");
    expect(await must(["branch", "-a", "--format=%(refname)"], dest)).not.toContain("side");
    expect(await must(["tag"], dest)).toBe("");
    // The root commit has no parent.
    expect((await git(["rev-parse", "--verify", "HEAD^"], dest)).ok).toBe(false);
    // No object in the new repo mentions the fix content.
    const objs = await must(["rev-list", "--objects", "--all"], dest);
    expect(objs).not.toContain("fix-only.ts");
  });

  test("there is no path back to the source repo", async () => {
    const { repo, dest } = await seeded();
    const gitDir = join(dest, ".git");
    expect(lstatSync(gitDir).isDirectory()).toBe(true); // a real dir, not a `gitdir:` file
    expect(existsSync(join(gitDir, "commondir"))).toBe(false);
    expect(existsSync(join(gitDir, "gitdir"))).toBe(false);
    expect(existsSync(join(gitDir, "worktrees"))).toBe(false);
    expect(existsSync(join(gitDir, "objects", "info", "alternates"))).toBe(false);
    expect(await must(["remote"], dest)).toBe("");

    const rel = (p: string) => p.replaceAll("\\", "/").toLowerCase();
    const common = await must(["rev-parse", "--git-common-dir"], dest);
    expect(rel(join(dest, common))).toBe(rel(gitDir));
    // The only worktree git knows about is the workspace itself.
    const wt = (await must(["worktree", "list", "--porcelain"], dest)).split("\n").filter((l) => l.startsWith("worktree "));
    expect(wt).toHaveLength(1);
    // Nothing under .git (config included) names the source repo.
    const cfg = await readFile(join(gitDir, "config"), "utf-8");
    expect(rel(cfg)).not.toContain(rel(repo));
  });

  test("the exported tree matches the base commit and starts clean", async () => {
    const { dest } = await seeded();
    expect(await txt(join(dest, "a.ts"))).toBe("export const x = 1;\n");
    expect(existsSync(join(dest, "fix-only.ts"))).toBe(false);
    expect(await txt(join(dest, "src", "b.ts"))).toBe("export const y = 1;\n");
    expect(await must(["status", "--porcelain"], dest)).toBe("");
    // captureWorktreeDiff against the root commit sees only what the agent did.
    expect(await captureWorktreeDiff(dest)).toBe("");
    await writeFile(join(dest, "a.ts"), "export const x = 3;\n");
    await writeFile(join(dest, "new.ts"), "export const z = 1;\n");
    const diff = await captureWorktreeDiff(dest);
    expect(diff).toContain("diff --git a/a.ts b/a.ts");
    expect(diff).toContain("diff --git a/new.ts b/new.ts");
  });

  test("a captured diff applies to a real worktree of the base (the scoring path)", async () => {
    const { repo, base, dest } = await seeded();
    await writeFile(join(dest, "a.ts"), "export const x = 3;\n");
    await writeFile(join(dest, "new.ts"), "export const z = 1;\n");
    const diff = await captureWorktreeDiff(dest);
    const wt = join(await tmp(), "wt");
    expect((await worktreeAdd(repo, base, wt)).ok).toBe(true);
    const applied = await applyDiff(wt, diff);
    expect(applied.ok).toBe(true);
    expect(await txt(join(wt, "a.ts"))).toBe("export const x = 3;\n");
    await git(["worktree", "remove", "--force", wt], repo);
  });

  test("deterministic: exporting the same base twice yields the same root commit", async () => {
    const { repo, base, dest } = await seeded();
    const dest2 = join(await tmp(), "ws2");
    expect((await createIsolatedWorkspace(repo, base, dest2)).ok).toBe(true);
    expect(await must(["rev-parse", "HEAD"], dest2)).toBe(await must(["rev-parse", "HEAD"], dest));
  });

  test("does not touch the source repo's index, HEAD, or worktree", async () => {
    const { repo, base } = await initRepo();
    await writeFile(join(repo, "a.ts"), "export const x = 99; // uncommitted\n");
    const before = await must(["status", "--porcelain"], repo);
    const head = await must(["rev-parse", "HEAD"], repo);
    const dest = join(await tmp(), "ws");
    expect((await createIsolatedWorkspace(repo, base, dest)).ok).toBe(true);
    expect(await must(["status", "--porcelain"], repo)).toBe(before);
    expect(await must(["rev-parse", "HEAD"], repo)).toBe(head);
    expect(await txt(join(repo, "a.ts"))).toContain("uncommitted");
    // ...and the uncommitted edit is NOT in the workspace (it is the base tree).
    expect(await txt(join(dest, "a.ts"))).toBe("export const x = 1;\n");
  });

  test("a bad sha fails cleanly (no throw)", async () => {
    const { repo } = await initRepo();
    const dest = join(await tmp(), "ws");
    const r = await createIsolatedWorkspace(repo, "0".repeat(40), dest);
    expect(r.ok).toBe(false);
  });

  test("export-ignore attributes and a user's global excludes cannot drop tracked files", async () => {
    const repo = await tmp();
    await must(["init", "-q"], repo);
    await must(["config", "user.email", "t@t.co"], repo);
    await must(["config", "user.name", "t"], repo);
    await must(["config", "commit.gpgsign", "false"], repo);
    await writeFile(join(repo, ".gitattributes"), "docs.txt export-ignore\n");
    await writeFile(join(repo, "docs.txt"), "docs\n");
    await writeFile(join(repo, "kept.log"), "tracked despite a global *.log ignore\n");
    const base = await commitAll(repo, "base");

    const gcfgDir = await tmp();
    const excludes = join(gcfgDir, "ignore");
    const gcfg = join(gcfgDir, "gitconfig");
    await writeFile(excludes, "*.log\n");
    await writeFile(gcfg, `[core]\n\texcludesFile = ${excludes.replaceAll("\\", "/")}\n`);
    const prev = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = gcfg;
    try {
      const dest = join(await tmp(), "ws");
      expect((await createIsolatedWorkspace(repo, base, dest)).ok).toBe(true);
      const tracked = (await must(["ls-files"], dest)).split("\n");
      expect(tracked).toContain("docs.txt");
      expect(tracked).toContain("kept.log");
      // A later edit to the tracked-but-globally-ignored file still shows in the diff.
      await writeFile(join(dest, "kept.log"), "edited\n");
      expect(await captureWorktreeDiff(dest)).toContain("kept.log");
    } finally {
      if (prev === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prev;
    }
  });

  test("user hooks (global core.hooksPath) do not run during export", async () => {
    const { repo, base } = await initRepo();
    const hooks = await tmp();
    const marker = join(hooks, "ran.txt");
    const hook = join(hooks, "post-commit");
    await writeFile(hook, `#!/bin/sh\necho ran > "${marker.replaceAll("\\", "/")}"\n`);
    await chmod(hook, 0o755);
    const gcfg = join(await tmp(), "gitconfig");
    await writeFile(gcfg, `[core]\n\thooksPath = ${hooks.replaceAll("\\", "/")}\n`);
    const prev = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = gcfg;
    try {
      const dest = join(await tmp(), "ws");
      expect((await createIsolatedWorkspace(repo, base, dest)).ok).toBe(true);
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prev;
    }
  });
});

// --- G2: diffs are pinned against user git config ---

describe("diff output is immune to user git config", () => {
  async function hostile() {
    const { repo, base } = await initRepo();
    await must(["config", "diff.noprefix", "true"], repo);
    await must(["config", "diff.mnemonicPrefix", "true"], repo);
    await must(["config", "color.ui", "always"], repo);
    await must(["config", "color.diff", "always"], repo);
    await must(["config", "diff.external", "this-command-does-not-exist"], repo);
    await writeFile(join(repo, "a.ts"), "export const x = 2;\n");
    const sha = await commitAll(repo, "change a");
    return { repo, base, sha };
  }

  test("fileDiff keeps a/ b/ prefixes, no ANSI, and applies with -p1", async () => {
    const { repo, base, sha } = await hostile();
    const diff = await fileDiff(repo, base, sha, ["a.ts"]);
    expect(diff).toContain("diff --git a/a.ts b/a.ts");
    expect(diff).toContain("--- a/a.ts");
    expect(diff).toContain("+++ b/a.ts");
    expect(diff).not.toContain("\x1b[");
    // The real consumer: `git apply` (default -p1) on a pristine checkout of base.
    const wt = join(await tmp(), "wt");
    expect((await worktreeAdd(repo, base, wt)).ok).toBe(true);
    const applied = await applyDiff(wt, diff);
    expect(applied.ok).toBe(true);
    expect(await txt(join(wt, "a.ts"))).toBe("export const x = 2;\n");
    await git(["worktree", "remove", "--force", wt], repo);
  });

  test("captureWorktreeDiff is likewise pinned", async () => {
    const { repo, base } = await hostile();
    const wt = join(await tmp(), "wt");
    expect((await worktreeAdd(repo, base, wt)).ok).toBe(true);
    await writeFile(join(wt, "a.ts"), "export const x = 7;\n");
    await writeFile(join(wt, "n.ts"), "export const n = 1;\n");
    const diff = await captureWorktreeDiff(wt);
    expect(diff).toContain("diff --git a/a.ts b/a.ts");
    expect(diff).toContain("diff --git a/n.ts b/n.ts");
    expect(diff).not.toContain("\x1b[");
    // Round-trips: the captured diff applies to a pristine base worktree.
    const wt2 = join(await tmp(), "wt2");
    expect((await worktreeAdd(repo, base, wt2)).ok).toBe(true);
    expect((await applyDiff(wt2, diff)).ok).toBe(true);
    await git(["worktree", "remove", "--force", wt], repo);
    await git(["worktree", "remove", "--force", wt2], repo);
  });

  test("sanity: without the pins, this config really does break the diff (the test is not vacuous)", async () => {
    const { repo, base, sha } = await hostile();
    const raw = await git(["-c", "diff.external=", "diff", base, sha], repo);
    expect(raw.stdout).not.toContain("diff --git a/a.ts b/a.ts");
  });
});

// --- G3: non-ASCII paths survive changedFiles / numstat / fileDiff ---

describe("changedFiles with unusual path names (-z parsing)", () => {
  test("a non-ASCII file name comes back verbatim and works as a pathspec", async () => {
    const { repo, base } = await initRepo();
    await writeFile(join(repo, "café.test.ts"), "test('x', () => {});\n");
    const sha = await commitAll(repo, "add café test");
    const files = await changedFiles(repo, base, sha);
    expect(files).toEqual([{ status: "A", path: "café.test.ts" }]);
    // The pathspec built from it matches (C-quoted `"caf\303\251.test.ts"` matched nothing).
    const diff = await fileDiff(repo, base, sha, files.map((f) => f.path));
    expect(diff).toContain("café.test.ts");
    expect(diff).toContain("+test('x'");
    const stats = await numstat(repo, base, sha, files.map((f) => f.path));
    expect(stats).toEqual([{ path: "café.test.ts", added: 1, deleted: 0 }]);
  });

  test("renames and copies carry two paths; the new path is reported", async () => {
    const { repo } = await initRepo();
    const body = Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n";
    await writeFile(join(repo, "ünï.ts"), body);
    const before = await commitAll(repo, "add unicode file");
    await must(["mv", "ünï.ts", "renamed ümlaut.ts"], repo);
    const after = await commitAll(repo, "rename it");
    const files = await changedFiles(repo, before, after);
    expect(files).toEqual([{ status: "R", path: "renamed ümlaut.ts" }]);
    const stats = await numstat(repo, before, after, files.map((f) => f.path));
    expect(stats.map((s) => s.path)).toContain("renamed ümlaut.ts");
  });

  test("a mix of statuses and a subdir scope parse into one entry per file", async () => {
    const { repo, base } = await initRepo();
    await writeFile(join(repo, "a.ts"), "export const x = 5;\n"); // M
    await writeFile(join(repo, "src", "c.ts"), "export const c = 1;\n"); // A
    await rm(join(repo, "src", "b.ts")); // D
    const sha = await commitAll(repo, "mixed");
    const all = await changedFiles(repo, base, sha);
    expect(all.map((f) => `${f.status}:${f.path}`).sort()).toEqual(["A:src/c.ts", "D:src/b.ts", "M:a.ts"]);
    const scoped = await changedFiles(repo, base, sha, "src");
    expect(scoped.map((f) => `${f.status}:${f.path}`).sort()).toEqual(["A:src/c.ts", "D:src/b.ts"]);
  });
});

// --- inherited GIT_* repo redirection (the git-hook incident class) ---

describe("an inherited GIT_DIR / GIT_WORK_TREE never redirects Guignet's own git calls", () => {
  const SAVED = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  afterEach(() => {
    for (const [k, v] of Object.entries(SAVED)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("git() operates on its cwd, and the isolated export never writes into the redirect target", async () => {
    const { repo, base } = await initRepo(); // the repo Guignet is pointed at
    const decoy = await tmp(); // a DIFFERENT repo a hook's GIT_DIR would point at
    await must(["init", "-q"], decoy);
    const decoyGit = join(decoy, ".git");
    const configBefore = await readFile(join(decoyGit, "config"), "utf-8");

    process.env.GIT_DIR = decoyGit;
    process.env.GIT_WORK_TREE = decoy;

    // Plain git(): rev-parse in `repo` must see `repo`, not the decoy.
    const top = await git(["rev-parse", "--show-toplevel"], repo);
    expect(top.ok).toBe(true);
    // realpath both sides: macOS tmpdir is a symlink (/var -> /private/var).
    const norm = async (p: string) => (await realpath(p)).replaceAll("\\", "/").toLowerCase();
    expect(await norm(top.stdout.trim())).toBe(await norm(repo));

    // The export runs `git init/config/add/commit` inside `dest`; none of that
    // may land in the decoy repo (config rewritten, commits made).
    const dest = join(await tmp(), "ws");
    const r = await createIsolatedWorkspace(repo, base, dest);
    expect(r).toEqual({ ok: true });
    delete process.env.GIT_DIR;
    delete process.env.GIT_WORK_TREE;
    expect(await readFile(join(decoyGit, "config"), "utf-8")).toBe(configBefore);
    expect((await git(["rev-list", "--all", "--count"], decoy)).stdout.trim()).toBe("0");
    // ...and the workspace is its own repo with exactly the snapshot commit.
    expect((await git(["rev-list", "--all", "--count"], dest)).stdout.trim()).toBe("1");
  });
});
