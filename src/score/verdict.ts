/**
 * Verifier replay — the PRIMARY, judge-free verdict (ARCHITECTURE.md §5). For
 * ONE attempt: does the agent's solution make the held-out verifier pass?
 *
 * Fresh worktree at the task's base commit → apply the agent's `solution.diff`
 * → apply the held-out `verifier.diff` (the tests) → run `task.verifierCmd`.
 * Pass = exit 0 with no timeout. Binary and objective; no LLM judge ever sees
 * this path (§9 wedge). The secondary contamination metrics (bloat, similarity,
 * cutoff era, regurgitation flag) need only the diffs + registry, so they are
 * computed with NO worktree.
 *
 * This mirrors gate/replay.ts: it owns the full worktree lifecycle for a single
 * unit of work and ALWAYS tears the worktree down in a `finally`, so a large
 * run can't leak worktrees. The key difference from gate is one attempt (not k
 * replays), and a distinct fail-safe direction: gate is conservative about
 * ADMITTING a task, whereas here every un-judgeable condition (diff won't apply,
 * setup fails, verifier crashes/hangs) resolves to `passed:false` — the agent
 * gets no credit for a solution we could not objectively verify.
 *
 * Worktree-per-attempt (not per-task): attempts of one task share a base commit
 * and could share a worktree with a reset between, saving repeated setup. We
 * deliberately take the simpler, self-contained path — one throwaway worktree
 * per attempt — so this function stays a pure, independently-testable unit and
 * the orchestrator (index.ts) never has to manage worktree lifetimes. The cost
 * is re-running `setupCmd` per attempt; for the v0 dogfood corpus setup is a
 * cache-warm `bun install`. A future optimization can pool per task.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyDiff,
  classifyEra,
  git,
  runShell,
  worktreeAdd,
  worktreeRemove,
  type Config,
  type CutoffEra,
  type Task,
  type Verdict,
} from "../core/index.ts";
// readTruth is imported BY NAME, directly from core/truth.ts (never via the
// barrel): the leak firewall (§5) permits score/ to read ground truth, and the
// boundary check requires the named, direct import so the read/write split
// stays statically checkable.
import { readTruth } from "../core/truth.ts";
import { bloatRatio, diffSimilarity, isRegurgitation } from "./contamination.ts";

/** What replayVerdict needs to score one attempt. */
export interface VerdictInputs {
  task: Task;
  attempt: number;
  /** The agent's produced diff for this attempt ("" when it produced nothing). */
  solutionDiff: string;
  /** The run model's training cutoff (ISO), or null when it isn't in the
   * registry — resolved once by the orchestrator and passed in. */
  cutoffIso: string | null;
}

/** A verdict plus a non-persisted reason for the orchestrator's stderr log.
 * `note` never enters verdict.json (the schema is frozen and has no reason
 * field); it only enriches human/-v progress output. */
export interface VerdictResult {
  verdict: Verdict;
  note: string | null;
}

/**
 * Reset a fresh worktree to a PRISTINE base checkout while KEEPING installed
 * deps — identical rationale to gate/replay.ts: `-e node_modules` preserves the
 * one-time setup install (git worktrees don't inherit node_modules) while
 * `clean -fdx` strips every other untracked artifact. On a fresh worktree this
 * is a near no-op, but it also erases any stray file `setupCmd` wrote outside
 * node_modules, guaranteeing the verifier sees only base + solution + verifier.
 */
async function resetWorktree(worktreeDir: string): Promise<void> {
  await git(["reset", "--hard", "HEAD"], worktreeDir);
  await git(["clean", "-fdx", "-e", "node_modules"], worktreeDir);
}

/** Collapse whitespace and cap a captured stderr/stdout snippet for a note. */
function snippet(s: string, max = 200): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/**
 * Replay one attempt and return its verdict (this function does NOT persist —
 * the caller writes verdict.json). Computes the secondary metrics from the
 * diffs + truth (no worktree), then runs the verifier for the primary pass/fail.
 * Throws only if ground truth can't be read; the caller treats that as an
 * un-scoreable attempt (passed:false).
 */
