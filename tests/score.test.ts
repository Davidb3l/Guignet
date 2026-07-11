/**
 * `score` end-to-end tests. Each builds a REAL synthetic git repo in a tmpdir
 * and drives the whole verifier replay — no mocked git, no mocked subprocess.
 * Verifiers are tiny `bun run` scripts that assert against a local source file
 * and exit non-zero on failure: fast (no install, no network) yet exercising the
 * true apply-solution → apply-verifier → run → teardown path.
 *
 * Writing task.json / truth / solution.diff / run config directly here is
 * deliberate: score's upstream stages are off-limits, and the firewall +
 * boundary check govern `src/`, not tests.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { git } from "../src/core/index.ts";
import { ConfigSchema, RunConfigSchema, type Task } from "../src/core/schema.ts";
import { readVerdict, verdictExists, writeConfig, writeRunConfig, writeSolutionDiff, writeTask } from "../src/core/store.ts";
import { writeTruth } from "../src/core/truth.ts";
import { runScore } from "../src/score/index.ts";

const RUN_ID = "r1";
const MODEL = "test-model";
const CUTOFF = "2025-01-01";
const PRE_DATE = "2020-06-01T00:00:00.000Z"; // <= cutoff  ⇒ era "pre"
const POST_DATE = "2030-06-01T00:00:00.000Z"; // >  cutoff ⇒ era "post"

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "guignet-score-test-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function head(repo: string): Promise<string> {
  return (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
}
async function commit(repo: string, msg: string): Promise<void> {
  await git(["add", "-A"], repo);
  await git(["commit", "-qm", msg], repo);
}
function verifyScript(mod: string, sym: string, expected: number): string {
  return `import { ${sym} } from "${mod}";\nif (${sym}(2, 3) !== ${expected}) { console.error("FAIL"); process.exit(1); }\n`;
}

/**
 * A repo with four commits, giving every diff the tests need:
 *   base  : a.ts=(a-b)  (buggy)
 *   fix   : a.ts=(a+b)  + verifyA (asserts f(2,3)===5)
 *   bad   : a.ts=(a*b)  (a WRONG fix — f(2,3)=6, not 5)
 *   bloat : a.ts=(a+b) preceded by a comment line (CORRECT but +2 lines vs +1)
 * All tasks share the base sha and the verifyA verifier.
 */
async function scaffold() {
  const repo = await tmp();
  await git(["init", "-q", "-b", "main"], repo);
  await git(["config", "user.email", "t@example.com"], repo);
  await git(["config", "user.name", "Test"], repo);

  await Bun.write(join(repo, "a.ts"), "export const f = (a: number, b: number) => a - b;\n");
  await commit(repo, "base (buggy a.ts)");
  const base = await head(repo);

  await Bun.write(join(repo, "a.ts"), "export const f = (a: number, b: number) => a + b;\n");
  await Bun.write(join(repo, "verifyA.ts"), verifyScript("./a.ts", "f", 5));
  await commit(repo, "fix a.ts + add verifier");
  const fixSha = await head(repo);

  await Bun.write(join(repo, "a.ts"), "export const f = (a: number, b: number) => a * b;\n");
  await commit(repo, "wrong fix (a*b)");
  const badSha = await head(repo);

  // Correct behaviour (a+b) but a larger change: an extra comment line.
  await Bun.write(join(repo, "a.ts"), "// bloat: an unnecessary extra line\nexport const f = (a: number, b: number) => a + b;\n");
  await commit(repo, "bloated fix (correct but +2 lines)");
  const bloatSha = await head(repo);

  const diff = async (from: string, to: string, path: string): Promise<string> =>
    (await git(["diff", from, to, "--", path], repo)).stdout;

  return {
    repo,
    base,
    verifierA: await diff(base, fixSha, "verifyA.ts"),
    fixGood: await diff(base, fixSha, "a.ts"), // a-b -> a+b  (makes f===5), +1 line
    fixBad: await diff(base, badSha, "a.ts"), // a-b -> a*b   (leaves f===6)
    fixBloat: await diff(base, bloatSha, "a.ts"), // a-b -> comment+(a+b), +2 lines
  };
}

