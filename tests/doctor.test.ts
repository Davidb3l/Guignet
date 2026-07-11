import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildEnvelope,
  collectReport,
  computeOk,
  envelopeForFailure,
  runDoctor,
  SCHEMA_VERSION,
  type DoctorCheck,
  type DoctorEnv,
} from "../src/cli/doctor.ts";
import { writeConfig } from "../src/core/store.ts";
import { ConfigSchema } from "../src/core/schema.ts";

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "guignet-doctor-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

const check = (name: string, ok: boolean, gating: boolean): DoctorCheck => ({ name, ok, detail: "", gating });

function baseEnv(cwd: string): DoctorEnv {
  return { cwd, version: "0.0.1", bunVersion: "1.3.13", gitAvailable: true, isGitRepo: true };
}

describe("computeOk fold", () => {
  test("a non-gating failure does NOT drag the envelope unhealthy", () => {
    expect(computeOk([check("a", true, true), check("git_repo", false, false)])).toBe(true);
  });
  test("a gating failure makes it unhealthy", () => {
    expect(computeOk([check("git_present", false, true)])).toBe(false);
  });
});

describe("collectReport", () => {
  test("uninitialized repo is healthy (nothing to benchmark here is a normal state)", async () => {
    const repo = await tmp();
    const r = await collectReport(baseEnv(repo));
    expect(r.ok).toBe(true);
    expect(r.initialized).toBe(false);
    expect(r.checks.find((c) => c.name === "config")?.ok).toBe(true);
  });

  test("missing git binary gates unhealthy", async () => {
    const repo = await tmp();
    const r = await collectReport({ ...baseEnv(repo), gitAvailable: false });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === "git_present")?.ok).toBe(false);
  });

  test("non-repo cwd is informational, not fatal", async () => {
    const repo = await tmp();
    const r = await collectReport({ ...baseEnv(repo), isGitRepo: false });
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.name === "git_repo")?.ok).toBe(false);
  });

  test("valid config with a present subdir is healthy", async () => {
    const repo = await tmp();
    await Bun.write(join(repo, "pkg", ".keep"), "");
    await writeConfig(repo, ConfigSchema.parse({ testCmd: "bun test", subdir: "pkg" }));
    const r = await collectReport(baseEnv(repo));
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.name === "subdir")?.ok).toBe(true);
  });

  test("configured-but-missing subdir gates unhealthy", async () => {
    const repo = await tmp();
    await writeConfig(repo, ConfigSchema.parse({ testCmd: "bun test", subdir: "ghost" }));
    const r = await collectReport(baseEnv(repo));
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === "subdir")?.ok).toBe(false);
  });
});

describe("envelope", () => {
  test("has the SUITE_CONTRACTS §3 shape with tool=guignet and no ui field", async () => {
    const repo = await tmp();
    const env = buildEnvelope(await collectReport(baseEnv(repo)));
    expect(env.tool).toBe("guignet");
    expect(env.schemaVersion).toBe(SCHEMA_VERSION);
    expect(env.capabilities).toEqual([]);
    expect("ui" in env).toBe(false); // §3.2: no served UI in v0
    expect(Array.isArray(env.checks)).toBe(true);
  });

  test("failure envelope is present-unhealthy, not absent", () => {
    const env = envelopeForFailure("0.0.1", new Error("boom"));
    expect(env.tool).toBe("guignet");
    expect(env.ok).toBe(false);
  });
});

describe("runDoctor", () => {
  test("--json emits exactly one JSON object and exits 0 even when unhealthy", async () => {
    const repo = await tmp();
    const run = await runDoctor({ json: true, env: { ...baseEnv(repo), gitAvailable: false } });
    expect(run.code).toBe(0); // §3.1: health is in the envelope, not the exit code
    const parsed = JSON.parse(run.stdout);
    expect(parsed.ok).toBe(false);
    expect(run.stdout.trimEnd().includes("\n")).toBe(false); // single line, one object
  });

  test("human mode exits 1 when unhealthy", async () => {
    const repo = await tmp();
    const run = await runDoctor({ json: false, env: { ...baseEnv(repo), gitAvailable: false } });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("unhealthy");
  });
});
