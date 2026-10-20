/**
 * claude-code adapter tests. HERMETIC: these must NEVER invoke `claude -p` (it
 * costs money and needs auth). parseCost is exercised against FIXTURE
 * result.json files written into a tmpdir; detect() may run the real offline
 * `claude --version`, but is asserted only to return a boolean without throwing
 * so it passes whether or not claude is installed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildArgv, claudeCodeAdapter, detect, parseCost } from "../src/run/adapters/claude-code.ts";
import type { AttemptInput } from "../src/run/adapters/types.ts";

const dirs: string[] = [];
/** A fresh tmp transcriptDir; optionally seeded with a result.json body. */
async function transcriptDir(resultBody?: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "guignet-cc-"));
  dirs.push(d);
  if (resultBody !== undefined) await writeFile(join(d, "result.json"), resultBody, "utf-8");
  return d;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

/** A real-shaped success result captured from claude 2.1.198. */
const SUCCESS = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 3,
  result: "done",
  session_id: "abc",
  total_cost_usd: 0.0184,
  usage: {
    input_tokens: 10,
    cache_creation_input_tokens: 8216,
    cache_read_input_tokens: 18243,
    output_tokens: 42,
    service_tier: "standard",
  },
});

describe("parseCost", () => {
  test("maps a real-shaped success result to tokens + dollars", async () => {
    const dir = await transcriptDir(SUCCESS);
    const cost = await parseCost(dir);
    expect(cost).toEqual({
      tokens: { input: 10, output: 42, cacheRead: 18243, cacheCreation: 8216 },
      dollars: 0.0184,
    });
  });

  test("defaults missing cache fields to 0", async () => {
    const dir = await transcriptDir(
      JSON.stringify({ total_cost_usd: 0.5, usage: { input_tokens: 5, output_tokens: 7 } }),
    );
    const cost = await parseCost(dir);
    expect(cost).toEqual({
      tokens: { input: 5, output: 7, cacheRead: 0, cacheCreation: 0 },
      dollars: 0.5,
    });
  });

  test("absent usage object → all-zero tokens", async () => {
    const dir = await transcriptDir(JSON.stringify({ total_cost_usd: 0.01 }));
    const cost = await parseCost(dir);
    expect(cost).toEqual({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      dollars: 0.01,
    });
  });

  test("absent total_cost_usd → dollars null (not 0)", async () => {
    const dir = await transcriptDir(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
    const cost = await parseCost(dir);
    expect(cost?.dollars).toBeNull();
    expect(cost?.tokens).toEqual({ input: 1, output: 1, cacheRead: 0, cacheCreation: 0 });
  });

  test("missing result.json → null", async () => {
    const dir = await transcriptDir(); // no file written
    expect(await parseCost(dir)).toBeNull();
  });

  test("malformed JSON → null, no throw", async () => {
    const dir = await transcriptDir("{ this is not json ");
    expect(await parseCost(dir)).toBeNull();
  });

  test("truncated JSON (killed mid-write) → null, no throw", async () => {
    // A half-written object: valid prefix, abrupt cutoff.
    const dir = await transcriptDir('{"type":"result","usage":{"input_tokens":10,"output');
    expect(await parseCost(dir)).toBeNull();
  });

  test("non-object JSON (e.g. a bare number) → null", async () => {
    const dir = await transcriptDir("42");
    expect(await parseCost(dir)).toBeNull();
  });

  test("negative / non-finite numeric fields coerce to 0", async () => {
    const dir = await transcriptDir(
      JSON.stringify({ total_cost_usd: 0.02, usage: { input_tokens: -5, output_tokens: 3.9 } }),
    );
    const cost = await parseCost(dir);
    // -5 → 0; 3.9 truncates to 3.
    expect(cost?.tokens.input).toBe(0);
    expect(cost?.tokens.output).toBe(3);
  });

  test("adapter.parseCost delegates to the same parser", async () => {
    const dir = await transcriptDir(SUCCESS);
    expect(await claudeCodeAdapter.parseCost(dir)).toEqual(await parseCost(dir));
  });
});

describe("buildArgv", () => {
  const base: AttemptInput = {
    prompt: "fix the bug",
    worktreePath: "/tmp/wt",
    transcriptDir: "/tmp/td",
    budget: {},
  };

  test("headless invocation with skip-permissions and json output", () => {
    expect(buildArgv(base)).toEqual([
      "claude",
      "-p",
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
    ]);
  });

  test("appends --model only when a model id is set", () => {
    const argv = buildArgv({ ...base, model: "opus" });
    expect(argv.slice(-2)).toEqual(["--model", "opus"]);
    expect(buildArgv(base)).not.toContain("--model");
  });

  test("the prompt is never in argv (it is piped on stdin)", () => {
    const argv = buildArgv({ ...base, prompt: "- leading dash" });
    expect(argv.join(" ")).not.toContain("leading dash");
  });
});

describe("detect", () => {
  // Runs the REAL `claude --version` (offline, free). Guarded so it passes
  // whether or not claude is installed: only asserts a non-throwing boolean.
  test("returns a boolean and never throws", async () => {
    const result = await detect();
    expect(typeof result).toBe("boolean");
  });

  test("adapter exposes name and delegates detect", async () => {
    expect(claudeCodeAdapter.name).toBe("claude-code");
    expect(typeof (await claudeCodeAdapter.detect())).toBe("boolean");
  });
});

describe("attempt: the prompt travels on stdin, never argv", () => {
  // HERMETIC: a fake `claude` shim goes FIRST on PATH; it records argv + stdin
  // via a tiny bun script and prints a minimal success result. Real claude is
  // never invoked.
  const FAKE_TS = `
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const dir = dirname(import.meta.path);
const chunks: Uint8Array[] = [];
for await (const c of Bun.stdin.stream()) chunks.push(c);
writeFileSync(join(dir, "stdin.bin"), Buffer.concat(chunks));
writeFileSync(join(dir, "argv.json"), JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ is_error: false, total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } }));
`;

  async function withFakeClaude<T>(fn: (fakeDir: string) => Promise<T>): Promise<T> {
    const fakeDir = await mkdtemp(join(tmpdir(), "guignet-fake-claude-"));
    dirs.push(fakeDir);
    await writeFile(join(fakeDir, "fake.ts"), FAKE_TS, "utf-8");
    const bun = process.execPath;
    if (process.platform === "win32") {
      await writeFile(join(fakeDir, "claude.cmd"), `@"${bun}" "%~dp0fake.ts" %*\r\n`, "utf-8");
    } else {
      const { chmod } = await import("node:fs/promises");
      await writeFile(join(fakeDir, "claude"), `#!/bin/sh\nexec "${bun}" "$(dirname "$0")/fake.ts" "$@"\n`, "utf-8");
      await chmod(join(fakeDir, "claude"), 0o755);
    }
    const key = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    const savedPath = process.env[key];
    process.env[key] = fakeDir + (process.platform === "win32" ? ";" : ":") + (savedPath ?? "");
    try {
      return await fn(fakeDir);
    } finally {
      if (savedPath === undefined) delete process.env[key];
      else process.env[key] = savedPath;
    }
  }

  async function runAttempt(prompt: string, extra: Partial<AttemptInput> = {}) {
    return withFakeClaude(async (fakeDir) => {
      const td = await transcriptDir();
      const wt = await transcriptDir();
      const res = await claudeCodeAdapter.attempt({
        prompt,
        worktreePath: wt,
        transcriptDir: td,
        budget: { maxSeconds: 60 },
        priority: "normal",
        ...extra,
      });
      const { readFile } = await import("node:fs/promises");
      return {
        res,
        stdin: await readFile(join(fakeDir, "stdin.bin")),
        argv: JSON.parse(await readFile(join(fakeDir, "argv.json"), "utf-8")) as string[],
      };
    });
  }

  test("a leading-dash multi-line prompt arrives byte-for-byte on stdin and never in argv", async () => {
    const prompt = "- leading dash prompt\nsecond line\n--also-looks-like-a-flag \"quoted\" & $x\n";
    const { res, stdin, argv } = await runAttempt(prompt, { model: "opus" });
    expect(res.exit).toBe("completed");
    expect(Buffer.compare(stdin, Buffer.from(prompt, "utf-8"))).toBe(0);
    expect(argv.join("\n")).not.toContain("leading dash");
    expect(argv).toEqual(["-p", "--output-format", "json", "--dangerously-skip-permissions", "--model", "opus"]);
  });

  test("a 1 MB prompt is delivered whole, stdin is closed (no hang)", async () => {
    const prompt = "- " + "x".repeat(1024 * 1024) + "\n";
    const { res, stdin } = await runAttempt(prompt);
    expect(res.exit).toBe("completed");
    expect(stdin.length).toBe(Buffer.byteLength(prompt));
    expect(Buffer.compare(stdin, Buffer.from(prompt, "utf-8"))).toBe(0);
  }, 30_000);
});
