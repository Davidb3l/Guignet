/**
 * Verifier replay — the PRIMARY, judge-free verdict (ARCHITECTURE.md §5). For
 * ONE attempt: does the agent's solution make the held-out verifier pass?
 *
 * Fresh worktree at the task's base commit → apply the agent's solution,
 * PROJECTED to its source side (below) → apply the held-out `verifier.diff`
 * (the tests) → run `task.verifierCmd`. Pass = exit 0 with no timeout. Binary
 * and objective; no LLM judge ever sees this path (§9 wedge). The secondary
 * contamination metrics (bloat, similarity, cutoff era, regurgitation flag)
 * need only the diffs + registry, so they are computed with NO worktree.
 *
 * The verifier-authoritative overlay (METHODOLOGY.md §4): agents routinely fix
 * the source AND write their own tests — frequently in the very files the
 * held-out verifier patches (on the zod dogfood corpus, 35/42 non-empty
 * solutions did). A strict `git apply` of the verifier over such a solution
 * fails on hunk-collision LUCK, not fix quality — near-identical attempts of
 * one task flipped pass/fail on whether line numbers happened to collide. So
 * before the overlay, every solution block touching a held-out path (a
 * verifier-diff path, or any test-classified path) is set aside
 * (solution-filter.ts), and the agent is judged on exactly the configuration
 * class the gate validated: base + source-side change + verifier. Its own test
 * edits are neither punished nor rewarded — the verifier is authoritative over
 * its paths, and `verifierCmd` runs those held-out tests, so discarded edits
 * cannot influence the verdict in either direction. This cannot wrongly credit
 * (fail-safe direction preserved): a wrong source fix still fails the verifier;
 * an agent whose ONLY change was test edits has no judgeable work and fails.
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
import { diffFilePaths, stripHeldOutPaths } from "./solution-filter.ts";

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
 * `note` never enters verdict.json (the schema has no free-text reason field —
 * only the structured `testEditsFiltered` flag persists WHY a judged diff may
 * differ from solution.diff); it only enriches human/-v progress output. */
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
async function resetWorktree(worktreeDir: string, preservePaths: readonly string[]): Promise<void> {
  await git(["reset", "--hard", "HEAD"], worktreeDir);
  await git(["clean", "-fdx", "-e", "node_modules", ...preservePaths.flatMap((p) => ["-e", p])], worktreeDir);
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

  // The source-only projection of the solution (see the header): blocks
  // touching a verifier-diff path or any test-classified path are set aside.
  // `judged.kept` is what gets applied AND what the secondary metrics see.
  const judged = stripHeldOutPaths(solutionDiff, diffFilePaths(truth.verifierDiff));
  const testEditsFiltered = judged.droppedPaths.length > 0;

  // Secondary metrics — pure functions of the diffs + truth + registry, so they
  // need no worktree and are computed the same whether or not the verifier runs.
  // Computed on the SOURCE-ONLY projection, because `fix.diff` is source-only
  // by construction (mine's split): full-solution metrics compared apples to
  // apples-plus-tests — inflating bloat for the normal habit of writing tests,
  // and DILUTING similarity, which could mask a regurgitated fix (the flag's
  // fail-safe direction wants sensitivity, so the tests must not water it down).
  const similarity = diffSimilarity(judged.kept, truth.fixDiff);
  const bloat = bloatRatio(judged.kept, truth.fixDiff);
  const regurgitationFlag = isRegurgitation(similarity, era);

  const verdict = (passed: boolean): Verdict => ({
    taskId: task.id,
    attempt,
    passed,
    bloatRatio: bloat,
    similarity,
    regurgitationFlag,
    cutoffEra: era,
    testEditsFiltered,
  });

  // Every note carries the filtering fact when it applies, so the -v log always
  // explains a verdict whose judged diff differs from solution.diff on disk.
  const filteredNote = testEditsFiltered
    ? `set aside edits to ${judged.droppedPaths.length} held-out path(s): ${judged.droppedPaths.join(", ")}`
    : null;
  const withFilter = (note: string | null): string | null =>
    filteredNote ? (note ? `${note} — ${filteredNote}` : filteredNote) : note;

  // The agent produced nothing — there is nothing to verify. Resolve to a fail
  // WITHOUT spawning a worktree (the whole apply→run path would be moot).
  if (solutionDiff.trim() === "") {
    return { verdict: verdict(false), note: "empty solution diff (agent produced nothing)" };
  }

  // The agent ONLY edited held-out paths — there is no source-side work to
  // judge. The gate proved the verifier fails at base without the real fix, so
  // this resolves to a fail without spawning a worktree. (An agent cannot pass
  // by rewriting the tests; that is the point of holding them out.)
  if (judged.kept.trim() === "") {
    return { verdict: verdict(false), note: withFilter("solution contained only held-out test-path edits — no source change to judge") };
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
      const setup = await runShell(config.setupCmd, { cwd: execCwd, timeoutMs, priority: config.host.priority });
      if (setup.timedOut) return { verdict: verdict(false), note: "setup timed out" };
      if (setup.code !== 0) return { verdict: verdict(false), note: `setup failed: ${snippet(setup.stderr || setup.stdout)}` };
    }

    // Pristine base (see resetWorktree) before applying the agent's work.
    await resetWorktree(worktreeDir, config.preservePaths);

    // Apply the AGENT's judged (source-only) solution first. If it doesn't
    // apply, the diff is unusable (stale, malformed, or against the wrong base)
    // ⇒ no credit, and we stop — there is nothing to run. Blocks of a unified
    // diff are independent under `git apply`, so the filtering above cannot be
    // what broke it.
    const sol = await applyDiff(worktreeDir, judged.kept);
    if (!sol.ok) {
      return { verdict: verdict(false), note: withFilter(`agent solution diff did not apply: ${snippet(sol.stderr)}`) };
    }

    // Then overlay the held-out verifier (the tests). Collisions with the
    // agent's test edits were already set aside, so a failure HERE means the
    // truth artifact itself doesn't apply at this base (corrupt/stale truth) —
    // or a solution block our filter failed to attribute to a verifier path
    // still collided. Either way we can't render an honest verdict ⇒ fail
    // (the fail-safe direction: never wrongly credit).
    const ver = await applyDiff(worktreeDir, truth.verifierDiff);
    if (!ver.ok) {
      return { verdict: verdict(false), note: withFilter(`held-out verifier diff did not apply over the solution: ${snippet(ver.stderr)}`) };
    }

    // The primary verdict: run the held-out verifier. Pass iff it exits 0 within
    // the timeout. A timeout or a null exit (killed/crashed — an environment
    // problem, not a passing test) is NOT a pass.
    let r = await runShell(task.verifierCmd, { cwd: execCwd, timeoutMs, priority: config.host.priority });
    if (r.timedOut && config.host.priority === "low") {
      // A verifier at low priority is exactly what gets starved on a contended
      // host — and a starved timeout here would score a CORRECT fix as a
      // failure, biasing model scores by how busy the machine happened to be
      // ("judge the fix, not the machine"). Retry ONCE at normal priority:
      // still fail-safe (a genuine hang times out again; only a real pass can
      // flip the verdict), and brief enough not to defeat host citizenship.
      await resetWorktree(worktreeDir, config.preservePaths);
      const sol2 = await applyDiff(worktreeDir, judged.kept);
      const ver2 = sol2.ok ? await applyDiff(worktreeDir, truth.verifierDiff) : sol2;
      if (!ver2.ok) return { verdict: verdict(false), note: withFilter("verifier timed out (low priority); state could not be rebuilt for the normal-priority retry") };
      r = await runShell(task.verifierCmd, { cwd: execCwd, timeoutMs, priority: "normal" });
      if (!r.timedOut) {
        const passed2 = r.code === 0;
        return { verdict: verdict(passed2), note: withFilter(passed2 ? "passed on normal-priority retry after a low-priority timeout" : `verifier failed (exit ${r.code}) on normal-priority retry`) };
      }
    }
    if (r.timedOut) return { verdict: verdict(false), note: withFilter("verifier timed out") };
    if (r.code === null) return { verdict: verdict(false), note: withFilter("verifier could not run (killed/crashed)") };
    const passed = r.code === 0;
    return { verdict: verdict(passed), note: withFilter(passed ? null : `verifier failed (exit ${r.code})`) };
  } finally {
    // Always tear down — a worktree leak across a large run is a real bug.
    await worktreeRemove(repoRoot, worktreeDir);
    await rm(tmp, { recursive: true, force: true });
  }
}