/** Target config with a known model cutoff so era splits are deterministic. */
async function writeScoreConfig(repo: string): Promise<void> {
  await writeConfig(repo, ConfigSchema.parse({ testCmd: "bun run verifyA.ts", cutoffs: { [MODEL]: CUTOFF } }));
}

async function writeRun(repo: string): Promise<void> {
  await writeRunConfig(repo, RunConfigSchema.parse({ runId: RUN_ID, adapter: "claude-code", model: MODEL, nAttempts: 1 }));
}

function makeTask(id: string, base: string, date: string): Task {
  return {
    id,
    prompt: `task ${id}`,
    baseSha: base,
    sourceSha: base,
    date,
    taxonomy: { kind: "bugfix", size: { lines: 1, files: 1 }, areas: ["math"] },
    verifierCmd: "bun run verifyA.ts",
    discoveredBy: ["test-source-delta"],
  };
}

/** Stand up one task (task.json + truth) and one attempt's solution.diff. */
async function seedTask(
  repo: string,
  s: Awaited<ReturnType<typeof scaffold>>,
  id: string,
  date: string,
  solutionDiff: string,
): Promise<void> {
  await writeTask(repo, makeTask(id, s.base, date));
  await writeTruth(repo, id, { fixDiff: s.fixGood, verifierDiff: s.verifierA });
  await writeSolutionDiff(repo, RUN_ID, id, 1, solutionDiff);
}