export async function replayVerdict(
  repoRoot: string,
  config: Config,
  inputs: VerdictInputs,
): Promise<VerdictResult> {
  const { task, attempt, solutionDiff, cutoffIso } = inputs;
  const timeoutMs = config.verifierTimeoutMs;

  const truth = await readTruth(repoRoot, task.id);
  const era: CutoffEra = classifyEra(task.date, cutoffIso);

  // Secondary metrics — pure functions of the diffs + truth + registry, so they
  // need no worktree and are computed the same whether or not the verifier runs.
  const similarity = diffSimilarity(solutionDiff, truth.fixDiff);
  const bloat = bloatRatio(solutionDiff, truth.fixDiff);
  const regurgitationFlag = isRegurgitation(similarity, era);

  const verdict = (passed: boolean): Verdict => ({
    taskId: task.id,
    attempt,
    passed,
    bloatRatio: bloat,
    similarity,
    regurgitationFlag,
    cutoffEra: era,
  });

  // The agent produced nothing — there is nothing to verify. Resolve to a fail
  // WITHOUT spawning a worktree (the whole apply→run path would be moot).
  if (solutionDiff.trim() === "") {
    return { verdict: verdict(false), note: "empty solution diff (agent produced nothing)" };
  }

  // `git worktree add` wants a NON-existent target, so we point it INSIDE the
  // mkdtemp dir rather than at the mkdtemp dir itself.
  const tmp = await mkdtemp(join(tmpdir(), "guignet-score-"));
  const worktreeDir = join(tmp, "wt");
  // Monorepo (§3): the package root; reset/clean/apply always act on the
  // worktree root (git has no partial worktrees).
  const worktreeSubdir = config.subdir ? join(worktreeDir, config.subdir) : worktreeDir;
  // Where setup + verifier RUN — the package root, or the worktree root for a
  // workspace test runner (config.testCwd "repo"). MUST match gate/replay.ts, or
  // score would judge with a different verifier cwd than the gate validated.
  const execCwd = config.testCwd === "repo" ? worktreeDir : worktreeSubdir;

  try {
    const add = await worktreeAdd(repoRoot, task.baseSha, worktreeDir);
    if (!add.ok) {
      return { verdict: verdict(false), note: `could not create worktree at ${task.baseSha}: ${snippet(add.stderr)}` };
    }

    // Mirror the gate/run guard: if the mined `subdir` is absent at this base
    // (a target-repo history rewrite between gate and score), bail with a clear
    // note instead of spawning setup/verifier into a non-existent cwd (the
    // cryptic "posix_spawn 'sh' ENOENT"). Un-scoreable ⇒ passed:false (fail-safe).
    if (config.subdir && !existsSync(worktreeSubdir)) {
      return { verdict: verdict(false), note: `subdir '${config.subdir}' does not exist at base commit ${task.baseSha.slice(0, 10)}` };
    }

    // Setup once — the worktree didn't inherit the repo's node_modules. Setup
    // failing means we can't stand the environment up to judge the solution, so
    // the attempt is un-scoreable ⇒ passed:false (fail-safe direction).
    if (config.setupCmd) {
      const setup = await runShell(config.setupCmd, { cwd: execCwd, timeoutMs });
      if (setup.timedOut) return { verdict: verdict(false), note: "setup timed out" };
      if (setup.code !== 0) return { verdict: verdict(false), note: `setup failed: ${snippet(setup.stderr || setup.stdout)}` };
    }

    // Pristine base (see resetWorktree) before applying the agent's work.
    await resetWorktree(worktreeDir);

    // Apply the AGENT's solution first. If it doesn't apply, the diff is unusable
    // (stale, malformed, or against the wrong base) ⇒ no credit, and we stop —
    // there is nothing to run.
    const sol = await applyDiff(worktreeDir, solutionDiff);
    if (!sol.ok) {
      return { verdict: verdict(false), note: `agent solution diff did not apply: ${snippet(sol.stderr)}` };
    }

    // Then overlay the held-out verifier (the tests). If THIS fails to apply,
    // the agent's solution collided with the held-out tests — it edited files
    // the verifier also touches. We can't render an honest verdict ⇒ fail.
    const ver = await applyDiff(worktreeDir, truth.verifierDiff);
    if (!ver.ok) {
      return { verdict: verdict(false), note: `held-out verifier diff did not apply over the solution: ${snippet(ver.stderr)}` };
    }

    // The primary verdict: run the held-out verifier. Pass iff it exits 0 within
    // the timeout. A timeout or a null exit (killed/crashed — an environment
    // problem, not a passing test) is NOT a pass.
    const r = await runShell(task.verifierCmd, { cwd: execCwd, timeoutMs });
    if (r.timedOut) return { verdict: verdict(false), note: "verifier timed out" };
    if (r.code === null) return { verdict: verdict(false), note: "verifier could not run (killed/crashed)" };
    const passed = r.code === 0;
    return { verdict: verdict(passed), note: passed ? null : `verifier failed (exit ${r.code})` };
  } finally {
    // Always tear down — a worktree leak across a large run is a real bug.
    await worktreeRemove(repoRoot, worktreeDir);
    await rm(tmp, { recursive: true, force: true });
  }
}
