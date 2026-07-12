import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runMine, buildVerifierCmd } from "../src/mine/index.ts";
import { classifyPaths, isTestFile, isSourceFile } from "../src/mine/classify.ts";
import { discover, compileLoosePrefix } from "../src/mine/discover.ts";
import { buildPromptContext, reconstructPrompt } from "../src/mine/prompt.ts";
import { buildTaxonomy, kindOf, areasOf } from "../src/mine/taxonomy.ts";
import { writeConfig, readTask, listTaskIds, readCandidateLog } from "../src/core/store.ts";
import { readTruth } from "../src/core/truth.ts";
import { ConfigSchema } from "../src/core/schema.ts";

// --- pure-function units ---

describe("classify", () => {
  test("recognizes test files by infix and directory", () => {
    expect(isTestFile("src/calc.test.ts")).toBe(true);
    expect(isTestFile("pkg/tests/calc.ts")).toBe(true);
    expect(isTestFile("a/__tests__/b.ts")).toBe(true);
    expect(isTestFile("api/user_test.go")).toBe(true);
    expect(isTestFile("api/test_user.py")).toBe(true);
    expect(isTestFile("src/calc.ts")).toBe(false);
  });
  test("source files are code and not tests; docs/locks are neither", () => {
    expect(isSourceFile("src/calc.ts")).toBe(true);
    expect(isSourceFile("src/calc.test.ts")).toBe(false);
    expect(isSourceFile("README.md")).toBe(false);
    expect(isSourceFile("bun.lock")).toBe(false);
  });
  test("classifyPaths splits and drops non-code", () => {
    const { testPaths, sourcePaths } = classifyPaths(["a/x.test.ts", "a/x.ts", "README.md"]);
    expect(testPaths).toEqual(["a/x.test.ts"]);
    expect(sourcePaths).toEqual(["a/x.ts"]);
  });
});

describe("discover", () => {
  const loose = compileLoosePrefix(undefined);
  test("test+source delta fires on co-changed files", () => {
    expect(discover({ subject: "whatever", body: "", hasTest: true, hasSource: true }, loose)).toContain("test-source-delta");
  });
  test("conventional prefixes fire", () => {
    expect(discover({ subject: "fix(auth): x", body: "", hasTest: false, hasSource: true }, loose)).toContain("conventional");
  });
  test("loose scope prefixes fire but URLs do not", () => {
    expect(discover({ subject: "GL: rounding", body: "", hasTest: false, hasSource: true }, loose)).toContain("loose-prefix");
    expect(discover({ subject: "https://example.com broke", body: "", hasTest: false, hasSource: true }, loose)).not.toContain("loose-prefix");
  });
  test("issue links fire", () => {
    expect(discover({ subject: "patch thing", body: "fixes #142", hasTest: false, hasSource: true }, loose)).toContain("issue-linked");
  });
  test("a plain commit with no signal is not a candidate", () => {
    expect(discover({ subject: "wip", body: "", hasTest: false, hasSource: false }, loose)).toEqual([]);
  });
});

describe("prompt reconstruction (firewall)", () => {
  test("strips trailers and keeps the human description", () => {
    const ctx = buildPromptContext({
      sha: "x", parentSha: "y", isoDate: "", authorEmail: "",
      subject: "fix: correct rounding",
      body: "The total was off by a cent.\n\nCo-authored-by: Someone <s@x.co>\nSigned-off-by: Dev <d@x.co>",
    });
    expect(ctx.body).toContain("off by a cent");
    expect(ctx.body).not.toContain("Co-authored-by");
    const prompt = reconstructPrompt(ctx);
    expect(prompt).toContain("correct rounding");
    expect(prompt).not.toContain("Signed-off-by");
  });
  test("collects issue refs", () => {
    const ctx = buildPromptContext({ sha: "x", parentSha: "y", isoDate: "", authorEmail: "", subject: "fix #7 and #7", body: "also #12" });
    expect(ctx.issueRefs.sort()).toEqual(["#12", "#7"]);
  });
});

