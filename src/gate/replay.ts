/**
 * Validity replay (ARCHITECTURE.md §5) — prove one task is SOUND before it may
 * enter the suite. A task is sound iff its held-out verifier FAILS at the base
 * commit (the bug is really present) k times AND PASSES once the real fix is
 * applied k times. Any deviation or flake ⇒ discard, never patch (CLAUDE.md
 * hard invariant; §12 non-goal).
 *
 * One throwaway git worktree per task, checked out at the base commit. Setup
 * (dependency install) runs ONCE; between every replay we reset to a pristine
 * base state that PRESERVES installed deps — git worktrees do not inherit
 * node_modules, so re-installing per replay would be slow and, for a hung
 * install, a manufactured flake. The reset (resetWorktree) keeps node_modules
 * and strips everything else — tracked edits, diff-added files, and gitignored
 * test artifacts alike — so no stale state leaks between replays.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyDiff,
  git,
  runShell,
  worktreeAdd,
  worktreeRemove,
  type Config,
  type Gate,
  type Task,
} from "../core/index.ts";
// readTruth is imported BY NAME, directly from core/truth.ts (never via the
// barrel): the leak firewall (§5) permits gate/ to read ground truth, and the
// boundary check requires the named, direct import so the read/write split
// stays statically checkable.
import { readTruth } from "../core/truth.ts";


/**
 * Reset the worktree to a PRISTINE base checkout while KEEPING installed deps.
 * `reset --hard` reverts tracked files the applied diffs touched; `clean -fdx`
 * removes every untracked file the previous replay left — including gitignored
 * artifacts a test run creates (scratch DBs, coverage, build output) that would
 * otherwise leak into the next replay and manufacture a flake. `-e node_modules`
 * is the one exception: it preserves the one-time setup install (git worktrees
 * don't inherit node_modules, so re-installing per replay would be slow and a
 * hung install would itself read as a flake). The excludes are load-bearing
 * precisely because `-x` would otherwise remove node_modules too.
 *
 * Known limitation: only `node_modules` is preserved, so a non-JS repo whose
 * deps or setup artifacts live in-tree under another name (Python `.venv`, a
 * gitignored build dir a test needs) would have them wiped between replays. The
 * direction is fail-safe — such a task fails at fix and is conservatively
 * DISCARDED, never wrongly admitted — but it caps yield on those ecosystems. A
 * future `preservePaths` config knob widens the exclude set; the v0 dogfood
 * corpus is bun-backend, where `node_modules` is the whole story.
 */
async function resetWorktree(worktreeDir: string): Promise<void> {
  await git(["reset", "--hard", "HEAD"], worktreeDir);
  await git(["clean", "-fdx", "-e", "node_modules"], worktreeDir);
}

/** Collapse whitespace and cap a captured stderr/stdout snippet for a reason string. */
function snippet(s: string, max = 200): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/**
 * Replay one task and return its gate verdict (this function does NOT persist —
 * the caller writes gate.json). Owns the full worktree lifecycle: it always
 * removes the worktree and its temp dir, even on a thrown error, so a large
 * suite can't leak worktrees.
 */
export async function replayTask(repoRoot: string, task: Task, config: Config): Promise<Gate> {
  const k = config.gateReplays;
  const timeoutMs = config.verifierTimeoutMs;
  const truth = await readTruth(repoRoot, task.id);
  const verifierCmd = task.verifierCmd;

  // `git worktree add` wants a NON-existent target, so we point it INSIDE the
  // mkdtemp dir rather than at the mkdtemp dir itself.
  const tmp = await mkdtemp(join(tmpdir(), "guignet-gate-"));
  const worktreeDir = join(tmp, "wt");
  // Monorepo (§3): setup/verifier run with the package root as cwd; reset/clean/
  // apply always act on the worktree root (git has no partial worktrees).
  const worktreeSubdir = config.subdir ? join(worktreeDir, config.subdir) : worktreeDir;

  const verdict = (
    admitted: boolean,
    failAtBase: number,
    passAtFix: number,
    discardReason: string | null,
  ): Gate => ({ taskId: task.id, admitted, replays: { failAtBase, passAtFix, k }, discardReason });

  try {
    const add = await worktreeAdd(repoRoot, task.baseSha, worktreeDir);
    if (!add.ok) {
      return verdict(false, 0, 0, `could not create worktree at ${task.baseSha}: ${snippet(add.stderr)}`);
    }

    // Setup once — the worktree didn't inherit the repo's node_modules.
    if (config.setupCmd) {
      const setup = await runShell(config.setupCmd, { cwd: worktreeSubdir, timeoutMs });
      if (setup.timedOut) return verdict(false, 0, 0, "setup timed out");
      if (setup.code !== 0) return verdict(false, 0, 0, `setup failed: ${snippet(setup.stderr || setup.stdout)}`);
    }

    // Fail-at-base: apply the verifier (tests only, NOT the fix) and expect the
    // suite to fail — the bug is unfixed. A zero exit or a timeout is wrong.
    let failAtBase = 0;
    for (let i = 0; i < k; i++) {
      await resetWorktree(worktreeDir);
      const applied = await applyDiff(worktreeDir, truth.verifierDiff);
      if (!applied.ok) return verdict(false, failAtBase, 0, `git apply failed for verifier diff: ${snippet(applied.stderr)}`);
      const r = await runShell(verifierCmd, { cwd: worktreeSubdir, timeoutMs });
      if (r.timedOut) return verdict(false, failAtBase, 0, "verifier timed out at base");
      // A null exit code means the process was killed/crashed by signal (OOM,
      // spawn failure) — an ENVIRONMENT problem, NOT the held-out test detecting
      // the bug. Counting it as a "fail" would admit a task on a non-assertion
      // failure. Require a genuine non-zero exit (an actual test failure).
      if (r.code === null) return verdict(false, failAtBase, 0, "verifier could not run at base (killed/crashed)");
      if (r.code !== 0) failAtBase++;
    }
    if (failAtBase !== k) {
      return verdict(false, failAtBase, 0, `verifier passed at base on ${k - failAtBase}/${k} replays (expected fail)`);
    }

    // Pass-at-fix: apply the verifier AND the fix and expect a clean pass.
    let passAtFix = 0;
    for (let i = 0; i < k; i++) {
      await resetWorktree(worktreeDir);
      const v = await applyDiff(worktreeDir, truth.verifierDiff);
      if (!v.ok) return verdict(false, failAtBase, passAtFix, `git apply failed for verifier diff: ${snippet(v.stderr)}`);
      const f = await applyDiff(worktreeDir, truth.fixDiff);
      if (!f.ok) return verdict(false, failAtBase, passAtFix, `git apply failed for fix diff: ${snippet(f.stderr)}`);
      const r = await runShell(verifierCmd, { cwd: worktreeSubdir, timeoutMs });
      if (r.timedOut) return verdict(false, failAtBase, passAtFix, "verifier timed out at fix");
      if (r.code === null) return verdict(false, failAtBase, passAtFix, "verifier could not run at fix (killed/crashed)");
      if (r.code === 0) passAtFix++;
    }
    if (passAtFix !== k) {
      return verdict(false, failAtBase, passAtFix, `verifier failed at fix on ${k - passAtFix}/${k} replays (expected pass)`);
    }

    return verdict(true, failAtBase, passAtFix, null);
  } finally {
    // Always tear down — a worktree leak across a large suite is a real bug.
    await worktreeRemove(repoRoot, worktreeDir);
    await rm(tmp, { recursive: true, force: true });
  }
}
