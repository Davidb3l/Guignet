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
import { diffFilePaths, stripHeldOutPaths } from "../src/score/solution-filter.ts";

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

describe("solution-filter (pure)", () => {
  const NEW_FILE = // a brand-new file, as `git diff` renders it (--- /dev/null)
    "diff --git a/pkg/tests/new.test.ts b/pkg/tests/new.test.ts\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/pkg/tests/new.test.ts\n@@ -0,0 +1 @@\n+x\n";
  const SRC =
    "diff --git a/src/a.ts b/src/a.ts\nindex 2222222..3333333 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
  const VER_TOUCHED = // not test-classified by name — caught via the verifier path set
    "diff --git a/verify.ts b/verify.ts\nindex 4444444..5555555 100644\n--- a/verify.ts\n+++ b/verify.ts\n@@ -1 +1 @@\n-a\n+b\n";

  test("extracts paths from headers, ---/+++, and new-file blocks", () => {
    expect(diffFilePaths(NEW_FILE + SRC)).toEqual(new Set(["pkg/tests/new.test.ts", "src/a.ts"]));
  });

  test("drops verifier-path and test-classified blocks; keeps source blocks intact", () => {
    const { kept, droppedPaths } = stripHeldOutPaths(NEW_FILE + VER_TOUCHED + SRC, new Set(["verify.ts"]));
    expect(kept).toBe(SRC); // byte-identical — surgery removes whole blocks only
    expect(droppedPaths).toEqual(["pkg/tests/new.test.ts", "verify.ts"]);
  });

  test("a deleted content line resembling a --- header does not poison its block", () => {
    // A removed SQL comment `-- tests/x` renders as `--- tests/x` INSIDE a hunk;
    // path sniffing must have stopped at the block's first @@.
    const sql =
      "diff --git a/src/q.sql b/src/q.sql\nindex 6666666..7777777 100644\n--- a/src/q.sql\n+++ b/src/q.sql\n@@ -1,2 +1 @@\n--- tests/x\n select 1;\n";
    const { kept, droppedPaths } = stripHeldOutPaths(sql, new Set(["verify.ts"]));
    expect(kept).toBe(sql);
    expect(droppedPaths).toEqual([]);
  });
});

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

  // --- the verifier-authoritative overlay (score/verdict.ts header) ---
  // Agents habitually fix the source AND write their own tests, frequently in
  // the very file the held-out verifier patches. These pin the semantics: the
  // agent is judged on its source projection only; held-out-path edits are set
  // aside — neither punished (k) nor rewarded (l, m, n).

  test("(k) editing the verifier's file + a CORRECT source fix passes (edits set aside)", async () => {
    const s = await scaffold();
    await writeScoreConfig(s.repo);
    await writeRun(s.repo);
    // The agent fixes a.ts AND authors its own verifyA.ts — the same file the
    // held-out verifier CREATES ("already exists in working directory" under a
    // strict apply). The agent's version would FAIL if it were ever run; it
    // must not be, and must not block the verdict.
    await Bun.write(join(s.repo, "a.ts"), "export const f = (a: number, b: number) => a + b;\n");
    await Bun.write(join(s.repo, "verifyA.ts"), 'console.error("agent test ran"); process.exit(1);\n');
    await commit(s.repo, "agent: correct fix + own colliding test");
    const sha = await head(s.repo);
    const solution = (await git(["diff", s.base, sha, "--", "a.ts", "verifyA.ts"], s.repo)).stdout;
    await seedTask(s.repo, s, "collide-good", POST_DATE, solution);

    const run = await runScore({ repoRoot: s.repo, json: true, force: false });
    expect(run.code).toBe(0);
    const v = await readVerdict(s.repo, RUN_ID, "collide-good", 1);
    expect(v.passed).toBe(true);
    expect(v.testEditsFiltered).toBe(true);
    // Secondary metrics see the source-only projection: the judged diff IS the
    // ground-truth fix, so the agent's test file inflates/dilutes nothing.
    expect(v.similarity).toBe(1);
    expect(v.bloatRatio).toBe(1);
  });

  test("(l) rewriting the verifier to always-pass cannot save a WRONG fix", async () => {
    const s = await scaffold();
    await writeScoreConfig(s.repo);
    await writeRun(s.repo);
    // The gaming attempt: wrong fix (a*b) + a verifyA.ts that exits 0
    // unconditionally. The overlay restores the REAL verifier over its own
    // path, so the wrong fix is caught.
    await Bun.write(join(s.repo, "a.ts"), "export const f = (a: number, b: number) => a * b;\n");
    await Bun.write(join(s.repo, "verifyA.ts"), "process.exit(0);\n");
    await commit(s.repo, "agent: wrong fix + neutered verifier");
    const sha = await head(s.repo);
    const solution = (await git(["diff", s.base, sha, "--", "a.ts", "verifyA.ts"], s.repo)).stdout;
    await seedTask(s.repo, s, "collide-bad", POST_DATE, solution);

    const run = await runScore({ repoRoot: s.repo, json: true, force: false });
    expect(run.code).toBe(0);
    const v = await readVerdict(s.repo, RUN_ID, "collide-bad", 1);
    expect(v.passed).toBe(false);
    expect(v.testEditsFiltered).toBe(true);
  });

  test("(m) a solution that ONLY edits held-out paths has nothing to judge — fail", async () => {
    const s = await scaffold();
    await writeScoreConfig(s.repo);
    await writeRun(s.repo);
    await Bun.write(join(s.repo, "verifyA.ts"), "process.exit(0);\n");
    await commit(s.repo, "agent: test-only 'solution'");
    const sha = await head(s.repo);
    const solution = (await git(["diff", s.base, sha, "--", "verifyA.ts"], s.repo)).stdout;
    await seedTask(s.repo, s, "test-only", POST_DATE, solution);

    const run = await runScore({ repoRoot: s.repo, json: true, force: false });
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("no source change to judge");
    const v = await readVerdict(s.repo, RUN_ID, "test-only", 1);
    expect(v.passed).toBe(false);
    expect(v.testEditsFiltered).toBe(true);
  });

  test("(n) editing a test-classified helper OUTSIDE the verifier's paths is also set aside", async () => {
    // The subtler gaming vector: the verifier's test imports a helper the
    // verifier diff does NOT touch. An agent with a wrong fix edits that helper
    // to make the assertion agree with its bug. Test-classified paths are
    // filtered like verifier paths (same core/classify.ts rule mine split with,
    // so no correct fix can ever NEED them) — the wrong fix must still fail.
    const repo = await tmp();
    await git(["init", "-q", "-b", "main"], repo);
    await git(["config", "user.email", "t@example.com"], repo);
    await git(["config", "user.name", "Test"], repo);
    await Bun.write(join(repo, "a.ts"), "export const f = (a: number, b: number) => a - b;\n");
    await Bun.write(join(repo, "tests/helper.ts"), "export const EXPECTED = 5;\n");
    await commit(repo, "base (buggy) + helper");
    const base = await head(repo);
    await Bun.write(join(repo, "a.ts"), "export const f = (a: number, b: number) => a + b;\n");
    await Bun.write(
      join(repo, "verifyB.ts"),
      'import { f } from "./a.ts";\nimport { EXPECTED } from "./tests/helper.ts";\nif (f(2, 3) !== EXPECTED) { console.error("FAIL"); process.exit(1); }\n',
    );
    await commit(repo, "fix + verifier that imports the helper");
    const fixSha = await head(repo);
    // Agent: wrong fix (f=6) + helper bent to expect 6. Neither the verifier's
    // own file nor a verifier-diff path is touched.
    await Bun.write(join(repo, "a.ts"), "export const f = (a: number, b: number) => a * b;\n");
    await Bun.write(join(repo, "tests/helper.ts"), "export const EXPECTED = 6;\n");
    await commit(repo, "agent: wrong fix + bent helper");
    const agentSha = await head(repo);

    const diff = async (to: string, ...paths: string[]): Promise<string> =>
      (await git(["diff", base, to, "--", ...paths], repo)).stdout;
    await writeConfig(repo, ConfigSchema.parse({ testCmd: "bun run verifyB.ts", cutoffs: { [MODEL]: CUTOFF } }));
    await writeRunConfig(repo, RunConfigSchema.parse({ runId: RUN_ID, adapter: "claude-code", model: MODEL, nAttempts: 1 }));
    await writeTask(repo, { ...makeTask("bent-helper", base, POST_DATE), verifierCmd: "bun run verifyB.ts" });
    await writeTruth(repo, "bent-helper", { fixDiff: await diff(fixSha, "a.ts"), verifierDiff: await diff(fixSha, "verifyB.ts") });
    await writeSolutionDiff(repo, RUN_ID, "bent-helper", 1, await diff(agentSha, "a.ts", "tests/helper.ts"));

    const run = await runScore({ repoRoot: repo, json: true, force: false });
    expect(run.code).toBe(0);
    const v = await readVerdict(repo, RUN_ID, "bent-helper", 1);
    expect(v.passed).toBe(false); // EXPECTED stays 5; f(2,3)=6 — caught
    expect(v.testEditsFiltered).toBe(true);
  });

  test("(o) a solution with no held-out-path edits records testEditsFiltered:false", async () => {
    const s = await scaffold();
    await writeScoreConfig(s.repo);
    await writeRun(s.repo);
    await seedTask(s.repo, s, "clean", POST_DATE, s.fixGood);
    await runScore({ repoRoot: s.repo, json: true, force: false });
    const v = await readVerdict(s.repo, RUN_ID, "clean", 1);
    expect(v.passed).toBe(true);
    expect(v.testEditsFiltered).toBe(false);
  });

  test("(p) a verifier starved at low priority is retried once at normal priority — a correct fix passes", async () => {
    // Host citizenship runs verifiers at low scheduling priority, which is what
    // gets starved on a contended machine. A starved TIMEOUT must not score a
    // correct fix as a failure ("judge the fix, not the machine"): score retries
    // once at normal priority. Simulated deterministically: the verifier sleeps
    // past verifierTimeoutMs on its FIRST invocation (marker file outside the
    // worktree — resetWorktree wipes the worktree, not the test tmpdir) and
    // runs the real assertion on the second.
    const s = await scaffold();
    const marker = join(await tmp(), "first-run.marker");
    const flakyCmd = `if [ ! -f '${marker}' ]; then touch '${marker}'; sleep 30; fi; bun run verifyA.ts`;
    await writeConfig(
      s.repo,
      ConfigSchema.parse({ testCmd: flakyCmd, cutoffs: { [MODEL]: CUTOFF }, verifierTimeoutMs: 700 }),
    );
    await writeRun(s.repo);
    await writeTask(s.repo, { ...makeTask("retry", s.base, POST_DATE), verifierCmd: flakyCmd });
    await writeTruth(s.repo, "retry", { fixDiff: s.fixGood, verifierDiff: s.verifierA });
    await writeSolutionDiff(s.repo, RUN_ID, "retry", 1, s.fixGood);

    const run = await runScore({ repoRoot: s.repo, json: true, force: false });
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("normal-priority retry");
    const v = await readVerdict(s.repo, RUN_ID, "retry", 1);
    expect(v.passed).toBe(true); // the low-priority timeout did not fail a correct fix
  });

  test("(q) a verifier that genuinely hangs times out on the retry too and fails", async () => {
    const s = await scaffold();
    await writeConfig(
      s.repo,
      ConfigSchema.parse({ testCmd: "sleep 30", cutoffs: { [MODEL]: CUTOFF }, verifierTimeoutMs: 400 }),
    );
    await writeRun(s.repo);
    await writeTask(s.repo, { ...makeTask("hang", s.base, POST_DATE), verifierCmd: "sleep 30" });
    await writeTruth(s.repo, "hang", { fixDiff: s.fixGood, verifierDiff: s.verifierA });
    await writeSolutionDiff(s.repo, RUN_ID, "hang", 1, s.fixGood);

    const run = await runScore({ repoRoot: s.repo, json: true, force: false });
    expect(run.code).toBe(0);
    const v = await readVerdict(s.repo, RUN_ID, "hang", 1);
    expect(v.passed).toBe(false); // fail-safe: the retry only rescues real passes
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