describe("taxonomy", () => {
  test("kind inference", () => {
    expect(kindOf("feat: add x")).toBe("feature");
    expect(kindOf("refactor: tidy")).toBe("refactor");
    expect(kindOf("fix: bug")).toBe("bugfix");
  });
  test("areas skip ubiquitous segments and dedupe", () => {
    expect(areasOf(["pkg/src/services/ledger.ts", "pkg/src/services/tax.ts"], "pkg")).toEqual(["services"]);
  });
  test("size sums numstat", () => {
    const t = buildTaxonomy("fix: x", ["a.ts"], [{ path: "a.ts", added: 10, deleted: 4 }]);
    expect(t.size).toEqual({ lines: 14, files: 1 });
  });
});

describe("buildVerifierCmd", () => {
  test("scopes the test cmd to subdir-relative test paths", () => {
    expect(buildVerifierCmd("bun test", ["pkg/tests/x.test.ts"], "pkg")).toBe("bun test 'tests/x.test.ts'");
    expect(buildVerifierCmd("bun test", ["tests/x.test.ts"], undefined)).toBe("bun test 'tests/x.test.ts'");
  });
  test("single-quotes paths so shell metacharacters can't expand or mangle", () => {
    // A path with `$` must not be shell-expanded when run under `sh -c`.
    expect(buildVerifierCmd("bun test", ["tests/foo$bar.test.ts"], undefined)).toBe("bun test 'tests/foo$bar.test.ts'");
    // An embedded single quote is escaped as '\'' and stays a literal.
    expect(buildVerifierCmd("bun test", ["tests/a'b.test.ts"], undefined)).toBe("bun test 'tests/a'\\''b.test.ts'");
  });
});

// --- end-to-end against a synthetic git repo ---

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "guignet-mine-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function sh(cmd: string, cwd: string): Promise<void> {
  const p = Bun.spawn(["sh", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe" });
  const code = await p.exited;
  if (code !== 0) throw new Error(`cmd failed (${code}): ${cmd}\n${await new Response(p.stderr).text()}`);
}

async function commit(repo: string, files: Record<string, string>, message: string): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(repo, path, ".."), { recursive: true });
    await writeFile(join(repo, path), content, "utf-8");
  }
  await sh("git add -A", repo);
  await sh(`git commit -q -m ${JSON.stringify(message)}`, repo);
}

async function initRepo(): Promise<string> {
  const repo = await tmp();
  await sh("git init -q && git config user.email t@t.co && git config user.name t && git config commit.gpgsign false", repo);
  return repo;
}

