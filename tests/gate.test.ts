/**
 * `gate` end-to-end tests. Each builds a REAL synthetic git repo in a tmpdir and
 * drives the whole replay — no mocked git, no mocked subprocess. Verifiers are
 * tiny `bun run` scripts that assert against a local source file and exit
 * non-zero on failure: fast (no install, no network) yet exercising the true
 * apply → run → reset path.
 *
 * Writing task.json (store) and truth/ (core/truth.ts) directly here is
 * deliberate: gate's own upstream (`mine/`) is off-limits, and the firewall +
 * boundary check govern `src/`, not tests.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { git } from "../src/core/index.ts";
import { ConfigSchema, type Task } from "../src/core/schema.ts";
import { readGate, readSuite, writeCandidateLog, writeConfig, writeTask } from "../src/core/store.ts";
import { writeTruth } from "../src/core/truth.ts";
import { runGate } from "../src/gate/index.ts";

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "guignet-gate-test-"));
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
 * A repo with three commits, giving every diff the tests need:
 *   base : a.ts=(a-b)  (buggy)          b.ts=()=>5   (already correct)
 *   fix  : a.ts=(a+b)  + verifyA + verifyB (asserts f===5 / g===5), b.ts touched
 *   bad  : a.ts=(a*b)  (a WRONG fix — f(2,3)=6, not 5)
 * All tasks share the base sha; each names its own verifier command.
 */
async function scaffold() {
  const repo = await tmp();
  await git(["init", "-q", "-b", "main"], repo);
  await git(["config", "user.email", "t@example.com"], repo);
  await git(["config", "user.name", "Test"], repo);

  await Bun.write(join(repo, "a.ts"), "export const f = (a: number, b: number) => a - b;\n");
  await Bun.write(join(repo, "b.ts"), "export const g = (_a: number, _b: number) => 5;\n");
  await commit(repo, "base (buggy a.ts)");
  const base = await head(repo);

  await Bun.write(join(repo, "a.ts"), "export const f = (a: number, b: number) => a + b;\n");
  await Bun.write(join(repo, "b.ts"), "export const g = (_a: number, _b: number) => 5; // touched\n");
  await Bun.write(join(repo, "verifyA.ts"), verifyScript("./a.ts", "f", 5));
  await Bun.write(join(repo, "verifyB.ts"), verifyScript("./b.ts", "g", 5));
  await commit(repo, "fix a.ts + add tests");
  const fixSha = await head(repo);

  await Bun.write(join(repo, "a.ts"), "export const f = (a: number, b: number) => a * b;\n");
  await commit(repo, "wrong fix (a*b)");
  const badSha = await head(repo);

  const diff = async (from: string, to: string, path: string): Promise<string> =>
    (await git(["diff", from, to, "--", path], repo)).stdout;

  return {
    repo,
    base,
    verifierA: await diff(base, fixSha, "verifyA.ts"),
    verifierB: await diff(base, fixSha, "verifyB.ts"),
    fixGood: await diff(base, fixSha, "a.ts"), // a-b -> a+b  (makes f===5)
    fixBad: await diff(base, badSha, "a.ts"), // a-b -> a*b   (leaves f===6)
    fixB: await diff(base, fixSha, "b.ts"), // trivial b.ts change
  };
}

async function writeConfigDefault(repo: string): Promise<void> {
  await writeConfig(repo, ConfigSchema.parse({ testCmd: "bun run verify.ts" }));
}

function makeTask(id: string, base: string, verifierCmd: string): Task {
  return {
    id,
    prompt: `task ${id}`,
    baseSha: base,
    sourceSha: base,
    date: new Date().toISOString(),
    taxonomy: { kind: "bugfix", size: { lines: 1, files: 1 }, areas: ["math"] },
    verifierCmd,
    discoveredBy: ["test-source-delta"],
  };
}

