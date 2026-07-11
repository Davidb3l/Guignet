import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readTruth, writeTruth } from "../src/core/truth.ts";

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "guignet-truth-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe("truth store (behind the firewall)", () => {
  test("write then read round-trips both diffs", async () => {
    const repo = await tmp();
    await writeTruth(repo, "task123", {
      fixDiff: "--- a/x\n+++ b/x\n@@ fix @@\n",
      verifierDiff: "--- a/x.test\n+++ b/x.test\n@@ test @@\n",
    });
    const back = await readTruth(repo, "task123");
    expect(back.fixDiff).toContain("fix");
    expect(back.verifierDiff).toContain("test");
  });

  test("truth is stored under the task's truth/ dir", async () => {
    const repo = await tmp();
    await writeTruth(repo, "abc", { fixDiff: "F", verifierDiff: "V" });
    const fix = await Bun.file(join(repo, ".guignet", "tasks", "abc", "truth", "fix.diff")).text();
    expect(fix).toBe("F");
  });
});
