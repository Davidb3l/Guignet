/**
 * `score` — verifier verdict + secondary metrics + contamination
 * (ARCHITECTURE.md §5, §7). Implemented in M3. `score/` MAY call `readTruth`
 * (core/truth.ts) to apply the verifier diff and compute regurgitation
 * similarity; the import-boundary check permits it here and in `gate/` only.
 */
import { EXIT, type StageRun } from "../core/index.ts";

export function runScore(_opts: { repoRoot: string; json: boolean; force: boolean; runId?: string }): StageRun {
  return {
    stdout: "",
    stderr: "guignet score: not implemented yet (milestone M3)\n",
    code: EXIT.FAILURE,
  };
}
