import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mapLimit, defaultConcurrency } from "../src/run/pool.ts";
import { substituteCmd } from "../src/run/adapters/generic-cli.ts";
import { runRun } from "../src/run/index.ts";
import { agentEnv, spawnToFile } from "../src/core/proc.ts";
import { captureWorktreeDiff, git, worktreeAdd } from "../src/core/git.ts";
import { ConfigSchema, type Task } from "../src/core/schema.ts";
import { writeConfig, writeSuite, writeTask, attemptDir, readAttempt, writeAttempt } from "../src/core/store.ts";

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "guignet-run-test-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

// --- pool ---

describe("mapLimit", () => {
  test("preserves order and never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // actually ran concurrently
  });
  test("defaultConcurrency is a sane positive bound", () => {
    const c = defaultConcurrency();
    expect(c).toBeGreaterThanOrEqual(1);
    expect(c).toBeLessThanOrEqual(4);
  });
});

// --- generic-cli substitution ---

describe("substituteCmd", () => {
  test("single-quotes both {prompt} and {worktree}", () => {
    expect(substituteCmd("agent --task {prompt} --dir {worktree}", "fix the bug", "/tmp/wt")).toBe(
      "agent --task 'fix the bug' --dir '/tmp/wt'",
    );
  });
  test("a prompt with shell metacharacters can't break out", () => {
    const out = substituteCmd("agent {prompt}", "$(rm -rf /); `evil`", "/wt");
    expect(out).toBe("agent '$(rm -rf /); `evil`'"); // inert inside single quotes
  });
  test("a worktree path with a space is quoted so it stays one argument", () => {
    expect(substituteCmd("agent {worktree}", "p", "/tmp/a b/wt")).toBe("agent '/tmp/a b/wt'");
  });
});

// --- supervision: spawnToFile streams and enforces a timeout ---

describe("spawnToFile", () => {
  test("streams stdout/stderr to files and returns exit code", async () => {
    const d = await tmp();
    const r = await spawnToFile(["sh", "-c", "echo out; echo err 1>&2; exit 3"], {
      cwd: d,
      stdoutPath: join(d, "o.log"),
      stderrPath: join(d, "e.log"),
    });
    expect(r.code).toBe(3);
    expect(r.timedOut).toBe(false);
    expect((await readFile(join(d, "o.log"), "utf-8")).trim()).toBe("out");
    expect((await readFile(join(d, "e.log"), "utf-8")).trim()).toBe("err");
  });
  test("a hung process is killed at the timeout", async () => {
    const d = await tmp();
    const r = await spawnToFile(["sh", "-c", "sleep 10"], {
      cwd: d,
      stdoutPath: join(d, "o.log"),
      stderrPath: join(d, "e.log"),
      timeoutMs: 200,
    });
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
  });
  test("timeout kills the whole process tree, not just the direct child", async () => {
    const d = await tmp();
    const pidFile = join(d, "child.pid");
    // sh spawns a background sleep (a grandchild of us), records its pid, then
    // sleeps itself. On timeout the grandchild must be reaped too.
    await spawnToFile(["sh", "-c", `sleep 30 & echo $! > ${pidFile}; sleep 30`], {
      cwd: d,
      stdoutPath: join(d, "o.log"),
      stderrPath: join(d, "e.log"),
      timeoutMs: 400,
    });
    await new Promise((r) => setTimeout(r, 250)); // let killTree finish
    const pid = Number((await readFile(pidFile, "utf-8")).trim());
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });
});

// --- agent env: git redirect vars must not reach the agent ---

describe("agentEnv", () => {
  test("drops git variables that would point the agent's git at another repo; keeps the rest", () => {
    const env = agentEnv(
      { GUIGNET_PROMPT: "p" },
      { PATH: "/bin", GIT_DIR: "/real/.git", GIT_WORK_TREE: "/real", GIT_INDEX_FILE: "/real/.git/index", GIT_COMMON_DIR: "/real/.git", GIT_OBJECT_DIRECTORY: "/o", GIT_ALTERNATE_OBJECT_DIRECTORIES: "/a", GIT_AUTHOR_NAME: "keep" },
    );
    expect(env).toEqual({ PATH: "/bin", GIT_AUTHOR_NAME: "keep", GUIGNET_PROMPT: "p" });
  });
});