describe("runMine end-to-end", () => {
  test("reconstructs a task from a test+source fix commit, holding truth separately", async () => {
    const repo = await initRepo();
    await commit(repo, { "src/calc.ts": "export const add = (a,b) => a - b;\n" }, "seed: buggy calc");
    await commit(
      repo,
      { "src/calc.ts": "export const add = (a,b) => a + b;\n", "tests/calc.test.ts": "import {add} from '../src/calc';\ntest('adds',()=>{ if(add(1,2)!==3) throw new Error('x'); });\n" },
      "fix: add() should add, not subtract",
    );
    await writeConfig(repo, ConfigSchema.parse({ testCmd: "bun test" }));

    const run = await runMine({ repoRoot: repo, json: true, force: false });
    expect(run.code).toBe(0);
    const summary = JSON.parse(run.stdout);
    expect(summary.reconstructed).toBe(1);

    const ids = await listTaskIds(repo);
    expect(ids.length).toBe(1);
    const task = await readTask(repo, ids[0]!);
    expect(task.taxonomy.kind).toBe("bugfix");
    expect(task.discoveredBy).toContain("test-source-delta");
    expect(task.discoveredBy).toContain("conventional");
    expect(task.verifierCmd).toContain("tests/calc.test.ts");
    // Prompt is the human message, never the diff.
    expect(task.prompt).toContain("add() should add");
    expect(task.prompt).not.toContain("a + b");

    // Ground truth is held out, split into fix + verifier.
    const truth = await readTruth(repo, ids[0]!);
    expect(truth.fixDiff).toContain("src/calc.ts");
    expect(truth.fixDiff).toContain("a + b");
    expect(truth.verifierDiff).toContain("tests/calc.test.ts");
  });

  test("emits a conformant suite.mined event to the spine when enabled (§13)", async () => {
    const repo = await initRepo();
    await commit(repo, { "src/c.ts": "export const y = () => 0;\n" }, "seed");
    await commit(repo, { "src/c.ts": "export const y = () => 1;\n", "tests/c.test.ts": "test('y',()=>{});\n" }, "fix: y");
    await writeConfig(repo, ConfigSchema.parse({ testCmd: "bun test", spine: "on" }));

    await runMine({ repoRoot: repo, json: true, force: false });

    const { readdir, readFile } = await import("node:fs/promises");
    const eventsDir = join(repo, ".suite", "events");
    const files = await readdir(eventsDir);
    expect(files.length).toBe(1);
    const line = (await readFile(join(eventsDir, files[0]!), "utf-8")).trim();
    const ev = JSON.parse(line);
    expect(ev.source).toBe("guignet");
    expect(ev.type).toBe("suite.mined");
    expect(typeof ev.data.candidates).toBe("number");
    expect(ev.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("does NOT create .suite/ under default (auto) visibility", async () => {
    const repo = await initRepo();
    await commit(repo, { "src/c.ts": "export const y = () => 0;\n" }, "seed");
    await commit(repo, { "src/c.ts": "export const y = () => 1;\n", "tests/c.test.ts": "test('y',()=>{});\n" }, "fix: y");
    await writeConfig(repo, ConfigSchema.parse({ testCmd: "bun test" })); // spine defaults to "auto"
    await runMine({ repoRoot: repo, json: true, force: false });
    const { readdir } = await import("node:fs/promises");
    await expect(readdir(join(repo, ".suite"))).rejects.toBeTruthy(); // never introduced
  });

  test("discards a source-only commit with a clear reason", async () => {
    const repo = await initRepo();
    await commit(repo, { "src/a.ts": "export const x = 1;\n" }, "seed");
    await commit(repo, { "src/a.ts": "export const x = 2;\n" }, "refactor: bump x");
    await writeConfig(repo, ConfigSchema.parse({ testCmd: "bun test" }));

    const run = await runMine({ repoRoot: repo, json: true, force: false });
    const summary = JSON.parse(run.stdout);
    expect(summary.reconstructed).toBe(0);
    expect(run.code).toBe(3); // soft-blocked: nothing to gate
    const log = await readCandidateLog(repo);
    const discarded = log.candidates.find((c) => c.outcome === "discarded");
    expect(discarded?.discardReason).toContain("no test files");
  });

  test("resume: a second run without --force reconstructs nothing new", async () => {
    const repo = await initRepo();
    await commit(repo, { "src/c.ts": "export const y = () => 0;\n" }, "seed");
    await commit(
      repo,
      { "src/c.ts": "export const y = () => 1;\n", "tests/c.test.ts": "test('y',()=>{});\n" },
      "fix: y returns 1",
    );
    await writeConfig(repo, ConfigSchema.parse({ testCmd: "bun test" }));

    await runMine({ repoRoot: repo, json: true, force: false });
    const before = await listTaskIds(repo);
    const second = await runMine({ repoRoot: repo, json: true, force: false });
    const summary = JSON.parse(second.stdout);
    // Still counted as reconstructed (present), but no new task dir appears.
    expect(await listTaskIds(repo)).toEqual(before);
    expect(summary.reconstructed).toBe(1);
  });
});