describe("gate replay", () => {
  test("(a) a genuinely sound task is admitted", async () => {
    const s = await scaffold();
    await writeConfigDefault(s.repo);
    await writeTask(s.repo, makeTask("sound", s.base, "bun run verifyA.ts"));
    await writeTruth(s.repo, "sound", { fixDiff: s.fixGood, verifierDiff: s.verifierA });

    const run = await runGate({ repoRoot: s.repo, json: true, force: false });
    expect(run.code).toBe(0);
    const out = JSON.parse(run.stdout);
    expect(out.admitted).toBe(1);
    expect(out.discarded).toBe(0);

    const gate = await readGate(s.repo, "sound");
    expect(gate.admitted).toBe(true);
    expect(gate.discardReason).toBeNull();
    expect(gate.replays).toEqual({ failAtBase: 2, passAtFix: 2, k: 2 });
  });

  test("(b) a task whose verifier passes at base is discarded", async () => {
    const s = await scaffold();
    await writeConfigDefault(s.repo);
    // verifyB asserts g===5, which is already true at base ⇒ never fails ⇒ unsound.
    await writeTask(s.repo, makeTask("passes-at-base", s.base, "bun run verifyB.ts"));
    await writeTruth(s.repo, "passes-at-base", { fixDiff: s.fixB, verifierDiff: s.verifierB });

    const run = await runGate({ repoRoot: s.repo, json: false, force: false });
    expect(run.code).toBe(3); // soft-blocked: zero admitted
    const gate = await readGate(s.repo, "passes-at-base");
    expect(gate.admitted).toBe(false);
    expect(gate.replays.failAtBase).toBe(0);
    expect(gate.discardReason).toContain("passed at base");
  });

  test("(c) a task whose fix does not make the verifier pass is discarded", async () => {
    const s = await scaffold();
    await writeConfigDefault(s.repo);
    // Correct at base (fails: f=-1≠5) but the "fix" is wrong (f=6≠5) ⇒ never passes.
    await writeTask(s.repo, makeTask("bad-fix", s.base, "bun run verifyA.ts"));
    await writeTruth(s.repo, "bad-fix", { fixDiff: s.fixBad, verifierDiff: s.verifierA });

    const run = await runGate({ repoRoot: s.repo, json: false, force: false });
    expect(run.code).toBe(3);
    const gate = await readGate(s.repo, "bad-fix");
    expect(gate.admitted).toBe(false);
    expect(gate.replays.failAtBase).toBe(2);
    expect(gate.replays.passAtFix).toBe(0);
    expect(gate.discardReason).toContain("failed at fix");
  });

  test("(d) suite.json soundnessRate reflects admitted/total", async () => {
    const s = await scaffold();
    await writeConfigDefault(s.repo);
    await writeTask(s.repo, makeTask("sound", s.base, "bun run verifyA.ts"));
    await writeTruth(s.repo, "sound", { fixDiff: s.fixGood, verifierDiff: s.verifierA });
    await writeTask(s.repo, makeTask("unsound", s.base, "bun run verifyB.ts"));
    await writeTruth(s.repo, "unsound", { fixDiff: s.fixB, verifierDiff: s.verifierB });

    const run = await runGate({ repoRoot: s.repo, json: true, force: false });
    expect(run.code).toBe(0);

    const suite = await readSuite(s.repo);
    expect(suite.taskIds).toEqual(["sound"]);
    expect(suite.soundnessRate).toEqual({ admitted: 1, candidates: 2 });
    // minedAt is a valid ISO timestamp.
    expect(Number.isNaN(Date.parse(suite.minedAt))).toBe(false);
  });

  test("(e) resume skips an already-gated task unless --force", async () => {
    const s = await scaffold();
    await writeConfigDefault(s.repo);
    await writeTask(s.repo, makeTask("sound", s.base, "bun run verifyA.ts"));
    await writeTruth(s.repo, "sound", { fixDiff: s.fixGood, verifierDiff: s.verifierA });

    const first = await runGate({ repoRoot: s.repo, json: true, force: false });
    expect(JSON.parse(first.stdout).admitted).toBe(1);

    // Corrupt the ground truth so a genuine re-replay would now FAIL to apply.
    await writeTruth(s.repo, "sound", { fixDiff: "not a diff\n", verifierDiff: "not a diff\n" });

    // Without --force: the existing gate stands (task is skipped, not re-run).
    const resumed = await runGate({ repoRoot: s.repo, json: true, force: false });
    expect(resumed.stderr).toContain("already gated");
    expect(JSON.parse(resumed.stdout).admitted).toBe(1);
    expect((await readGate(s.repo, "sound")).admitted).toBe(true);

    // With --force: the task is re-evaluated against the now-broken truth ⇒ discarded.
    const forced = await runGate({ repoRoot: s.repo, json: true, force: true });
    expect(JSON.parse(forced.stdout).admitted).toBe(0);
    const gate = await readGate(s.repo, "sound");
    expect(gate.admitted).toBe(false);
    expect(gate.discardReason).toContain("git apply failed");
  });

  test("(f) setup runs once and node_modules survives the reset between replays", async () => {
    const s = await scaffold();
    // The verifier needs BOTH the fix (f===5) AND a dep that setup installs into
    // node_modules. If the reset nuked node_modules, replay 2 at fix would fail
    // for lack of the dep and the task would be discarded — so admission proves
    // node_modules is preserved across replays (and setup ran once).
    await Bun.write(
      join(s.repo, "verifyDep.ts"),
      `import { existsSync } from "node:fs";\nimport { f } from "./a.ts";\nif (!existsSync("node_modules/dep.marker")) { console.error("no dep"); process.exit(2); }\nif (f(2, 3) !== 5) process.exit(1);\n`,
    );
    await commit(s.repo, "add dep-requiring verifier");
    const depSha = await head(s.repo);
    const verifierDep = (await git(["diff", s.base, depSha, "--", "verifyDep.ts"], s.repo)).stdout;

    await writeConfig(
      s.repo,
      ConfigSchema.parse({ testCmd: "bun run verifyDep.ts", setupCmd: "mkdir -p node_modules && echo x > node_modules/dep.marker" }),
    );
    await writeTask(s.repo, makeTask("dep", s.base, "bun run verifyDep.ts"));
    await writeTruth(s.repo, "dep", { fixDiff: s.fixGood, verifierDiff: verifierDep });

    const run = await runGate({ repoRoot: s.repo, json: true, force: false });
    expect(JSON.parse(run.stdout).admitted).toBe(1);
    expect((await readGate(s.repo, "dep")).admitted).toBe(true);
  });

  test("(f2) preservePaths keeps a non-node_modules dep dir across replay resets", async () => {
    const s = await scaffold();
    // Like test (f), but the "installed" dep lives in `vendor/` — which the
    // reset wipes unless preservePaths names it. Admission proves it survived
    // every replay; the control (no preservePaths) proves the wipe is real.
    await Bun.write(
      join(s.repo, "verifyVendor.ts"),
      `import { existsSync } from "node:fs";\nimport { f } from "./a.ts";\nif (!existsSync("vendor/dep.marker")) { console.error("no vendor dep"); process.exit(2); }\nif (f(2, 3) !== 5) process.exit(1);\n`,
    );
    await commit(s.repo, "add vendor-requiring verifier");
    const vSha = await head(s.repo);
    const verifierVendor = (await git(["diff", s.base, vSha, "--", "verifyVendor.ts"], s.repo)).stdout;
    const seed = async (cfg: object): Promise<void> => {
      await writeConfig(s.repo, ConfigSchema.parse({ testCmd: "bun run verifyVendor.ts", setupCmd: "mkdir -p vendor && echo x > vendor/dep.marker", ...cfg }));
      await writeTask(s.repo, makeTask("vendor-dep", s.base, "bun run verifyVendor.ts"));
      await writeTruth(s.repo, "vendor-dep", { fixDiff: s.fixGood, verifierDiff: verifierVendor });
    };

    await seed({ preservePaths: ["vendor"] });
    const kept = await runGate({ repoRoot: s.repo, json: true, force: true });
    expect(JSON.parse(kept.stdout).admitted).toBe(1); // dep survived every reset

    await seed({}); // control: default reset wipes vendor/ → fail-safe discard
    const wiped = await runGate({ repoRoot: s.repo, json: true, force: true });
    expect(JSON.parse(wiped.stdout).admitted).toBe(0);
  });

  test("(g) a verifier that hangs is discarded via the timeout, not admitted", async () => {
    const s = await scaffold();
    // A tiny verifierTimeoutMs + a sleeping verifier ⇒ timeout at base ⇒ discard.
    await writeConfig(s.repo, ConfigSchema.parse({ testCmd: "sleep 30", verifierTimeoutMs: 400 }));
    await writeTask(s.repo, makeTask("hang", s.base, "sleep 30"));
    await writeTruth(s.repo, "hang", { fixDiff: s.fixGood, verifierDiff: s.verifierA });

    const run = await runGate({ repoRoot: s.repo, json: false, force: false });
    expect(run.code).toBe(3);
    const gate = await readGate(s.repo, "hang");
    expect(gate.admitted).toBe(false);
    expect(gate.discardReason).toContain("timed out");
  });

  test("(h) an unreadable config is an operational failure (exit 1)", async () => {
    const s = await scaffold();
    await Bun.write(join(s.repo, ".guignet", "config.json"), "{ not json");
    const run = await runGate({ repoRoot: s.repo, json: true, force: false });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("config");
  });

  test("(i) zero tasks soft-blocks and still writes an empty suite.json", async () => {
    const s = await scaffold();
    await writeConfigDefault(s.repo);
    const run = await runGate({ repoRoot: s.repo, json: true, force: false });
    expect(run.code).toBe(3);
    const suite = await readSuite(s.repo);
    expect(suite.taskIds).toEqual([]);
    expect(suite.soundnessRate).toEqual({ admitted: 0, candidates: 0 });
  });

  test("(k) soundnessRate denominator is discovered candidates, not reconstructed tasks", async () => {
    const s = await scaffold();
    await writeConfigDefault(s.repo);
    await writeTask(s.repo, makeTask("sound", s.base, "bun run verifyA.ts"));
    await writeTruth(s.repo, "sound", { fixDiff: s.fixGood, verifierDiff: s.verifierA });
    // mine discovered 4 candidates but only reconstructed 1 (this task); the
    // other 3 were dropped pre-reconstruction. The published rate must be 1/4,
    // not 1/1 — else it hides everything mine dropped (§5, §9 wedge).
    await writeCandidateLog(s.repo, {
      minedAt: new Date().toISOString(),
      candidates: [
        { sha: "a", subject: "x", date: "", discoveredBy: ["conventional"], outcome: "reconstructed", taskId: "sound", discardReason: null },
        { sha: "b", subject: "y", date: "", discoveredBy: ["conventional"], outcome: "discarded", taskId: null, discardReason: "no test files changed (nothing to verify)" },
        { sha: "c", subject: "z", date: "", discoveredBy: ["loose-prefix"], outcome: "discarded", taskId: null, discardReason: "no source files changed (nothing to fix)" },
        { sha: "d", subject: "w", date: "", discoveredBy: ["issue-linked"], outcome: "discarded", taskId: null, discardReason: "empty fix diff" },
      ],
    });

    const run = await runGate({ repoRoot: s.repo, json: true, force: false });
    const out = JSON.parse(run.stdout);
    expect(out.admitted).toBe(1);
    expect(out.evaluated).toBe(1); // one reconstructed task on disk
    expect(out.soundnessRate).toEqual({ admitted: 1, candidates: 4 }); // 1/4, not 1/1
    expect((await readSuite(s.repo)).soundnessRate).toEqual({ admitted: 1, candidates: 4 });
  });

  test("(l) a task whose base commit lacks the configured subdir is discarded with a clear reason", async () => {
    const s = await scaffold();
    // The scaffold's base commit has files at the repo root but no `pkg/` dir —
    // it predates the (fictional) package root, exactly like a task mined across
    // a monorepo restructure. Setup/verifier would otherwise be spawned with a
    // non-existent cwd and fail cryptically ("posix_spawn 'sh' ENOENT"). The
    // gate must instead discard with an honest, subdir-naming reason.
    await writeConfig(s.repo, ConfigSchema.parse({ testCmd: "bun run verifyA.ts", subdir: "pkg", setupCmd: "echo should-not-run" }));
    await writeTask(s.repo, makeTask("no-subdir-at-base", s.base, "bun run verifyA.ts"));
    await writeTruth(s.repo, "no-subdir-at-base", { fixDiff: s.fixGood, verifierDiff: s.verifierA });

    const run = await runGate({ repoRoot: s.repo, json: false, force: false });
    expect(run.code).toBe(3); // soft-blocked: zero admitted
    const gate = await readGate(s.repo, "no-subdir-at-base");
    expect(gate.admitted).toBe(false);
    expect(gate.discardReason).toContain("subdir 'pkg' does not exist at base commit");
    // The guard fires before setup — no cryptic spawn error leaks through.
    expect(gate.discardReason).not.toContain("posix_spawn");
    expect(gate.replays).toEqual({ failAtBase: 0, passAtFix: 0, k: 2 });
  });

  test("(m) testCwd 'repo' runs setup + verifier at the worktree root, not the subdir", async () => {
    // Model a workspace test runner that ONLY works from the repo root: the
    // verifier is a script that asserts its cwd is the worktree root (a
    // root-only marker file exists) and then checks the fix. Under the default
    // testCwd it would run inside `pkg/` and fail (fail-safe discard); under
    // testCwd:"repo" it runs at the root and the sound task is admitted.
    const s = await scaffold();
    // Put the real fix source + verifier UNDER pkg/ (so subdir mining is honest)
    // but make the verifier reach up and assert a repo-root-only condition.
    await Bun.write(join(s.repo, "root.marker"), "workspace-root\n");
    const rootOnlyVerifier =
      `import { existsSync } from "node:fs";\n` +
      `import { f } from "./a.ts";\n` + // sibling of this test file inside pkg/
      // "root.marker" is resolved against CWD: present only when the verifier
      // runs at the worktree ROOT (testCwd:"repo"), absent from inside pkg/.
      `if (!existsSync("root.marker")) { console.error("not at repo root"); process.exit(2); }\n` +
      `if (f(2, 3) !== 5) process.exit(1);\n`;
    // Build the pkg/ tree in a fresh commit on top of the scaffold base.
    await Bun.write(join(s.repo, "pkg", "a.ts"), "export const f = (a: number, b: number) => a - b;\n");
    await commit(s.repo, "add pkg with buggy a.ts");
    const pkgBase = await head(s.repo);
    await Bun.write(join(s.repo, "pkg", "a.ts"), "export const f = (a: number, b: number) => a + b;\n");
    await Bun.write(join(s.repo, "pkg", "wtroot.test.ts"), rootOnlyVerifier);
    await commit(s.repo, "fix pkg/a.ts + root-only verifier");
    const pkgFix = await head(s.repo);
    const d = async (path: string): Promise<string> => (await git(["diff", pkgBase, pkgFix, "--", path], s.repo)).stdout;

    // Verifier command is repo-root-relative (testCwd:"repo" ⇒ no subdir strip).
    await writeConfig(s.repo, ConfigSchema.parse({ testCmd: "bun run pkg/wtroot.test.ts", subdir: "pkg", testCwd: "repo" }));
    await writeTask(s.repo, makeTask("root-cwd", pkgBase, "bun run pkg/wtroot.test.ts"));
    await writeTruth(s.repo, "root-cwd", { fixDiff: await d("pkg/a.ts"), verifierDiff: await d("pkg/wtroot.test.ts") });

    const run = await runGate({ repoRoot: s.repo, json: true, force: false });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout).admitted).toBe(1);
    const gate = await readGate(s.repo, "root-cwd");
    expect(gate.admitted).toBe(true);
    expect(gate.replays).toEqual({ failAtBase: 2, passAtFix: 2, k: 2 });

    // Control: the SAME repo-root-relative verifier under the default (subdir)
    // testCwd runs with cwd=pkg/, where `pkg/wtroot.test.ts` resolves to the
    // non-existent pkg/pkg/wtroot.test.ts ⇒ the verifier can't run ⇒ conservative
    // discard. (Either the missing file or, were it found, the absent root marker
    // would fail it — both trace to the wrong cwd.) Proves testCwd flips admission.
    await writeConfig(s.repo, ConfigSchema.parse({ testCmd: "bun run pkg/wtroot.test.ts", subdir: "pkg" }));
    const run2 = await runGate({ repoRoot: s.repo, json: true, force: true });
    expect(JSON.parse(run2.stdout).admitted).toBe(0);
  });

  test("(j) under --json, stdout is exactly one JSON object (logs go to stderr)", async () => {
    const s = await scaffold();
    await writeConfigDefault(s.repo);
    await writeTask(s.repo, makeTask("sound", s.base, "bun run verifyA.ts"));
    await writeTruth(s.repo, "sound", { fixDiff: s.fixGood, verifierDiff: s.verifierA });

    const run = await runGate({ repoRoot: s.repo, json: true, force: false });
    expect(() => JSON.parse(run.stdout)).not.toThrow();
    expect(run.stdout.trimEnd().includes("\n")).toBe(false); // single line, one object
    // The per-task progress log is on stderr, never polluting the JSON stdout.
    expect(run.stderr).toContain("ADMITTED");
  });
});
