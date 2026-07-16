/**
 * `score` — verifier verdict + secondary metrics + contamination
 * (ARCHITECTURE.md §5, §7). For every attempt of a run, produce the PRIMARY,
 * judge-free verdict (does the agent's solution make the held-out verifier
 * pass?) plus the secondary contamination metrics, and write `verdict.json` per
 * attempt. `score/` MAY read ground truth (via verdict.ts → readTruth); the
 * import-boundary check permits it here and in `gate/` only.
 *
 * Idempotent + resumable (§2, mirroring gate/run): an attempt with an existing
 * verdict.json is skipped unless `--force`, so re-scoring a large run never
 * redoes completed verdicts.
 *
 * Which runs: an explicit `runId` scores just that run (a real FAILURE if its
 * config can't be read); with no runId, EVERY run on disk is scored (SOFT_BLOCK
 * when there are none). A per-attempt load failure (bad task/truth/solution)
 * discards THAT attempt as a defensible `passed:false` — it never crashes the
 * whole run.
 */
import {
  EXIT,
  classifyEra,
  git,
  listRunAttempts,
  listRuns,
  loadCutoffRegistry,
  readConfig,
  readRunConfig,
  readSolutionDiff,
  readTask,
  resolveCutoff,
  verdictExists,
  writeVerdict,
  type Config,
  type ExitCode,
  type RunConfig,
  type StageRun,
  type Task,
  type Verdict,
} from "../core/index.ts";
import { replayVerdict } from "./verdict.ts";

/** Per-run scoring tallies — the same shape appears in the JSON `runs` array. */
interface RunSummary {
  runId: string;
  scored: number; // verdicts produced THIS invocation (resume-skips excluded)
  passed: number;
  failed: number;
  flagged: number; // regurgitation-flagged (a passed solution can still be flagged)
}

function emptySummary(runId: string): RunSummary {
  return { runId, scored: 0, passed: 0, failed: 0, flagged: 0 };
}

/** A defensible verdict for an attempt we could not load/replay — never a pass. */
function unscoreable(taskId: string, attempt: number, era: Verdict["cutoffEra"]): Verdict {
  return { taskId, attempt, passed: false, bloatRatio: null, similarity: null, regurgitationFlag: false, cutoffEra: era, testEditsFiltered: false };
}

/** Score every attempt of one run, writing a verdict.json each. Accumulates into
 * `summary`. Returns the number of attempt UNITS seen (scored + resume-skipped),
 * so the caller can tell "nothing to score anywhere" from "all already scored". */
async function scoreRun(
  repoRoot: string,
  config: Config,
  runConfig: RunConfig,
  force: boolean,
  summary: RunSummary,
  log: (m: string) => void,
): Promise<number> {
  const registry = loadCutoffRegistry(config.cutoffs);
  const cutoffIso = resolveCutoff(runConfig.model, registry);
  const units = await listRunAttempts(repoRoot, runConfig.runId);

  for (const { taskId, attempt } of units) {
    // Resume: an already-scored attempt stands unless --force redoes it.
    if (!force && verdictExists(repoRoot, runConfig.runId, taskId, attempt)) {
      log(`score: ${runConfig.runId}/${taskId}#${attempt} already scored — skipping`);
      continue;
    }

    // Load the task first so we can still classify the era even if truth/solution
    // loading later fails (era needs only task.date + the model cutoff).
    let task: Task | null = null;
    try {
      task = await readTask(repoRoot, taskId);
    } catch (err) {
      log(`score: ${runConfig.runId}/${taskId}#${attempt} — cannot read task: ${(err as Error).message}`);
    }
    const era = task ? classifyEra(task.date, cutoffIso) : "unknown";

    let verdict: Verdict;
    if (!task) {
      verdict = unscoreable(taskId, attempt, era);
    } else {
      try {
        const solutionDiff = await readSolutionDiff(repoRoot, runConfig.runId, taskId, attempt);
        const res = await replayVerdict(repoRoot, config, { task, attempt, solutionDiff, cutoffIso });
        verdict = res.verdict;
        log(
          `score: ${runConfig.runId}/${taskId}#${attempt} ${verdict.passed ? "PASSED" : "failed"}` +
            (res.note ? ` (${res.note})` : "") +
            (verdict.regurgitationFlag ? " [regurgitation]" : ""),
        );
      } catch (err) {
        // Truth missing/unreadable, or an unexpected replay error — un-scoreable,
        // but we keep the era we could classify from the task.
        verdict = unscoreable(taskId, attempt, era);
        log(`score: ${runConfig.runId}/${taskId}#${attempt} — could not score: ${(err as Error).message}`);
      }
    }

    await writeVerdict(repoRoot, runConfig.runId, verdict);
    summary.scored++;
    if (verdict.passed) summary.passed++;
    else summary.failed++;
    if (verdict.regurgitationFlag) summary.flagged++;
  }

  return units.length;
}

