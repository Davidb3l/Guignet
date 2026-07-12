/**
 * `run` — execute attempts over the admitted suite (ARCHITECTURE.md §5).
 *
 * Reads `suite.json` (the gate's admitted tasks) and a run config (which model,
 * adapter, budget, nAttempts), then runs N attempts per task in a bounded pool
 * of disposable worktrees. Idempotent + resumable: an attempt whose
 * `attempt.json` already exists is skipped unless `--force`, so a run killed at
 * attempt 23 of 69 resumes at 23, not 0 (§2 — engagements run overnight).
 *
 * The runner never pushes and never touches the real checkout. Cost is captured
 * per attempt (wall-clock by the runner; tokens/$ by the adapter parsing its own
 * transcript — never self-reported, §5).
 */
import { readFile } from "node:fs/promises";

import {
  EXIT,
  RunConfigSchema,
  attemptExists,
  emitEvent,
  readConfig,
  readSuite,
  readTask,
  uri,
  writeRunConfig,
  type ExitCode,
  type RunConfig,
  type SpineSetting,
  type StageRun,
  type Task,
} from "../core/index.ts";
import { selectAdapter } from "./adapters/index.ts";
import { runOneAttempt, type AttemptEnv } from "./attempt.ts";
import { defaultConcurrency, mapLimit } from "./pool.ts";

/** One unit of work: a (task, attempt-number) pair the pool will execute. */
interface Unit {
  task: Task;
  attemptNum: number;
}

interface RunResult {
  runId: string;
  attempted: number; // units actually run this invocation
  skipped: number; // units already complete (resume)
  byExit: Record<string, number>;
  dollars: number | null; // summed where known
}

function fail(json: boolean, msg: string, code: ExitCode): StageRun {
  return { stdout: json ? JSON.stringify({ error: msg }) + "\n" : "", stderr: `guignet run: ${msg}\n`, code };
}

export async function runRun(opts: {
  repoRoot: string;
  json: boolean;
  force: boolean;
  config?: string;
}): Promise<StageRun> {
  const { repoRoot, json, force } = opts;

  if (!opts.config) return fail(json, "run requires --config <run-config.json>", EXIT.USAGE);

  // Load + validate the run config (a JSON file anywhere the user points at).
  let runConfig: RunConfig;
  try {
    runConfig = RunConfigSchema.parse(JSON.parse(await readFile(opts.config, "utf-8")));
  } catch (err) {
    return fail(json, `invalid run config: ${(err as Error).message}`, EXIT.FAILURE);
  }

  // The target-repo config gives the agent's environment: the package root (its
  // cwd), how to install deps, and the install timeout (reuse the verifier one).
  let env: AttemptEnv;
  let spine: SpineSetting;
  try {
    const cfg = await readConfig(repoRoot);
    env = { subdir: cfg.subdir, setupCmd: cfg.setupCmd, setupTimeoutMs: cfg.verifierTimeoutMs, testCwd: cfg.testCwd };
    spine = cfg.spine;
  } catch (err) {
    return fail(json, `cannot read target config: ${(err as Error).message}`, EXIT.FAILURE);
  }

  // The admitted suite — gate must have run.
  let taskIds: string[];
  try {
    taskIds = (await readSuite(repoRoot)).taskIds;
  } catch {
    return fail(json, "no suite.json — run `guignet gate` first", EXIT.SOFT_BLOCKED);
  }
  if (taskIds.length === 0) return fail(json, "the admitted suite is empty — nothing to run", EXIT.SOFT_BLOCKED);

  // Resolve + preflight the adapter.
  let adapter;
  try {
    adapter = selectAdapter(runConfig);
  } catch (err) {
    return fail(json, (err as Error).message, EXIT.USAGE);
  }
  if (!(await adapter.detect())) {
    return fail(json, `adapter "${runConfig.adapter}" is not available on this machine`, EXIT.FAILURE);
  }

  // Persist the run config into the store so the run is self-contained/resumable.
  await writeRunConfig(repoRoot, runConfig);

  // Build the work list, loading each task once; skip completed attempts (resume).
  // Dedupe the suite's task ids first: a repeated id would otherwise spawn two
  // units writing the SAME attempt dir concurrently (§ review #5).
  const tasks = new Map<string, Task>();
  const units: Unit[] = [];
  let skipped = 0;
  for (const taskId of [...new Set(taskIds)]) {
    let task = tasks.get(taskId);
    if (!task) {
      try {
        task = await readTask(repoRoot, taskId);
      } catch {
        continue; // a task named in the suite but unreadable on disk — skip it
      }
      tasks.set(taskId, task);
    }
    for (let n = 1; n <= runConfig.nAttempts; n++) {
      if (!force && attemptExists(repoRoot, runConfig.runId, taskId, n)) skipped++;
      else units.push({ task, attemptNum: n });
    }
  }

  const concurrency = runConfig.maxConcurrency ?? defaultConcurrency();
  const result: RunResult = { runId: runConfig.runId, attempted: 0, skipped, byExit: {}, dollars: null };

  const attempts = await mapLimit(units, concurrency, async (u) => {
    // runOneAttempt records a crashed attempt rather than throwing, but guard
    // anyway so one unexpected error can't abort the whole pool.
    try {
      return await runOneAttempt(repoRoot, runConfig, adapter, u.task, u.attemptNum, env);
    } catch {
      return null;
    }
  });

  for (const att of attempts) {
    if (!att) continue;
    result.attempted++;
    result.byExit[att.exit] = (result.byExit[att.exit] ?? 0) + 1;
    if (att.dollars !== null) result.dollars = (result.dollars ?? 0) + att.dollars;
  }

  // Suite event spine (§13) — a run finished; solved/total is a scoring concept,
  // so this carries just the run + model. Config-gated + best-effort.
  await emitEvent(spine, repoRoot, "run.completed", [uri.run(runConfig.runId)], {
    run: runConfig.runId,
    model: runConfig.model ?? runConfig.adapter,
    attempted: result.attempted,
  });

  const code: ExitCode = EXIT.OK;
  if (json) return { stdout: JSON.stringify(result) + "\n", stderr: "", code };
  const lines = [
    `guignet run ${result.runId}: ran ${result.attempted} attempt(s), skipped ${result.skipped} (resume).`,
    `  by exit: ${Object.entries(result.byExit).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
  ];
  if (result.dollars !== null) lines.push(`  total cost: $${result.dollars.toFixed(4)}`);
  return { stdout: lines.join("\n") + "\n", stderr: "", code };
}
