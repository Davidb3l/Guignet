/**
 * Report aggregation (ARCHITECTURE.md §5 report, §7, §8). Pure over the store:
 * reads suite + runs + attempts + verdicts and computes the ReportModel — every
 * number the HTML and the `--json` twin show. No re-execution; `guignet report`
 * only reads. A task is "solved" by a config if at least one of its attempts
 * passed (resolve@n); the executive number is total $ / tasks solved.
 */
import {
  classifyEra,
  loadCutoffRegistry,
  readAttempt,
  readConfig,
  readRunConfig,
  readSuite,
  readTask,
  readVerdict,
  resolveCutoff,
  listRunAttempts,
  listRuns,
  type Attempt,
  type CutoffEra,
  type Task,
  type Verdict,
} from "../core/index.ts";
import type { ConfigReport, ReportModel, SubsetReport, TaxonomyCell } from "./model.ts";
import { median, wilsonInterval } from "./stats.ts";

/** Per-task rollup within one run: did any attempt pass, and its cutoff era. */
interface TaskRollup {
  task: Task;
  solved: boolean;
  era: CutoffEra;
}

function subset(tasks: readonly TaskRollup[]): SubsetReport {
  const total = tasks.length;
  const solved = tasks.filter((t) => t.solved).length;
  return {
    tasksTotal: total,
    tasksSolved: solved,
    solveRate: total === 0 ? null : solved / total,
    ci: total === 0 ? null : wilsonInterval(solved, total),
  };
}