/** The single JSON object emitted under `--json` (§4: exactly one, on stdout). */
function jsonReport(summaries: readonly RunSummary[]): string {
  const totals = summaries.reduce(
    (t, s) => ({ scored: t.scored + s.scored, passed: t.passed + s.passed, failed: t.failed + s.failed, flagged: t.flagged + s.flagged }),
    { scored: 0, passed: 0, failed: 0, flagged: 0 },
  );
  return JSON.stringify({ ...totals, runs: summaries }) + "\n";
}

/** The human summary printed when `--json` is absent. */
function humanReport(summaries: readonly RunSummary[]): string {
  const t = summaries.reduce(
    (a, s) => ({ scored: a.scored + s.scored, passed: a.passed + s.passed, failed: a.failed + s.failed, flagged: a.flagged + s.flagged }),
    { scored: 0, passed: 0, failed: 0, flagged: 0 },
  );
  const lines = [
    `guignet score: scored ${t.scored} attempt(s) across ${summaries.length} run(s) — ${t.passed} passed, ${t.failed} failed, ${t.flagged} flagged`,
  ];
  for (const s of summaries) {
    lines.push(`  ${s.runId}: ${s.scored} scored (${s.passed} passed, ${s.failed} failed, ${s.flagged} flagged)`);
  }
  return lines.join("\n") + "\n";
}

export async function runScore(opts: { repoRoot: string; json: boolean; force: boolean; runId?: string }): Promise<StageRun> {
  const { repoRoot, json, force, runId } = opts;
  let stderr = "";
  const log = (m: string): void => {
    stderr += m + "\n";
  };

  // The target-repo config supplies the verifier command's environment
  // (setupCmd, subdir, verifierTimeoutMs) and the cutoff overrides — score can't
  // render a verdict without it, so a missing/invalid config is a real failure.
  let config: Config;
  try {
    config = await readConfig(repoRoot);
  } catch (err) {
    return { stdout: "", stderr: `score: cannot read config: ${(err as Error).message}\n`, code: EXIT.FAILURE };
  }

  // Crash hygiene: prune worktrees a killed/frozen previous run left registered
  // (their temp dirs are gone; the registry entries would accrete forever).
  await git(["worktree", "prune"], repoRoot).catch(() => {});

  // Which runs to score. An explicit runId that can't be read is a hard error
  // (the user named a run that isn't there); the all-runs path soft-blocks on
  // an empty repo and skips any individually-unreadable run config.
  const runConfigs: RunConfig[] = [];
  if (runId !== undefined) {
    try {
      runConfigs.push(await readRunConfig(repoRoot, runId));
    } catch (err) {
      return { stdout: "", stderr: `score: cannot read run "${runId}": ${(err as Error).message}\n`, code: EXIT.FAILURE };
    }
  } else {
    const ids = await listRuns(repoRoot);
    if (ids.length === 0) {
      return {
        stdout: json ? jsonReport([]) : "score: no runs on disk — run `guignet run` first\n",
        stderr,
        code: EXIT.SOFT_BLOCKED,
      };
    }
    for (const id of ids) {
      try {
        runConfigs.push(await readRunConfig(repoRoot, id));
      } catch (err) {
        // One bad run config doesn't sink the batch — log and move on.
        log(`score: skipping run "${id}" — cannot read its config: ${(err as Error).message}`);
      }
    }
  }

  const summaries: RunSummary[] = [];
  let totalUnits = 0;
  for (const runConfig of runConfigs) {
    const summary = emptySummary(runConfig.runId);
    totalUnits += await scoreRun(repoRoot, config, runConfig, force, summary, log);
    summaries.push(summary);
  }

  // No attempt units exist across the selected runs ⇒ nothing to score (§4).
  // A run whose attempts are all already scored (resume) is NOT this case — the
  // units exist, so that path exits OK with `scored: 0`.
  const code: ExitCode = totalUnits === 0 ? EXIT.SOFT_BLOCKED : EXIT.OK;
  return { stdout: json ? jsonReport(summaries) : humanReport(summaries), stderr, code };
}