// --- captureWorktreeDiff ---

async function initRepo(): Promise<{ repo: string; base: string }> {
  const repo = await tmp();
  const sh = async (c: string): Promise<void> => {
    const p = Bun.spawn(["sh", "-c", c], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    if ((await p.exited) !== 0) throw new Error(`${c}: ${await new Response(p.stderr).text()}`);
  };
  await sh("git init -q -b main && git config user.email t@t.co && git config user.name t && git config commit.gpgsign false");
  await writeFile(join(repo, "a.ts"), "export const x = 1;\n");
  await sh("git add -A && git commit -qm base");
  const base = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
  return { repo, base };
}

describe("captureWorktreeDiff", () => {
  test("captures modifications AND new files vs base", async () => {
    const { repo, base } = await initRepo();
    const wtRoot = await tmp();
    const wt = join(wtRoot, "wt");
    await worktreeAdd(repo, base, wt);
    await writeFile(join(wt, "a.ts"), "export const x = 2;\n"); // modify
    await writeFile(join(wt, "new.ts"), "export const y = 3;\n"); // add
    const diff = await captureWorktreeDiff(wt);
    expect(diff).toContain("a.ts");
    expect(diff).toContain("new.ts");
    expect(diff).toContain("export const y = 3");
    await git(["worktree", "remove", "--force", wt], repo);
  });
});

// --- end-to-end run with the generic-cli adapter over a synthetic suite ---

function makeTask(id: string, base: string): Task {
  return {
    id,
    prompt: "make the change",
    baseSha: base,
    sourceSha: base,
    date: new Date().toISOString(),
    taxonomy: { kind: "bugfix", size: { lines: 1, files: 1 }, areas: [] },
    verifierCmd: "true",
    discoveredBy: ["test-source-delta"],
  };
}

async function seedSuite(repo: string, base: string, ids: string[]): Promise<void> {
  await writeConfig(repo, ConfigSchema.parse({ testCmd: "bun test" }));
  await writeSuite(repo, { taskIds: ids, soundnessRate: { admitted: ids.length, candidates: ids.length }, minedAt: new Date().toISOString() });
  for (const id of ids) await writeTask(repo, makeTask(id, base));
}

// maxConcurrency is PINNED so tests never depend on the real machine's load
// (defaultConcurrency is load-aware; a busy CI box would otherwise vary the
// pool width — harmless in prod, nondeterministic in a test).
async function writeRunCfg(repo: string, cmd: string, nAttempts: number): Promise<string> {
  const path = join(repo, "run-config.json");
  await writeFile(path, JSON.stringify({ runId: "2026-07-11-mock", adapter: "generic-cli", nAttempts, genericCli: { cmd }, maxConcurrency: 2 }));
  return path;
}

describe("maxTotalDollars spend cap", () => {
  test("a run at/over its cap starts NO further attempts, and they stay resumable", async () => {
    const { repo, base } = await initRepo();
    await seedSuite(repo, base, ["t1", "t2"]);
    // One attempt already on disk cost $10 — the resume-aware sum must count
    // it against a $5 cap, so every remaining unit is capped, not run.
    await writeAttempt(repo, "2026-07-11-mock", {
      taskId: "t1", attempt: 1, wallclockMs: 1, tokens: null, dollars: 10, exit: "completed",
    });
    const cfg = join(repo, "run-config.json");
    await writeFile(cfg, JSON.stringify({
      runId: "2026-07-11-mock", adapter: "generic-cli", nAttempts: 2,
      genericCli: { cmd: "echo ran > mark.txt" }, maxConcurrency: 2, maxTotalDollars: 5,
    }));

    const run = await runRun({ repoRoot: repo, json: true, force: false, config: cfg });
    expect(run.code).toBe(0);
    const out = JSON.parse(run.stdout);
    expect(out.skipped).toBe(1); // the pre-existing t1#1 (resume)
    expect(out.attempted).toBe(0); // nothing new ran
    expect(out.budgetCapped).toBe(3); // t1#2, t2#1, t2#2 all held
    expect(out.spentDollars).toBe(10); // the all-time spend that tripped the cap, surfaced
    // Capped units wrote NO attempt.json — a raised cap re-runs exactly them.
    await expect(readAttempt(repo, "2026-07-11-mock", "t2", 1)).rejects.toBeTruthy();
  });

  test("with no cap, behavior is unchanged (existing runs are unaffected)", async () => {
    const { repo, base } = await initRepo();
    await seedSuite(repo, base, ["t1"]);
    const cfg = await writeRunCfg(repo, "echo x > y.txt", 1);
    const out = JSON.parse((await runRun({ repoRoot: repo, json: true, force: false, config: cfg })).stdout);
    expect(out.attempted).toBe(1);
    expect(out.budgetCapped).toBe(0);
  });
});

describe("runRun end-to-end (generic-cli)", () => {
  test("runs N attempts per task, captures the agent's diff, and reports", async () => {
    const { repo, base } = await initRepo();
    await seedSuite(repo, base, ["t1"]);
    const cfg = await writeRunCfg(repo, "echo 'agent was here' > touched.txt", 3);

    const run = await runRun({ repoRoot: repo, json: true, force: false, config: cfg });
    expect(run.code).toBe(0);
    const out = JSON.parse(run.stdout);
    expect(out.attempted).toBe(3);
    expect(out.byExit.completed).toBe(3);

    // Each attempt persisted its solution diff, capturing the new file.
    for (let n = 1; n <= 3; n++) {
      const diff = await readFile(join(attemptDir(repo, "2026-07-11-mock", "t1", n), "solution.diff"), "utf-8");
      expect(diff).toContain("touched.txt");
      const att = await readAttempt(repo, "2026-07-11-mock", "t1", n);
      expect(att.exit).toBe("completed");
      expect(att.tokens).toBeNull(); // generic-cli reports no token cost
    }
  });

  test("setupCmd runs BEFORE the agent so it starts from a ready environment", async () => {
    const { repo, base } = await initRepo();
    // Config's setupCmd installs a "dep"; the agent (generic-cli) only succeeds
    // if that dep is already there — proving setup ran first, in the worktree.
    await writeConfig(repo, ConfigSchema.parse({ testCmd: "bun test", setupCmd: "echo dep > installed.txt" }));
    await writeSuite(repo, { taskIds: ["t1"], soundnessRate: { admitted: 1, candidates: 1 }, minedAt: new Date().toISOString() });
    await writeTask(repo, makeTask("t1", base));
    // The agent copies the dep into a new file; the diff will only contain it if
    // setup created installed.txt before the agent ran.
    const cfg = await writeRunCfg(repo, "cp installed.txt agent-used-dep.txt", 1);

    const run = await runRun({ repoRoot: repo, json: true, force: false, config: cfg });
    expect(JSON.parse(run.stdout).byExit.completed).toBe(1);
    const diff = await readFile(join(attemptDir(repo, "2026-07-11-mock", "t1", 1), "solution.diff"), "utf-8");
    expect(diff).toContain("agent-used-dep.txt"); // agent saw the installed dep
  });

  test("leak firewall: the agent's workspace has no path to the fix commit or the source repo", async () => {
    const { repo, base } = await initRepo();
    // The held-out fix lands AFTER the base — in the real repo it is just the
    // next commit, which a linked worktree's `git log --all` would reveal.
    await writeFile(join(repo, "a.ts"), "export const x = 2; // THE-SECRET-FIX\n");
    await Bun.spawn(["git", "commit", "-qam", "fix: secret"], { cwd: repo }).exited;
    const fix = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
    expect(fix).not.toBe(base);
    await seedSuite(repo, base, ["t1"]);

    // The "agent" is a script (kept OUTSIDE the repo) that probes its own cwd.
    const scriptDir = await tmp();
    const script = join(scriptDir, "probe.ts").replaceAll("\\", "/");
    await writeFile(
      script,
      `import { existsSync, lstatSync, writeFileSync } from "node:fs";
       const sh = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
       const out = (a: string[]) => sh(a).stdout.toString().trim();
       writeFileSync("probe.json", JSON.stringify({
         commits: out(["rev-list", "--all", "--count"]),
         fixReachable: sh(["cat-file", "-e", ${JSON.stringify(fix)}]).exitCode === 0,
         dotGitIsDir: lstatSync(".git").isDirectory(),
         commondir: existsSync(".git/commondir"),
         remotes: out(["remote"]),
         worktrees: out(["worktree", "list", "--porcelain"]).split("\\n").filter((l) => l.startsWith("worktree ")).length,
         a: (await Bun.file("a.ts").text()).replaceAll("\\r\\n", "\\n"),
       }));`,
    );
    const cfg = await writeRunCfg(repo, `bun "${script}"`, 1);

    const run = await runRun({ repoRoot: repo, json: true, force: false, config: cfg });
    expect(JSON.parse(run.stdout).byExit.completed).toBe(1);
    const diff = await readFile(join(attemptDir(repo, "2026-07-11-mock", "t1", 1), "solution.diff"), "utf-8");
    const probeSection = diff.slice(diff.indexOf("probe.json"));
    const probe = JSON.parse(
      probeSection
        .split("\n")
        .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
        .map((l) => l.slice(1))
        .join("\n"),
    );
    expect(probe.commits).toBe("1");
    expect(probe.fixReachable).toBe(false);
    expect(probe.dotGitIsDir).toBe(true);
    expect(probe.commondir).toBe(false);
    expect(probe.remotes).toBe("");
    expect(probe.worktrees).toBe(1);
    expect(probe.a).toBe("export const x = 1;\n"); // the BASE content, not the fix
    // The source repo registered no worktree for the agent either.
    expect((await git(["worktree", "list", "--porcelain"], repo)).stdout.split("\n").filter((l) => l.startsWith("worktree ")).length).toBe(1);
  });

  test("setup churn (tracked AND untracked) is excluded from the solution diff", async () => {
    const { repo } = await initRepo();
    // 'lock.txt' is a committed (tracked) file — like a lockfile setup rewrites.
    const sh = async (c: string): Promise<void> => {
      const p = Bun.spawn(["sh", "-c", c], { cwd: repo, stdout: "pipe", stderr: "pipe" });
      if ((await p.exited) !== 0) throw new Error(c);
    };
    await writeFile(join(repo, "lock.txt"), "v1\n");
    await sh("git add -A && git commit -qm 'add lock'");
    const base2 = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

    // Setup rewrites a TRACKED lockfile AND writes an UNTRACKED artifact.
    await writeConfig(repo, ConfigSchema.parse({ testCmd: "bun test", setupCmd: "echo v2 > lock.txt && echo cache > setup-cache.txt" }));
    await writeSuite(repo, { taskIds: ["t1"], soundnessRate: { admitted: 1, candidates: 1 }, minedAt: new Date().toISOString() });
    await writeTask(repo, { ...makeTask("t1", base2) });
    const cfg = await writeRunCfg(repo, "echo fix > realfix.ts", 1);

    await runRun({ repoRoot: repo, json: true, force: false, config: cfg });
    const diff = await readFile(join(attemptDir(repo, "2026-07-11-mock", "t1", 1), "solution.diff"), "utf-8");
    expect(diff).toContain("realfix.ts"); // the agent's actual work is captured
    expect(diff).not.toContain("lock.txt"); // setup's tracked churn is NOT
    expect(diff).not.toContain("setup-cache.txt"); // nor its untracked churn
  });

  test("resume: a second run skips completed attempts; --force redoes them", async () => {
    const { repo, base } = await initRepo();
    await seedSuite(repo, base, ["t1"]);
    const cfg = await writeRunCfg(repo, "echo x > f.txt", 2);

    await runRun({ repoRoot: repo, json: true, force: false, config: cfg });
    const resumed = JSON.parse((await runRun({ repoRoot: repo, json: true, force: false, config: cfg })).stdout);
    expect(resumed.attempted).toBe(0);
    expect(resumed.skipped).toBe(2);

    const forced = JSON.parse((await runRun({ repoRoot: repo, json: true, force: true, config: cfg })).stdout);
    expect(forced.attempted).toBe(2);
  });

  test("duplicate task ids in the suite are deduped (no colliding units)", async () => {
    const { repo, base } = await initRepo();
    await writeConfig(repo, ConfigSchema.parse({ testCmd: "bun test" }));
    await writeTask(repo, makeTask("t1", base));
    await writeSuite(repo, { taskIds: ["t1", "t1", "t1"], soundnessRate: { admitted: 1, candidates: 1 }, minedAt: new Date().toISOString() });
    const cfg = await writeRunCfg(repo, "echo x > f.txt", 2);
    const out = JSON.parse((await runRun({ repoRoot: repo, json: true, force: false, config: cfg })).stdout);
    expect(out.attempted).toBe(2); // 1 unique task × 2 attempts, not 6
  });

  test("a crashing agent command is recorded as a crashed attempt, not a thrown error", async () => {
    const { repo, base } = await initRepo();
    await seedSuite(repo, base, ["t1"]);
    const cfg = await writeRunCfg(repo, "exit 7", 1);
    const run = await runRun({ repoRoot: repo, json: true, force: false, config: cfg });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout).byExit.crashed).toBe(1);
  });

  /** Run `fn` while capturing everything written to process.stderr. */
  async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
    const orig = process.stderr.write.bind(process.stderr);
    let stderr = "";
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      return { result: await fn(), stderr };
    } finally {
      process.stderr.write = orig;
    }
  }

  test("an unexpected attempt error is logged with its task id, counted, and fails the run (not swallowed)", async () => {
    const { repo, base } = await initRepo();
    await seedSuite(repo, base, ["t1", "t2"]);
    // Sabotage t1: a FILE where its attempts dir must be makes runOneAttempt's
    // mkdir throw (it never reaches the adapter) — the "unexpected error" path.
    const sabotage = join(repo, ".guignet", "runs", "2026-07-11-mock", "attempts");
    await mkdir(sabotage, { recursive: true });
    await writeFile(join(sabotage, "t1"), "not a directory");
    const cfg = await writeRunCfg(repo, "echo x > f.txt", 1);

    const { result: run, stderr } = await captureStderr(() => runRun({ repoRoot: repo, json: true, force: false, config: cfg }));
    const out = JSON.parse(run.stdout);
    expect(run.code).toBe(1); // non-zero: the run is incomplete
    expect(out.errored).toBe(1);
    expect(out.attempted).toBe(1); // t2 still ran — one bad unit doesn't abort the pool
    expect(stderr).toContain("t1#1 errored");
    // The errored unit wrote no attempt.json, so a resume retries exactly it.
    await expect(readAttempt(repo, "2026-07-11-mock", "t1", 1)).rejects.toBeTruthy();
    expect((await readAttempt(repo, "2026-07-11-mock", "t2", 1)).exit).toBe("completed");
  });

  test("a suite task whose task.json is unreadable is logged and counted, not silently skipped", async () => {
    const { repo, base } = await initRepo();
    await seedSuite(repo, base, ["t1"]);
    await writeSuite(repo, { taskIds: ["t1", "ghost"], soundnessRate: { admitted: 2, candidates: 2 }, minedAt: new Date().toISOString() });
    const cfg = await writeRunCfg(repo, "echo x > f.txt", 1);

    const { result: run, stderr } = await captureStderr(() => runRun({ repoRoot: repo, json: true, force: false, config: cfg }));
    const out = JSON.parse(run.stdout);
    expect(out.unreadableTasks).toBe(1);
    expect(out.attempted).toBe(1);
    expect(run.code).toBe(1);
    expect(stderr).toContain("ghost");
  });

  test("an unsafe runId in the run config is rejected before anything is written", async () => {
    const { repo, base } = await initRepo();
    await seedSuite(repo, base, ["t1"]);
    const cfg = join(repo, "bad-run.json");
    await writeFile(cfg, JSON.stringify({ runId: "../escape", adapter: "generic-cli", nAttempts: 1, genericCli: { cmd: "true" } }));
    const run = await runRun({ repoRoot: repo, json: true, force: false, config: cfg });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("invalid run config");
    expect(existsSync(join(repo, ".guignet", "escape"))).toBe(false);
  });

  test("no --config is a usage error; empty suite soft-blocks", async () => {
    const { repo } = await initRepo();
    const noCfg = await runRun({ repoRoot: repo, json: true, force: false });
    expect(noCfg.code).toBe(2);

    await writeConfig(repo, ConfigSchema.parse({ testCmd: "bun test" }));
    await writeSuite(repo, { taskIds: [], soundnessRate: { admitted: 0, candidates: 0 }, minedAt: new Date().toISOString() });
    const cfg = await writeRunCfg(repo, "true", 1);
    const empty = await runRun({ repoRoot: repo, json: true, force: false, config: cfg });
    expect(empty.code).toBe(3);
  });
});
