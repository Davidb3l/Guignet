import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { wilsonInterval, median } from "../src/report/stats.ts";
import { aggregate } from "../src/report/aggregate.ts";
import { renderReportHtml } from "../src/report/template.ts";
import type { ReportModel } from "../src/report/model.ts";
import { ConfigSchema, type Attempt, type Task, type Verdict } from "../src/core/schema.ts";
import {
  writeConfig,
  writeSuite,
  writeTask,
  writeRunConfig,
  writeAttempt,
  writeSolutionDiff,
  writeVerdict,
} from "../src/core/store.ts";

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "guignet-report-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe("stats", () => {
  test("wilsonInterval brackets the point estimate and clamps to [0,1]", () => {
    const ci = wilsonInterval(1, 2); // 50%
    expect(ci.low).toBeGreaterThan(0);
    expect(ci.low).toBeLessThan(0.5);
    expect(ci.high).toBeGreaterThan(0.5);
    expect(ci.high).toBeLessThan(1);
    const none = wilsonInterval(0, 0);
    expect(none).toEqual({ low: 0, high: 1 }); // n=0 → we know nothing
    const all = wilsonInterval(5, 5);
    expect(all.high).toBe(1);
  });
  test("median handles even/odd/empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

// --- aggregate scenario ---

function task(id: string, date: string, kind: Task["taxonomy"]["kind"], areas: string[]): Task {
  return {
    id, prompt: "p", baseSha: "base", sourceSha: "src", date,
    taxonomy: { kind, size: { lines: 3, files: 1 }, areas },
    verifierCmd: "true", discoveredBy: ["test-source-delta"],
  };
}
function attempt(taskId: string, n: number, dollars: number | null): Attempt {
  return { taskId, attempt: n, wallclockMs: 1000 * n, tokens: dollars === null ? null : { input: 10, output: 20, cacheRead: 100, cacheCreation: 5 }, dollars, exit: "completed" };
}
function verdict(taskId: string, n: number, passed: boolean, era: Verdict["cutoffEra"], flag: boolean): Verdict {
  return { taskId, attempt: n, passed, bloatRatio: 1.5, similarity: flag ? 0.9 : 0.1, regurgitationFlag: flag, cutoffEra: era };
}

async function seedRun(repo: string): Promise<void> {
  await writeConfig(repo, ConfigSchema.parse({ testCmd: "bun test" }));
  await writeSuite(repo, { taskIds: ["t1", "t2"], soundnessRate: { admitted: 2, candidates: 5 }, minedAt: "2026-07-01T00:00:00Z" });
  await writeTask(repo, task("t1", "2025-06-01T00:00:00Z", "bugfix", ["auth"])); // pre-cutoff (opus cutoff 2026-01-01)
  await writeTask(repo, task("t2", "2026-05-01T00:00:00Z", "feature", ["ledger"])); // post-cutoff
  await writeRunConfig(repo, { runId: "r1", adapter: "claude-code", model: "opus", nAttempts: 2, budgets: undefined });

  // t1: attempt 1 passes (flagged, pre-cutoff regurgitation), attempt 2 fails.
  // t2: both attempts fail.
  const rows: [string, number, boolean, Verdict["cutoffEra"], boolean, number][] = [
    ["t1", 1, true, "pre", true, 0.10],
    ["t1", 2, false, "pre", false, 0.10],
    ["t2", 1, false, "post", false, 0.20],
    ["t2", 2, false, "post", false, 0.20],
  ];
  for (const [id, n, passed, era, flag, dollars] of rows) {
    await writeSolutionDiff(repo, "r1", id, n, "+x");
    await writeAttempt(repo, "r1", attempt(id, n, dollars));
    await writeVerdict(repo, "r1", verdict(id, n, passed, era, flag));
  }
}

describe("aggregate", () => {
  test("computes solve rate, $/solved, cutoff split, and flag rate", async () => {
    const repo = await tmp();
    await seedRun(repo);
    const model = await aggregate(repo, "2026-07-11T12:00:00Z");

    expect(model.configs.length).toBe(1);
    const c = model.configs[0]!;
    expect(c.tasksTotal).toBe(2);
    expect(c.tasksSolved).toBe(1); // t1 solved via attempt 1
    expect(c.solveRate).toBe(0.5);
    // $/solved = total dollars (0.10+0.10+0.20+0.20 = 0.60) / 1 solved
    expect(c.dollarsPerSolvedTask).toBeCloseTo(0.6, 5);
    // cutoff split: t1 is pre (solved), t2 is post (unsolved)
    expect(c.split.pre.tasksTotal).toBe(1);
    expect(c.split.pre.tasksSolved).toBe(1);
    expect(c.split.post.tasksTotal).toBe(1);
    expect(c.split.post.tasksSolved).toBe(0);
    // regurgitation: 1 flagged of 2 pre-cutoff attempts
    expect(c.flaggedCount).toBe(1);
    expect(c.preCutoffAttempts).toBe(2);
    expect(c.flagRate).toBe(0.5);
    // suite soundness surfaced
    expect(model.suite.soundnessRate).toBeCloseTo(2 / 5, 5);
    // taxonomy heatmap has the two kinds
    expect(model.taxonomy.kinds.sort()).toEqual(["bugfix", "feature"]);
  });

  test("partial-cost coverage: a null-dollar attempt is not summed as $0 (executive number stays honest)", async () => {
    const repo = await tmp();
    await writeConfig(repo, ConfigSchema.parse({ testCmd: "bun test" }));
    await writeSuite(repo, { taskIds: ["t1"], soundnessRate: { admitted: 1, candidates: 1 }, minedAt: "2026-07-01T00:00:00Z" });
    await writeTask(repo, task("t1", "2026-05-01T00:00:00Z", "bugfix", ["core"]));
    await writeRunConfig(repo, { runId: "r1", adapter: "claude-code", model: "opus", nAttempts: 2, budgets: undefined });
    // Attempt 1 priced ($0.50, solves), attempt 2 crashed with NO cost figure.
    await writeSolutionDiff(repo, "r1", "t1", 1, "+x");
    await writeAttempt(repo, "r1", { taskId: "t1", attempt: 1, wallclockMs: 1000, tokens: { input: 5, output: 10, cacheRead: 0, cacheCreation: 0 }, dollars: 0.5, exit: "completed" });
    await writeVerdict(repo, "r1", verdict("t1", 1, true, "post", false));
    await writeSolutionDiff(repo, "r1", "t1", 2, "");
    await writeAttempt(repo, "r1", { taskId: "t1", attempt: 2, wallclockMs: 500, tokens: null, dollars: null, exit: "crashed" });
    await writeVerdict(repo, "r1", verdict("t1", 2, false, "post", false));

    const model = await aggregate(repo, "2026-07-11T12:00:00Z");
    const c = model.configs[0]!;
    expect(c.dollarsCoverage).toEqual({ known: 1, total: 2 });
    expect(c.totalDollars).toBe(0.5); // ONLY the priced attempt, not 0.5+0
    expect(c.dollarsPerSolvedTask).toBe(0.5);
    // The template marks it a lower bound (≥) since coverage is partial.
    const html = renderReportHtml(model);
    expect(html).toContain("≥$0.50");
    expect(html).toContain("1/2 attempts priced");
  });

  test("an empty store yields a renderable, empty model (soft state, not a crash)", async () => {
    const repo = await tmp();
    await writeConfig(repo, ConfigSchema.parse({ testCmd: "bun test" }));
    const model = await aggregate(repo, "2026-07-11T12:00:00Z");
    expect(model.configs).toEqual([]);
    expect(() => renderReportHtml(model)).not.toThrow();
  });
});

describe("template — self-contained offline invariant (§1, §8)", () => {
  function render(repo: Promise<string>): Promise<string> {
    return repo.then(async (r) => {
      await seedRun(r);
      return renderReportHtml(await aggregate(r, "2026-07-11T12:00:00Z"));
    });
  }

  test("renders every §8 section and the headline number", async () => {
    const html = await render(tmp());
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("The Referee's Report");
    expect(html).toContain("$ per solved task");
    expect(html).toContain("Leaderboard");
    expect(html).toContain("Cutoff split"); // default visibility is "unknown" → informational framing
    expect(html).toContain("Taxonomy heatmap");
    expect(html).toContain("suite soundness");
    expect(html).toContain("Methodology");
    expect(html).toContain("the green that proved itself");
  });

  test("is fully self-contained — no external network references", async () => {
    const html = await render(tmp());
    expect(html).not.toMatch(/https?:\/\//); // no CDN/webfont/remote anything
    expect(html).not.toContain("<script src");
    expect(html).not.toContain('rel="stylesheet"');
    expect(html.toLowerCase()).not.toContain("cdn");
    expect(html.toLowerCase()).not.toContain("fonts.google");
  });

  test("cutoff-split framing is provenance-aware (contamination vs freshness)", async () => {
    const base = await tmp();
    await seedRun(base);

    // public → contamination framing ("clean" / "possibly seen"), pre grayed.
    await writeConfig(base, ConfigSchema.parse({ testCmd: "bun test", repoVisibility: "public" }));
    const pub = renderReportHtml(await aggregate(base, "2026-07-11T12:00:00Z"));
    expect(pub).toContain("Contamination split");
    expect(pub).toContain("possibly seen");
    expect(pub).toContain("split-pre split-pre-gray"); // pre column grayed (class applied)
    expect(pub).toContain("suggestive, not dispositive");

    // private → knowledge-freshness framing, NO contamination claim, pre NOT grayed.
    await writeConfig(base, ConfigSchema.parse({ testCmd: "bun test", repoVisibility: "private" }));
    const priv = renderReportHtml(await aggregate(base, "2026-07-11T12:00:00Z"));
    expect(priv).toContain("knowledge freshness");
    expect(priv).not.toContain("possibly seen");
    expect(priv).not.toContain("split-pre split-pre-gray"); // gray class NOT applied
    expect(priv).toContain("memorization-contamination risk is low");

    // unknown (default) → neutral, prompts to set visibility, no contamination claim.
    await writeConfig(base, ConfigSchema.parse({ testCmd: "bun test" }));
    const unk = renderReportHtml(await aggregate(base, "2026-07-11T12:00:00Z"));
    expect(unk).toContain("informational");
    expect(unk).toContain("repoVisibility");
    expect(unk).not.toContain("possibly seen");
  });

  test("escapes model-derived strings", () => {
    const model: ReportModel = {
      generatedAt: "2026-07-11T12:00:00Z",
      repoName: "<script>evil</script>",
      repoVisibility: "unknown",
      suite: { admitted: 1, candidates: 2, soundnessRate: 0.5, minedAt: "2026-07-01T00:00:00Z" },
      configs: [], taxonomy: { forLabel: null, kinds: [], areas: [], cells: [], areasOmitted: 0 },
      methodology: { gateReplays: 2, cutoffRegistryVersion: "v", adapters: [], totalRuns: 0, totalAttempts: 0 },
    };
    const html = renderReportHtml(model);
    expect(html).not.toContain("<script>evil");
    expect(html).toContain("&lt;script&gt;evil");
  });
});
