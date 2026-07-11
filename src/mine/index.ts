/**
 * `mine` — candidate discovery + task reconstruction (ARCHITECTURE.md §5).
 * Implemented in M1. This stub keeps the stage boundary real from M0 so the
 * import-boundary check and the CLI dispatch have a stable shape to target.
 *
 * When implemented, `mine/` MAY call `writeTruth` (core/truth.ts) — writing
 * each task's ground truth exactly once — and MUST NOT read it back (§5).
 */
import { EXIT, type StageRun } from "../core/index.ts";

export function runMine(_opts: { repoRoot: string; json: boolean; force: boolean }): StageRun {
  return {
    stdout: "",
    stderr: "guignet mine: not implemented yet (milestone M1)\n",
    code: EXIT.FAILURE,
  };
}
