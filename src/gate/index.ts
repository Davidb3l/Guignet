/**
 * `gate` — validity replay + suite assembly (ARCHITECTURE.md §5). Reads the
 * reconstructed tasks `mine` wrote under `.guignet/tasks/<taskId>/`, replays
 * each one's held-out ground truth in a clean worktree (replay.ts), and admits
 * only tasks proven SOUND: verifier fails k× at base, passes k× at fix. Writes a
 * `gate.json` per task and a `suite.json` listing only admitted tasks plus the
 * published soundness rate (admitted/candidates — §9 wedge, never hidden).
 *
 * `gate/` MAY read ground truth via replay.ts (which imports readTruth); the
 * import-boundary check permits that here and in `score/` only.
 *
 * Idempotent + resumable (§2): a task with an existing gate.json is skipped
 * unless `--force`, so a re-run never redoes completed replays.
 */
import {
  EXIT,
  listTaskIds,
  readCandidateLog,
  readConfig,
  readGate,
  readTask,
  writeGate,
  writeSuite,
  type Gate,
  type StageRun,
} from "../core/index.ts";
import { replayTask } from "./replay.ts";

/** One task's outcome, collected for both the suite manifest and the summary. */
interface TaskResult {
  taskId: string;
  admitted: boolean;
  discardReason: string | null;
}

/**
 * The published soundness rate is `admitted / candidates` (§5, §9 wedge — never
 * hidden). "Candidates" is the count of task-shaped commits `mine` DISCOVERED —
 * read from the candidate log — NOT the count of tasks it managed to reconstruct.
 * Using the reconstructed count as the denominator would hide everything mine
 * dropped and overstate mining quality. Falls back to the evaluated count only
 * when no candidate log is present (e.g. hand-placed tasks).
 */
async function candidateCount(repoRoot: string, evaluated: number): Promise<number> {
  try {
    return (await readCandidateLog(repoRoot)).candidates.length;
  } catch {
    return evaluated;
  }
}

/** The single JSON object emitted under `--json` (§4: exactly one, on stdout). */
function jsonReport(results: readonly TaskResult[], candidates: number): string {
  const admitted = results.filter((r) => r.admitted).length;
  return (
    JSON.stringify({
      evaluated: results.length,
      admitted,
      discarded: results.length - admitted,
      soundnessRate: { admitted, candidates },
      tasks: results.map((r) => ({ taskId: r.taskId, admitted: r.admitted, discardReason: r.discardReason })),
    }) + "\n"
  );
}

/** The human summary printed when `--json` is absent. */
function humanReport(results: readonly TaskResult[], candidates: number): string {
  const admitted = results.filter((r) => r.admitted);
  const discarded = results.filter((r) => !r.admitted);
  const pct = candidates ? Math.round((admitted.length / candidates) * 100) : 0;

  const lines = [
    `guignet gate: admitted ${admitted.length} of ${candidates} candidate(s) (soundness rate ${pct}%); ${results.length} reconstructed task(s) evaluated`,
  ];
  if (discarded.length) {
    lines.push("discarded:");
    for (const r of discarded) lines.push(`  ${r.taskId}: ${r.discardReason ?? "unknown"}`);
  }
  return lines.join("\n") + "\n";
}

export async function runGate(opts: { repoRoot: string; json: boolean; force: boolean }): Promise<StageRun> {
  const { repoRoot, json, force } = opts;
  let stderr = "";
  const log = (m: string): void => {
    stderr += m + "\n";
  };

  // A missing/invalid config is a real operational failure (§4: exit 1), not a
  // soft block — gate cannot run without knowing k / setup / subdir.
  let config;
  try {
    config = await readConfig(repoRoot);
  } catch (err) {
    return { stdout: "", stderr: `gate: cannot read config: ${(err as Error).message}\n`, code: EXIT.FAILURE };
  }

  const taskIds = await listTaskIds(repoRoot);
  if (taskIds.length === 0) {
    // Nothing to gate — `mine` hasn't run (or produced nothing). Ran fine,
    // nothing actionable ⇒ soft-blocked (§4), still one JSON object under --json.
    // Write an empty suite.json so `run` always finds a manifest regardless of
    // which soft-block path was taken (consistent with the zero-admitted case).
    const candidates = await candidateCount(repoRoot, 0);
    await writeSuite(repoRoot, { taskIds: [], soundnessRate: { admitted: 0, candidates }, minedAt: new Date().toISOString() });
    return {
      stdout: json ? jsonReport([], candidates) : "gate: no tasks on disk — run `guignet mine` first\n",
      stderr,
      code: EXIT.SOFT_BLOCKED,
    };
  }

  const results: TaskResult[] = [];
  for (const taskId of taskIds) {
    // Resume: an already-gated task stands unless --force redoes it. `readGate`
    // throws when gate.json is absent — that's the "not yet gated" signal.
    if (!force) {
      let existing: Gate | null = null;
      try {
        existing = await readGate(repoRoot, taskId);
      } catch {
        existing = null;
      }
      if (existing) {
        results.push({ taskId, admitted: existing.admitted, discardReason: existing.discardReason });
        log(`gate: ${taskId} already gated (${existing.admitted ? "admitted" : "discarded"}) — skipping`);
        continue;
      }
    }

    let gate: Gate;
    try {
      const task = await readTask(repoRoot, taskId);
      gate = await replayTask(repoRoot, task, config);
    } catch (err) {
      // A broken task on disk (missing/malformed task.json or truth) discards the
      // single task with a reason — it never crashes the whole gate run.
      gate = {
        taskId,
        admitted: false,
        replays: { failAtBase: 0, passAtFix: 0, k: config.gateReplays },
        discardReason: `could not load task: ${(err as Error).message}`,
      };
    }
    await writeGate(repoRoot, gate);
    results.push({ taskId: gate.taskId, admitted: gate.admitted, discardReason: gate.discardReason });
    log(`gate: ${gate.taskId} ${gate.admitted ? "ADMITTED" : `discarded (${gate.discardReason})`}`);
  }

  const admittedIds = results.filter((r) => r.admitted).map((r) => r.taskId).sort();
  const candidates = await candidateCount(repoRoot, results.length);
  await writeSuite(repoRoot, {
    taskIds: admittedIds,
    soundnessRate: { admitted: admittedIds.length, candidates },
    minedAt: new Date().toISOString(),
  });

  // An empty suite is an expected, non-error "nothing actionable" outcome (§4).
  const code = admittedIds.length === 0 ? EXIT.SOFT_BLOCKED : EXIT.OK;
  return { stdout: json ? jsonReport(results, candidates) : humanReport(results, candidates), stderr, code };
}
