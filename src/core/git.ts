/**
 * Git access — shell out to the system `git` (ARCHITECTURE.md §1: no libgit2 in
 * v0; the worktree lifecycle must be inspectable with plain git commands). This
 * module holds only what M0 needs (availability + repo detection); mining's
 * history walk and the runner's worktree pool extend it in later milestones.
 *
 * Commands run via Bun.spawn with argv arrays (never a shell string), so repo
 * paths and refs can't be interpreted as shell syntax.
 */

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Run `git <args...>` in `cwd`. Never throws — inspect `ok`/`code`. `env` is
 * merged over the current environment (used by the isolated-workspace builder
 * to pin author/committer identity and dates).
 */
export async function git(args: string[], cwd: string, env?: Record<string, string>): Promise<GitResult> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      ...(env ? { env: { ...process.env, ...env } } : {}),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { ok: code === 0, stdout, stderr, code };
  } catch (err) {
    // Spawn itself failed — git not on PATH, cwd gone, etc.
    return { ok: false, stdout: "", stderr: (err as Error).message, code: null };
  }
}

/** Is the `git` binary available at all? */
export async function gitAvailable(): Promise<boolean> {
  const r = await git(["--version"], process.cwd());
  return r.ok;
}

/** Is `dir` inside a git work tree? */
export async function isGitRepo(dir: string): Promise<boolean> {
  const r = await git(["rev-parse", "--is-inside-work-tree"], dir);
  return r.ok && r.stdout.trim() === "true";
}

/** The absolute root of the work tree containing `dir`, or null if none. */
export async function repoRoot(dir: string): Promise<string | null> {
  const r = await git(["rev-parse", "--show-toplevel"], dir);
  return r.ok ? r.stdout.trim() : null;
}

/** Run `git <args...>` in `cwd`, feeding `stdin` to the process (for `git apply`). */
export async function gitStdin(args: string[], cwd: string, stdin: string): Promise<GitResult> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { ok: code === 0, stdout, stderr, code };
  } catch (err) {
    return { ok: false, stdout: "", stderr: (err as Error).message, code: null };
  }
}

/**
 * Pinned git config + flags for EVERY diff-producing invocation. A user's
 * global/local git config must never change the bytes Guignet stores or
 * applies: `diff.noprefix=true` yields diffs `git apply -p1` rejects,
 * `color.ui=always` injects ANSI escapes, `diff.mnemonicPrefix` swaps a/b for
 * i/w/c, `diff.external` hands output to a foreign tool, `diff.relative` strips
 * a directory prefix, and `core.quotepath` C-quotes non-ASCII names. The `-c`
 * pins override config of any scope; the explicit flags override it again for
 * the prefixes and the external driver.
 */
const DIFF_CONFIG = [
  "-c", "diff.noprefix=false",
  "-c", "diff.mnemonicPrefix=false",
  "-c", "diff.relative=false",
  "-c", "diff.renames=true",
  "-c", "color.ui=never",
  "-c", "color.diff=never",
  "-c", "core.quotepath=false",
];
const DIFF_FLAGS = ["--no-ext-diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/"];

/** `git diff` with config + output format pinned (see DIFF_CONFIG). */
export function gitDiff(args: string[], cwd: string): Promise<GitResult> {
  return git(["--literal-pathspecs", ...DIFF_CONFIG, "diff", ...DIFF_FLAGS, ...args], cwd);
}

/** One commit's metadata (first-parent view). */
export interface CommitMeta {
  sha: string;
  /** First parent, or null for a root commit (no parent to diff against). */
  parentSha: string | null;
  /** Author date, ISO-8601 (`%aI`). Used for contamination cutoff splits (§7). */
  isoDate: string;
  subject: string;
  body: string;
  authorEmail: string;
}

// Field/record separators for robust log parsing — commit bodies contain
// newlines, so we delimit with control chars that can't appear in the fields.
const FS = "\x1f"; // unit separator between fields
const RS = "\x1e"; // record separator between commits

/**
 * Walk history newest-first over every non-merge commit. `--no-merges` (rather
 * than `--first-parent`) is deliberate: the mineable, task-shaped work — a fix
 * plus the tests that prove it — lives in the individual commits, which a
 * first-parent walk hides behind merge commits. Each commit is later diffed
 * against its single parent (`%P`). When `subdir` is set (monorepo, §3), only
 * commits that touched that path are returned. `limit` caps the walk (1000).
 */
