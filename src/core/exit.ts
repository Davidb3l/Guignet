/**
 * Exit codes — the suite-wide convention (SUITE_CONTRACTS §4, mirrored in
 * ARCHITECTURE.md §4). Shared by every `guignet` subcommand so scripts and the
 * Suite Hub can branch on them without parsing output.
 *
 *   0  ok
 *   1  operational failure (INCLUDING environment problems — a missing test
 *      command, an unbuildable repo. There is no separate "environment" code;
 *      that was the v1 draft's meaning for 3, reconciled to the suite in v1.1.)
 *   2  usage error (bad flags/args)
 *   3  soft-blocked — the work ran but produced nothing actionable, and that is
 *      an expected, non-error outcome: `gate` admitted zero sound tasks,
 *      `score` found no attempts to score. A CI gate can treat 3 distinctly
 *      from a crash (1).
 *
 * Doctor is the deliberate exception: under `--json` it exits 0 whenever it
 * produced an envelope, because health lives in the envelope's `ok` field, not
 * the exit code (§3.1 present-but-unhealthy vs absent). See cli/doctor.ts.
 */
export const EXIT = {
  OK: 0,
  FAILURE: 1,
  USAGE: 2,
  SOFT_BLOCKED: 3,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