describe("score verdict", () => {
  test("(a) a correct solution makes the held-out verifier pass", async () => {
    const s = await scaffold();
    await writeScoreConfig(s.repo);
    await writeRun(s.repo);
    await seedTask(s.repo, s, "correct", POST_DATE, s.fixGood);

    const run = await runScore({ repoRoot: s.repo, json: true, force: false });
    expect(run.code).toBe(0);
    const out = JSON.parse(run.stdout);
    expect(out.scored).toBe(1);
    expect(out.passed).toBe(1);
    expect(out.failed).toBe(0);

    const v = await readVerdict(s.repo, RUN_ID, "correct", 1);
    expect(v.passed).toBe(true);
    expect(v.cutoffEra).toBe("post");
  });

  test("(b) a wrong solution leaves the verifier failing", async () => {
    const s = await scaffold();
    await writeScoreConfig(s.repo);
    await writeRun(s.repo);
    await seedTask(s.repo, s, "wrong", POST_DATE, s.fixBad);

    const run = await runScore({ repoRoot: s.repo, json: true, force: false });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout).failed).toBe(1);

    const v = await readVerdict(s.repo, RUN_ID, "wrong", 1);
    expect(v.passed).toBe(false);
  });

  test("(c) an empty solution.diff fails without spawning a worktree", async () => {
    const s = await scaffold();
    await writeScoreConfig(s.repo);
    await writeRun(s.repo);
    await seedTask(s.repo, s, "empty", POST_DATE, "");

    const run = await runScore({ repoRoot: s.repo, json: true, force: false });
    expect(run.code).toBe(0);
    const v = await readVerdict(s.repo, RUN_ID, "empty", 1);
    expect(v.passed).toBe(false);
    // Metrics are still computed from the (empty) diff + truth — no crash.
    expect(v.similarity).toBe(0);
    expect(v.regurgitationFlag).toBe(false);
  });

  test("(d) a near-verbatim solution flags regurgitation ONLY pre-cutoff", async () => {
    const s = await scaffold();
    await writeScoreConfig(s.repo);
    await writeRun(s.repo);
    // Same solution (identical to the ground-truth fix ⇒ similarity 1.0) on two
    // tasks that differ only by date. Pre-cutoff ⇒ flagged; post-cutoff ⇒ not.
    await seedTask(s.repo, s, "pre", PRE_DATE, s.fixGood);
    await seedTask(s.repo, s, "post", POST_DATE, s.fixGood);

    const run = await runScore({ repoRoot: s.repo, json: true, force: false });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout).flagged).toBe(1);

    const pre = await readVerdict(s.repo, RUN_ID, "pre", 1);
    expect(pre.cutoffEra).toBe("pre");
    expect(pre.similarity).toBe(1);
    expect(pre.regurgitationFlag).toBe(true);
    expect(pre.passed).toBe(true); // a correct fix can still be a regurgitated one

    const post = await readVerdict(s.repo, RUN_ID, "post", 1);
    expect(post.cutoffEra).toBe("post");
    expect(post.regurgitationFlag).toBe(false);
  });

  test("(e) resume: a second run without --force re-scores nothing", async () => {
    const s = await scaffold();
    await writeScoreConfig(s.repo);
    await writeRun(s.repo);
    await seedTask(s.repo, s, "correct", POST_DATE, s.fixGood);

    const first = await runScore({ repoRoot: s.repo, json: true, force: false });
    expect(JSON.parse(first.stdout).scored).toBe(1);
    expect(verdictExists(s.repo, RUN_ID, "correct", 1)).toBe(true);

    // Corrupt the ground truth so a genuine re-score would now FAIL to apply.
    await writeTruth(s.repo, "correct", { fixDiff: "not a diff\n", verifierDiff: "not a diff\n" });

    const resumed = await runScore({ repoRoot: s.repo, json: true, force: false });
    expect(resumed.code).toBe(0); // units exist — OK, not soft-blocked
    expect(JSON.parse(resumed.stdout).scored).toBe(0);
    expect(resumed.stderr).toContain("already scored");
    // The original verdict stands, untouched.
    expect((await readVerdict(s.repo, RUN_ID, "correct", 1)).passed).toBe(true);

    // With --force the corrupted truth is re-applied ⇒ the solution can't be
    // verified ⇒ the verdict flips to failed.
    const forced = await runScore({ repoRoot: s.repo, json: true, force: true });
    expect(JSON.parse(forced.stdout).scored).toBe(1);
    expect((await readVerdict(s.repo, RUN_ID, "correct", 1)).passed).toBe(false);
  });

  test("(f) bloatRatio is computed against the ground-truth fix", async () => {
    const s = await scaffold();
    await writeScoreConfig(s.repo);
    await writeRun(s.repo);
    // fixBloat is correct (f===5) but adds 2 lines where the truth fix adds 1.
    await seedTask(s.repo, s, "bloated", POST_DATE, s.fixBloat);

    const run = await runScore({ repoRoot: s.repo, json: false, force: false });
    expect(run.code).toBe(0);
    const v = await readVerdict(s.repo, RUN_ID, "bloated", 1);
    expect(v.passed).toBe(true); // still a correct solution
    expect(v.bloatRatio).toBe(2); // 2 added lines / 1 in the fix
  });

  test("(g) no runs on disk soft-blocks", async () => {
    const s = await scaffold();
    await writeScoreConfig(s.repo);
    const run = await runScore({ repoRoot: s.repo, json: true, force: false });
    expect(run.code).toBe(3);
    expect(JSON.parse(run.stdout).scored).toBe(0);
  });

  test("(h) an explicit unknown runId is an operational failure (exit 1)", async () => {
    const s = await scaffold();
    await writeScoreConfig(s.repo);
    const run = await runScore({ repoRoot: s.repo, json: true, force: false, runId: "does-not-exist" });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("does-not-exist");
  });

  test("(i) an attempt whose task is missing discards as a defensible fail", async () => {
    const s = await scaffold();
    await writeScoreConfig(s.repo);
    await writeRun(s.repo);
    // A solution.diff on disk for a task that was never written — score must not
    // crash; it discards this attempt as passed:false.
    await writeSolutionDiff(s.repo, RUN_ID, "ghost", 1, s.fixGood);

    const run = await runScore({ repoRoot: s.repo, json: true, force: false });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout).failed).toBe(1);
    const v = await readVerdict(s.repo, RUN_ID, "ghost", 1);
    expect(v.passed).toBe(false);
    expect(v.cutoffEra).toBe("unknown");
    expect(v.similarity).toBeNull();
  });

  test("(j) under --json, stdout is exactly one JSON object (logs go to stderr)", async () => {
    const s = await scaffold();
    await writeScoreConfig(s.repo);
    await writeRun(s.repo);
    await seedTask(s.repo, s, "correct", POST_DATE, s.fixGood);

    const run = await runScore({ repoRoot: s.repo, json: true, force: false });
    expect(() => JSON.parse(run.stdout)).not.toThrow();
    expect(run.stdout.trimEnd().includes("\n")).toBe(false); // single line, one object
    expect(run.stderr).toContain("PASSED");
  });
});
