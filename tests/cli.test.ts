import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const BIN = fileURLToPath(new URL("../src/bin/guignet.ts", import.meta.url));

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "guignet-cli-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

interface Cli {
  code: number | null;
  stdout: string;
  stderr: string;
}
async function guignet(args: string[], cwd: string): Promise<Cli> {
  const proc = Bun.spawn(["bun", "run", BIN, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

describe("guignet CLI", () => {
  test("no subcommand → exit 2, stdout empty (usage to stderr)", async () => {
    const r = await guignet([], await tmp());
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Usage:");
  });

  test("unknown command → exit 2", async () => {
    const r = await guignet(["frobnicate"], await tmp());
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown command");
  });

  test("--help → exit 0, help on stdout", async () => {
    const r = await guignet(["--help"], await tmp());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("guignet");
  });

  test("doctor --json → exit 0 and exactly one JSON object on stdout", async () => {
    const repo = await tmp();
    const r = await guignet(["doctor", "--json"], repo);
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.stdout); // throws if not exactly one JSON value
    expect(obj.tool).toBe("guignet");
    expect(r.stdout.trimEnd().includes("\n")).toBe(false); // single line
  });

  test("doctor --json stays parseable even with a malformed config (present-unhealthy)", async () => {
    const repo = await tmp();
    await mkdir(join(repo, ".guignet"), { recursive: true });
    await writeFile(join(repo, ".guignet", "config.json"), "{ broken", "utf-8");
    const r = await guignet(["doctor", "--json"], repo);
    expect(r.code).toBe(0); // §3.1: present-but-unhealthy, not absent
    const obj = JSON.parse(r.stdout);
    expect(obj.ok).toBe(false);
  });

  test("still-unimplemented stages (score/report) → exit 1 with a clear message", async () => {
    const repo = await tmp();
    for (const cmd of ["score", "report"]) {
      const r = await guignet([cmd], repo);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("not implemented");
    }
  });

  test("mine/gate on a repo with no config fail cleanly (exit 1), not with a stub message", async () => {
    const repo = await tmp();
    for (const cmd of ["mine", "gate"]) {
      const r = await guignet([cmd], repo);
      expect(r.code).toBe(1);
      expect(r.stderr.toLowerCase()).toContain("config");
      expect(r.stderr).not.toContain("not implemented");
    }
  });

  test("run with no --config is a usage error (exit 2)", async () => {
    const repo = await tmp();
    const r = await guignet(["run"], repo);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--config");
  });
});
