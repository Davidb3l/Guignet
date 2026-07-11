/**
 * The shape a stage returns to the CLI. Lives in `core` (not in any one stage)
 * so every stage imports it from here — stages never import each other (§4).
 */
import type { ExitCode } from "./exit.ts";

export interface StageRun {
  stdout: string;
  stderr: string;
  code: ExitCode;
}
