/**
 * `report` — self-contained HTML assembly + `--json` twin (ARCHITECTURE.md §5,
 * §8). Implemented in M3. Pure: regenerates from the store, no re-execution.
 * `report/` MUST NOT import core/truth.ts — the report is built from stored
 * runs/verdicts, never from ground truth (§5); the boundary check enforces it.
 */
import { EXIT, type StageRun } from "../core/index.ts";

export function runReport(_opts: { repoRoot: string; json: boolean }): StageRun {
  return {
    stdout: "",
    stderr: "guignet report: not implemented yet (milestone M3)\n",
    code: EXIT.FAILURE,
  };
}