export async function listCommits(
  repoRoot: string,
  opts: { subdir?: string; limit?: number } = {},
): Promise<CommitMeta[]> {
  const fmt = ["%H", "%P", "%aI", "%s", "%ae", "%b"].join(FS) + RS;
  // `log.showSignature` would print gpg output ahead of every record and corrupt the parse.
  const args = ["-c", "log.showSignature=false", "log", "--no-merges", `--max-count=${opts.limit ?? 1000}`, `--format=${fmt}`];
  if (opts.subdir) args.push("--", opts.subdir);
  const r = await git(args, repoRoot);
  if (!r.ok) return [];
  const out: CommitMeta[] = [];
  for (const record of r.stdout.split(RS)) {
    const rec = record.replace(/^\n/, "");
    if (!rec.trim()) continue;
    const [sha, parents, isoDate, subject, authorEmail, ...bodyParts] = rec.split(FS);
    if (!sha) continue;
    const firstParent = (parents ?? "").trim().split(/\s+/)[0] || null;
    out.push({
      sha,
      parentSha: firstParent,
      isoDate: isoDate ?? "",
      subject: subject ?? "",
      authorEmail: authorEmail ?? "",
      body: (bodyParts.join(FS) ?? "").replace(/\n+$/, ""),
    });
  }
  return out;
}

export interface ChangedFile {
  /** git status letter: A/M/D/R/C/T… (first char; renames keep the new path). */
  status: string;
  path: string;
}

/**
 * Files changed between `parentSha` and `sha`, optionally scoped to `subdir`.
 * Parsed from `--name-status -z`: NUL-delimited and never C-quoted, so
 * non-ASCII (and tab/newline/quote-bearing) names come back verbatim and work
 * as pathspecs. Records are `STATUS\0path\0`; renames/copies (R100, C75) carry
 * TWO paths — `STATUS\0old\0new\0` — and we report the new one.
 */
export async function changedFiles(
  repoRoot: string,
  parentSha: string,
  sha: string,
  subdir?: string,
): Promise<ChangedFile[]> {
  const args = ["--name-status", "-z", parentSha, sha];
  if (subdir) args.push("--", subdir);
  const r = await gitDiff(args, repoRoot);
  if (!r.ok) return [];
  const files: ChangedFile[] = [];
  const tokens = r.stdout.split("\0");
  for (let i = 0; i < tokens.length; ) {
    const statusTok = tokens[i++];
    if (!statusTok) continue; // trailing empty token after the final NUL
    const status = statusTok[0] ?? "?";
    const twoPaths = status === "R" || status === "C";
    const first = tokens[i++];
    const path = twoPaths ? tokens[i++] : first;
    if (path) files.push({ status, path });
  }
  return files;
}

/** Unified diff of `paths` between `parentSha` and `sha`. Empty string if none. */
export async function fileDiff(
  repoRoot: string,
  parentSha: string,
  sha: string,
  paths: readonly string[],
): Promise<string> {
  if (paths.length === 0) return "";
  const r = await gitDiff([parentSha, sha, "--", ...paths], repoRoot);
  return r.ok ? r.stdout : "";
}

export interface NumStat {
  path: string;
  added: number;
  deleted: number;
}

/** Per-file added/deleted line counts between `parentSha` and `sha` for `paths`. */
export async function numstat(
  repoRoot: string,
  parentSha: string,
  sha: string,
  paths: readonly string[],
): Promise<NumStat[]> {
  if (paths.length === 0) return [];
  // -z: NUL-delimited and unquoted. A record is `added\tdeleted\tpath\0`; a
  // rename/copy is `added\tdeleted\t\0old\0new\0` (empty path field, then both).
  const r = await gitDiff(["--numstat", "-z", parentSha, sha, "--", ...paths], repoRoot);
  if (!r.ok) return [];
  const out: NumStat[] = [];
  const tokens = r.stdout.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;
    const [added, deleted, ...rest] = tok.split("\t");
    let path = rest.join("\t");
    if (path === "") {
      i++; // rename/copy: skip the old path, keep the new one
      path = tokens[++i] ?? "";
    }
    out.push({
      // Binary files report "-"; count them as 0 changed lines.
      added: added === "-" ? 0 : Number(added) || 0,
      deleted: deleted === "-" ? 0 : Number(deleted) || 0,
      path,
    });
  }
  return out;
}

/** Add a detached worktree checked out at `sha` under `dest`. */
export function worktreeAdd(repoRoot: string, sha: string, dest: string): Promise<GitResult> {
  return git(["worktree", "add", "--detach", "--force", dest, sha], repoRoot);
}

/** Remove a worktree previously added at `dest` (forced — it has uncommitted diffs). */
export function worktreeRemove(repoRoot: string, dest: string): Promise<GitResult> {
  return git(["worktree", "remove", "--force", dest], repoRoot);
}

/** Apply a unified diff to a worktree via `git apply` (paths are repo-root relative). */
export function applyDiff(worktreeDir: string, diffText: string): Promise<GitResult> {
  return gitStdin(["apply", "--whitespace=nowarn"], worktreeDir, diffText);
}