function sumTokens(attempts: readonly Attempt[]): ConfigReport["tokens"] {
  const withTokens = attempts.filter((a): a is Attempt & { tokens: NonNullable<Attempt["tokens"]> } => a.tokens !== null);
  if (withTokens.length === 0) return null;
  return withTokens.reduce(
    (acc, a) => ({
      input: acc.input + a.tokens.input,
      output: acc.output + a.tokens.output,
      cacheRead: acc.cacheRead + a.tokens.cacheRead,
      cacheCreation: acc.cacheCreation + a.tokens.cacheCreation,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  );
}

/** Aggregate one run into a leaderboard row. */
async function aggregateRun(
  repoRoot: string,
  runId: string,
  taskCache: Map<string, Task>,
  registryCutoff: (model: string | undefined) => string | null,
): Promise<{ report: ConfigReport; rollups: TaskRollup[]; attemptCount: number } | null> {
  let rc;
  try {
    rc = await readRunConfig(repoRoot, runId);
  } catch {
    return null; // a run dir with no readable config — skip it
  }
  const cutoffDate = registryCutoff(rc.model);

  const units = await listRunAttempts(repoRoot, runId);
  if (units.length === 0) return null;

  // Gather attempts + verdicts, grouped by task.
  const byTask = new Map<string, { attempts: Attempt[]; verdicts: Verdict[] }>();
  const allAttempts: Attempt[] = [];
  const allVerdicts: Verdict[] = [];
  for (const { taskId, attempt } of units) {
    let att: Attempt;
    try {
      att = await readAttempt(repoRoot, runId, taskId, attempt);
    } catch {
      continue;
    }
    let verdict: Verdict | null = null;
    try {
      verdict = await readVerdict(repoRoot, runId, taskId, attempt);
    } catch {
      verdict = null; // unscored attempt — counts as not-passed
    }
    const g = byTask.get(taskId) ?? { attempts: [], verdicts: [] };
    g.attempts.push(att);
    if (verdict) g.verdicts.push(verdict);
    byTask.set(taskId, g);
    allAttempts.push(att);
    if (verdict) allVerdicts.push(verdict);
  }

  const rollups: TaskRollup[] = [];
  for (const [taskId, g] of byTask) {
    let task = taskCache.get(taskId);
    if (!task) {
      try {
        task = await readTask(repoRoot, taskId);
      } catch {
        continue;
      }
      taskCache.set(taskId, task);
    }
    const solved = g.verdicts.some((v) => v.passed);
    // Prefer the verdict's era (computed by score with this run's model);
    // fall back to classifying the task date if unscored.
    const era: CutoffEra = g.verdicts[0]?.cutoffEra ?? classifyEra(task.date, cutoffDate);
    rollups.push({ task, solved, era });
  }

  const tasksTotal = rollups.length;
  const tasksSolved = rollups.filter((r) => r.solved).length;
  // Sum only KNOWN costs, and track coverage — never treat a null (crashed /
  // unparseable transcript) attempt as $0, which would fabricate a too-low
  // executive number (§9 honesty). A partial number is a lower bound, footnoted.
  const pricedAttempts = allAttempts.filter((a) => a.dollars !== null);
  const totalDollars = pricedAttempts.length > 0 ? pricedAttempts.reduce((s, a) => s + (a.dollars ?? 0), 0) : null;
  const tokenedAttempts = allAttempts.filter((a) => a.tokens !== null);

  const preCutoffAttempts = allVerdicts.filter((v) => v.cutoffEra === "pre").length;
  const flaggedCount = allVerdicts.filter((v) => v.regurgitationFlag).length;
  const testEditsFilteredCount = allVerdicts.filter((v) => v.testEditsFiltered).length;

  const report: ConfigReport = {
    runId,
    label: `${rc.model ?? rc.adapter} · ${rc.adapter}`,
    model: rc.model ?? "(default)",
    adapter: rc.adapter,
    nAttempts: rc.nAttempts,
    watermarked: rc.nAttempts === 1,
    cutoffDate,
    dollarsPerSolvedTask: totalDollars !== null && tasksSolved > 0 ? totalDollars / tasksSolved : null,
    dollarsCoverage: { known: pricedAttempts.length, total: allAttempts.length },
    tasksTotal,
    tasksSolved,
    solveRate: tasksTotal === 0 ? 0 : tasksSolved / tasksTotal,
    ci: wilsonInterval(tasksSolved, tasksTotal),
    split: {
      pre: subset(rollups.filter((r) => r.era === "pre")),
      post: subset(rollups.filter((r) => r.era === "post")),
      unknown: subset(rollups.filter((r) => r.era === "unknown")),
    },
    totalDollars,
    tokens: sumTokens(allAttempts),
    tokensCoverage: { known: tokenedAttempts.length, total: allAttempts.length },
    medianWallclockMs: median(allAttempts.map((a) => a.wallclockMs)),
    medianBloatRatio: median(allVerdicts.map((v) => v.bloatRatio).filter((b): b is number => b !== null)),
    flaggedCount,
    preCutoffAttempts,
    flagRate: preCutoffAttempts > 0 ? flaggedCount / preCutoffAttempts : null,
    testEditsFilteredCount,
    testEditsFilteredRate: allVerdicts.length > 0 ? testEditsFilteredCount / allVerdicts.length : null,
  };
  return { report, rollups, attemptCount: allAttempts.length };
}

/** The heatmap sort key: post-cutoff solve rate is the headline, then overall. */
function headlineRate(c: ConfigReport): number {
  return c.split.post.solveRate ?? c.solveRate;
}

/** Build the kind × area heatmap for the primary config's task rollups. */
function buildTaxonomy(primary: { report: ConfigReport; rollups: TaskRollup[] } | undefined): ReportModel["taxonomy"] {
  if (!primary) return { forLabel: null, kinds: [], areas: [], cells: [], areasOmitted: 0 };
  const cellMap = new Map<string, TaxonomyCell>();
  const kinds = new Set<string>();
  const areaCount = new Map<string, number>();

  for (const r of primary.rollups) {
    const kind = r.task.taxonomy.kind;
    kinds.add(kind);
    const areas = r.task.taxonomy.areas.length > 0 ? r.task.taxonomy.areas : ["(none)"];
    for (const area of areas) {
      areaCount.set(area, (areaCount.get(area) ?? 0) + 1);
      const key = `${kind}|${area}`;
      const cell = cellMap.get(key) ?? { kind, area, tasksTotal: 0, tasksSolved: 0, solveRate: 0 };
      cell.tasksTotal++;
      if (r.solved) cell.tasksSolved++;
      cell.solveRate = cell.tasksSolved / cell.tasksTotal;
      cellMap.set(key, cell);
    }
  }
  // Keep the heatmap readable: the busiest ~8 areas. Report how many we dropped
  // so the omission is visible, not silent.
  const CAP = 8;
  const ranked = [...areaCount.entries()].sort((a, b) => b[1] - a[1]);
  const areas = ranked.slice(0, CAP).map(([a]) => a);
  const areaSet = new Set(areas);
  return {
    forLabel: primary.report.label,
    kinds: [...kinds].sort(),
    areas: areas.sort(),
    cells: [...cellMap.values()].filter((c) => areaSet.has(c.area)),
    areasOmitted: Math.max(0, ranked.length - CAP),
  };
}

export async function aggregate(repoRoot: string, generatedAt: string): Promise<ReportModel> {
  const config = await readConfig(repoRoot);
  const registry = loadCutoffRegistry(config.cutoffs);
  const registryCutoff = (model: string | undefined): string | null => resolveCutoff(model, registry);

  let suite;
  try {
    suite = await readSuite(repoRoot);
  } catch {
    suite = { taskIds: [], soundnessRate: { admitted: 0, candidates: 0 }, minedAt: "" };
  }

  const runIds = await listRuns(repoRoot);
  const taskCache = new Map<string, Task>();
  const runResults = (await Promise.all(runIds.map((id) => aggregateRun(repoRoot, id, taskCache, registryCutoff)))).filter(
    (r): r is { report: ConfigReport; rollups: TaskRollup[]; attemptCount: number } => r !== null,
  );
  runResults.sort((a, b) => headlineRate(b.report) - headlineRate(a.report) || b.report.solveRate - a.report.solveRate);

  const adapters = [...new Set(runResults.map((r) => r.report.adapter))].sort();
  const totalAttempts = runResults.reduce((s, r) => s + r.attemptCount, 0);

  return {
    generatedAt,
    repoName: repoRoot.split("/").filter(Boolean).pop() ?? repoRoot,
    repoVisibility: config.repoVisibility,
    suite: {
      admitted: suite.soundnessRate.admitted,
      candidates: suite.soundnessRate.candidates,
      soundnessRate: suite.soundnessRate.candidates > 0 ? suite.soundnessRate.admitted / suite.soundnessRate.candidates : 0,
      minedAt: suite.minedAt,
    },
    configs: runResults.map((r) => r.report),
    taxonomy: buildTaxonomy(runResults[0]),
    methodology: {
      gateReplays: config.gateReplays,
      cutoffRegistryVersion: registry.version,
      adapters,
      totalRuns: runResults.length,
      totalAttempts,
    },
  };
}
