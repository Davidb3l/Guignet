/**
 * `gate` — validity replay + suite assembly (ARCHITECTURE.md §5). Implemented
 * in M1. `gate/` MAY call `readTruth` (core/truth.ts) to replay the held-out
 * fix; the import-boundary check permits it here and in `score/` only.
 */
import { EXIT, type StageRun } from "../core/index.ts";

export function runGate(_opts: { repoRoot: string; json: boolean; force: boolean }): StageRun {
  return {
    stdout: "",
    stderr: "guignet gate: not implemented yet (milestone M1)\n",
    code: EXIT.FAILURE,
  };
}
