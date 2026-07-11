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

/** Run `git <args...>` in `cwd`. Never throws — inspect `ok`/`code`. */
export async function git(args: string[], cwd: string): Promise<GitResult> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
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
  const args = ["log", "--no-merges", `--max-count=${opts.limit ?? 1000}`, `--format=${fmt}`];
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

/** Files changed between `parentSha` and `sha`, optionally scoped to `subdir`. */
export async function changedFiles(
  repoRoot: string,
  parentSha: string,
  sha: string,
  subdir?: string,
): Promise<ChangedFile[]> {
  const args = ["diff", "--name-status", parentSha, sha];
  if (subdir) args.push("--", subdir);
  const r = await git(args, repoRoot);
  if (!r.ok) return [];
  const files: ChangedFile[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0]?.[0] ?? "?";
    // Renames/copies (R100, C75) carry old\tnew — the changed path is the last field.
    const path = parts[parts.length - 1];
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
  const r = await git(["diff", parentSha, sha, "--", ...paths], repoRoot);
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
  const r = await git(["diff", "--numstat", parentSha, sha, "--", ...paths], repoRoot);
  if (!r.ok) return [];
  const out: NumStat[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [added, deleted, ...rest] = line.split("\t");
    out.push({
      // Binary files report "-"; count them as 0 changed lines.
      added: added === "-" ? 0 : Number(added) || 0,
      deleted: deleted === "-" ? 0 : Number(deleted) || 0,
      path: rest.join("\t"),
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
  const r = await git(["diff", "--cached", "HEAD"], worktreeDir);
  return r.ok ? r.stdout : "";
}
