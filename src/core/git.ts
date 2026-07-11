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
