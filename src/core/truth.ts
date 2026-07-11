/**
 * The leak firewall, made structural (ARCHITECTURE.md §5, CLAUDE.md hard
 * invariant). The held-out ground truth — the real fix and the tests that
 * verify it — lives under `.guignet/tasks/<taskId>/truth/`. A single leaked
 * fix silently invalidates every score downstream, so access is confined to
 * this one module and the import-boundary check (scripts/check-boundaries.ts)
 * enforces WHO may import it:
 *
 *   - `mine/`  MAY call `writeTruth` (it reconstructs and writes truth once) —
 *              and MUST NOT read it back.
 *   - `gate/`  and `score/` MAY call `readTruth` (they replay and score it).
 *   - `run/`   and `report/` MUST NOT import this module at all — they have no
 *              legitimate reason to open ground truth, and the checker fails CI
 *              if they do.
 *
 * The `PromptContext` the LLM cleaner sees (mine/) has no field that can carry
 * any value from here; this module and that type never meet.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { taskDir } from "./store.ts";

/** The held-out truth for one task. Diffs are unified-diff text. */
export interface Truth {
  /** The real source fix — never shown to the agent. */
  fixDiff: string;
  /** The tests the fix added/changed — applied by `score` to render a verdict. */
  verifierDiff: string;
}

function truthDir(repoRoot: string, taskId: string): string {
  return join(taskDir(repoRoot, taskId), "truth");
}

/**
 * Write a task's ground truth. Called ONLY by `mine/`, exactly once per task.
 * There is deliberately no update/merge path: truth is written at
 * reconstruction time and thereafter read-only to gate/score.
 */
export async function writeTruth(repoRoot: string, taskId: string, truth: Truth): Promise<void> {
  const dir = truthDir(repoRoot, taskId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "fix.diff"), truth.fixDiff, "utf-8");
  await writeFile(join(dir, "verifier.diff"), truth.verifierDiff, "utf-8");
}

/**
 * Read a task's ground truth. Called ONLY by `gate/` (replay) and `score/`
 * (verdict + regurgitation similarity). The import-boundary check forbids any
 * other stage from reaching this function.
 */
export async function readTruth(repoRoot: string, taskId: string): Promise<Truth> {
  const dir = truthDir(repoRoot, taskId);
  const [fixDiff, verifierDiff] = await Promise.all([
    readFile(join(dir, "fix.diff"), "utf-8"),
    readFile(join(dir, "verifier.diff"), "utf-8"),
  ]);
  return { fixDiff, verifierDiff };
}