/**
 * Capture everything an agent changed in a worktree as one unified diff vs the
 * checked-out base — modifications, additions, AND deletions. `git add -A` first
 * so brand-new files (untracked) appear in the diff, which a plain `git diff`
 * would miss; then diff the index against HEAD (the base commit). Non-mutating
 * to the real checkout — this only ever runs inside a disposable worktree.
 */
export async function captureWorktreeDiff(worktreeDir: string): Promise<string> {
  await git(["add", "-A"], worktreeDir);
  // `--binary` emits a full binary patch (with the index line), so a solution
  // that touches a binary file still APPLIES at score time — an abbreviated
  // binary diff is rejected by `git apply` ("cannot apply binary patch … without
  // full index line").
  const r = await gitDiff(["--cached", "--binary", "HEAD"], worktreeDir);
  return r.ok ? r.stdout : "";
}

/** Fixed identity + timestamp for the snapshot root commit, so two exports of
 * the same base commit produce the SAME root commit id (deterministic). */
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "guignet",
  GIT_AUTHOR_EMAIL: "guignet@local",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "guignet",
  GIT_COMMITTER_EMAIL: "guignet@local",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};

/**
 * Build an ISOLATED workspace for an agent: the tree of `sha` exported into a
 * fresh directory `dest` (which must not exist yet) and committed as the single
 * ROOT commit of a brand-new repository. This is the leak firewall's answer to
 * `git worktree add`: a linked worktree shares the source repo's object store
 * and `.git` points back at it, so an agent could `git log --all` its way to
 * the held-out fix commit, or follow `.git`/`git worktree list` to the main
 * checkout where `.guignet/tasks/<id>/truth/` lives. Here there is nothing to
 * find: the new repo contains exactly one commit, no remote, no alternates, no
 * `commondir`/`gitdir` link — `.git` is a real, self-contained directory.
 *
 * Export is `read-tree` into a TEMPORARY index file + `checkout-index`, so the
 * source repo's own index, HEAD and worktree are never touched (and
 * `export-ignore`/`export-subst` attributes, which `git archive` would honor,
 * cannot silently drop files from the base the verifier is judged against).
 * The checkout filters (autocrlf, LFS) apply exactly as they do for a worktree.
 *
 * Hooks are neutralised (empty hooksPath, `--no-verify`), signing is off, and
 * the identity/dates are pinned, so user git config cannot change the result.
 * The new repo's local config keeps those safe defaults for the agent's own
 * commits too. Never throws — returns `{ ok:false, error }` instead.
 */
export async function createIsolatedWorkspace(
  repoRoot: string,
  sha: string,
  dest: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { mkdir, rm } = await import("node:fs/promises");
  const indexFile = `${dest}.index`;
  const hooksDir = `${dest}.nohooks`;
  const fail = (step: string, r: GitResult): { ok: false; error: string } => ({
    ok: false,
    error: `${step} failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`,
  });
  try {
    await mkdir(dest, { recursive: true });
    await mkdir(hooksDir, { recursive: true });

    // 1. Export the tree of `sha` (temp index; the source repo is read-only here).
    const prefix = dest.replaceAll("\\", "/").replace(/\/?$/, "/");
    const idxEnv = { GIT_INDEX_FILE: indexFile };
    const rt = await git(["read-tree", sha], repoRoot, idxEnv);
    if (!rt.ok) return fail("read-tree", rt);
    const co = await git(["checkout-index", "-a", "-f", `--prefix=${prefix}`], repoRoot, idxEnv);
    if (!co.ok) return fail("checkout-index", co);

    // 2. A brand-new repo with safe local defaults. `--template=` skips the
    // user's init.templateDir (and its hooks); the branch name is set via
    // symbolic-ref so it works on git < 2.28 too.
    const init = await git(["init", "-q", "--template="], dest);
    if (!init.ok) return fail("init", init);
    await git(["symbolic-ref", "HEAD", "refs/heads/guignet-base"], dest);
    const cfg: [string, string][] = [
      ["core.hooksPath", hooksDir],
      ["commit.gpgsign", "false"],
      ["tag.gpgsign", "false"],
      ["core.fsmonitor", "false"],
      ["user.name", "guignet"],
      ["user.email", "guignet@local"],
    ];
    for (const [k, v] of cfg) await git(["config", k, v], dest);

    // 3. One root commit of everything exported. `-f`: every file on disk came
    // from the tracked tree, so a user's global excludesFile must not be able
    // to leave one untracked (its later edits would vanish from the diff).
    const add = await git(["add", "-A", "-f"], dest);
    if (!add.ok) return fail("add", add);
    const commit = await git(
      ["commit", "-q", "--no-verify", "--allow-empty", "--no-gpg-sign", "-m", "guignet: task base snapshot"],
      dest,
      SNAPSHOT_IDENTITY,
    );
    if (!commit.ok) return fail("commit", commit);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    await rm(indexFile, { force: true }).catch(() => {});
    await rm(hooksDir, { recursive: true, force: true }).catch(() => {});
  }
}
