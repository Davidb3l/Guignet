/**
 * One attempt's lifecycle (ARCHITECTURE.md §5). Owns a disposable worktree from
 * base to teardown: create it at the task's base commit, let the adapter drive
 * the agent inside it, capture what changed (diff) and what it cost (from the
 * adapter's transcript), persist everything, and always remove the worktree.
 * The runner never pushes and never touches the real checkout — all work is in
 * throwaway worktrees.
 */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  captureWorktreeDiff,
  transcriptDir as transcriptDirFor,
  writeAttempt,
  writeSolutionDiff,
  type Attempt,
  type RunConfig,
  type Task,
} from "../core/index.ts";
import type { Adapter } from "./adapters/types.ts";
import { safeWorktreeAdd, safeWorktreeRemove } from "./worktree.ts";

/** Milliseconds elapsed, measured by the runner (never trusting the adapter). */
function nowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/**
 * Run one attempt for `task` under `runConfig`, writing solution.diff, the
 * transcript, and attempt.json. Returns the persisted Attempt. Any failure to
 * create the worktree is recorded as a crashed attempt rather than thrown, so a
 * single bad attempt never aborts the batch.
 */
export async function runOneAttempt(
  repoRoot: string,
  runConfig: RunConfig,
  adapter: Adapter,
  task: Task,
  attemptNum: number,
  subdir?: string,
): Promise<Attempt> {
  const tDir = transcriptDirFor(repoRoot, runConfig.runId, task.id, attemptNum);
  await mkdir(tDir, { recursive: true });

  const tmp = await mkdtemp(join(tmpdir(), "guignet-run-"));
  const worktreeDir = join(tmp, "wt");

  const record = async (
    exit: Attempt["exit"],
    diff: string,
    tokens: Attempt["tokens"],
    dollars: number | null,
    wallclockMs: number,
  ): Promise<Attempt> => {
    const att: Attempt = { taskId: task.id, attempt: attemptNum, wallclockMs, tokens, dollars, exit };
    await writeSolutionDiff(repoRoot, runConfig.runId, task.id, attemptNum, diff);
    await writeAttempt(repoRoot, runConfig.runId, att);
    return att;
  };

  try {
    // Serialized + retried so a transient worktree lock race isn't mislabeled
    // as an agent crash (§ review #3).
    if (!(await safeWorktreeAdd(repoRoot, task.baseSha, worktreeDir))) {
      return await record("crashed", "", null, null, 0);
    }

    // wall-clock brackets ONLY the agent run (§5 — the runner's measure of the
    // agent), not the surrounding git worktree/diff/cost overhead.
    const agentStart = nowMs();
    const { exit } = await adapter.attempt({
      prompt: task.prompt,
      // The agent's cwd is the monorepo package root (§3) when a subdir is set;
      // the diff is still captured at the worktree root, where git lives.
      worktreePath: subdir ? join(worktreeDir, subdir) : worktreeDir,
      transcriptDir: tDir,
      model: runConfig.model,
      budget: runConfig.budgets ?? {},
    });
    const wallclockMs = nowMs() - agentStart;

    // The runner observes the diff itself — never trusting the adapter for it.
    // Captured even on a crashed/timed-out attempt (partial work is still data).
    const diff = await captureWorktreeDiff(worktreeDir);
    const cost = await adapter.parseCost(tDir);
    return await record(exit, diff, cost?.tokens ?? null, cost?.dollars ?? null, wallclockMs);
  } finally {
    await safeWorktreeRemove(repoRoot, worktreeDir);
    await rm(tmp, { recursive: true, force: true });
  }
}
