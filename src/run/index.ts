/**
 * `run` — worktree pool + attempt loop + adapters (ARCHITECTURE.md §5, §6).
 * Implemented in M2. `run/` MUST NOT import core/truth.ts — it has no
 * legitimate route to ground truth, and the import-boundary check enforces it.
 */
import { EXIT, type StageRun } from "../core/index.ts";

export function runRun(_opts: { repoRoot: string; json: boolean; force: boolean; config?: string }): StageRun {
  return {
    stdout: "",
    stderr: "guignet run: not implemented yet (milestone M2)\n",
    code: EXIT.FAILURE,
  };
}
