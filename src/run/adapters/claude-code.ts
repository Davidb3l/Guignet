/**
 * The `claude-code` adapter (ARCHITECTURE.md §6) — drive Claude Code headlessly
 * inside a worktree and read its OWN result JSON for cost.
 *
 * Invocation (verified against claude 2.1.198):
 *   claude -p "<prompt>" --output-format json --dangerously-skip-permissions [--model <m>]
 * run with cwd = worktreePath. `-p` is headless; `--output-format json` prints
 * exactly one JSON result object to stdout at the end; skip-permissions is
 * REQUIRED so the agent edits files without an interactive prompt. The agent
 * mutates the worktree directly — we never parse a diff; the RUNNER captures the
 * worktree diff and measures wall-clock (§6 split). Our job is to run claude and
 * record its transcript (stdout → result.json, stderr → stderr.log).
 *
 * Cost comes from parsing that result.json, never from a free-text agent claim
 * (§5 "never trust self-reporting"). The parser is defensive: a killed run can
 * leave result.json missing or half-written, and that must degrade to null/zero
 * rather than throw.
 */
import { join } from "node:path";

import { spawnToFile, type TokenUsage } from "../../core/index.ts";
import type { Adapter, AttemptCost, AttemptExit, AttemptInput } from "./types.ts";

/** Wall-clock ceiling when the caller sets no `budget.maxSeconds`. An agent run
 * with no bound would hang the whole suite, so we still cap it generously. */
const DEFAULT_TIMEOUT_MS = 900_000;

const RESULT_FILE = "result.json";
const STDERR_FILE = "stderr.log";

/** stdout result schema we depend on (a superset is fine — extra keys ignored). */
interface ClaudeResult {
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/** Build the argv. `--model` is appended only when a model id was supplied. */
export function buildArgv(input: AttemptInput): string[] {
  const argv = [
    "claude",
    "-p",
    input.prompt,
    "--output-format",
    "json",
    "--dangerously-skip-permissions",
  ];
  if (input.model) argv.push("--model", input.model);
  return argv;
}

/** Coerce an unknown to a finite non-negative int, else 0 — the result JSON may
 * be partial or type-wrong if claude was killed mid-write. */
function intOrZero(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0;
}

/** Read + parse `<transcriptDir>/result.json`, or null if absent/unparseable. */
async function readResult(transcriptDir: string): Promise<ClaudeResult | null> {
  try {
    const text = await Bun.file(join(transcriptDir, RESULT_FILE)).text();
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? (parsed as ClaudeResult) : null;
  } catch {
    // Missing file (ENOENT) or malformed/truncated JSON — both mean "no cost".
    return null;
  }
}

/**
 * Map claude's result JSON to `AttemptCost`. `input` is NON-cache input only
 * (usage.input_tokens); cache reads/creations are split out (they're a large,
 * cheaper slice §5). `dollars` is total_cost_usd, or null when the field is
 * absent. Any missing numeric field defaults to 0. Returns null only when there
 * is no readable result at all.
 */
export async function parseCost(transcriptDir: string): Promise<AttemptCost | null> {
  const result = await readResult(transcriptDir);
  if (!result) return null;

  const usage = result.usage ?? {};
  const tokens: TokenUsage = {
    input: intOrZero(usage.input_tokens),
    output: intOrZero(usage.output_tokens),
    cacheRead: intOrZero(usage.cache_read_input_tokens),
    cacheCreation: intOrZero(usage.cache_creation_input_tokens),
  };
  const dollars =
    typeof result.total_cost_usd === "number" && Number.isFinite(result.total_cost_usd)
      ? result.total_cost_usd
      : null;

  return { tokens, dollars };
}

/**
 * Run claude in the worktree, streaming its transcript to files, and classify
 * the outcome. Never throws — an adapter failure is an attempt OUTCOME, not a
 * runner crash (§6):
 *   - timedOut          → "budget-exhausted" (wall-clock budget hit)
 *   - non-zero exit, OR result.json missing/unparseable, OR is_error===true
 *                       → "crashed"
 *   - otherwise         → "completed"
 */
export async function attempt(input: AttemptInput): Promise<{ exit: AttemptExit }> {
  const timeoutMs =
    input.budget.maxSeconds !== undefined ? input.budget.maxSeconds * 1000 : DEFAULT_TIMEOUT_MS;

  const { code, timedOut } = await spawnToFile(buildArgv(input), {
    cwd: input.worktreePath,
    stdoutPath: join(input.transcriptDir, RESULT_FILE),
    stderrPath: join(input.transcriptDir, STDERR_FILE),
    timeoutMs,
  });

  if (timedOut) return { exit: "budget-exhausted" };
  if (code !== 0) return { exit: "crashed" };

  // Exit 0, but trust the harness's own record over the exit code: a missing or
  // is_error result means the session did not end cleanly.
  const result = await readResult(input.transcriptDir);
  if (!result || result.is_error === true) return { exit: "crashed" };

  return { exit: "completed" };
}

/**
 * Is claude on PATH? Probe with `claude --version` (offline, free) and check for
 * a clean exit. Output is discarded to a throwaway file. Never throws.
 */
export async function detect(): Promise<boolean> {
  const { tmpdir } = await import("node:os");
  const { rm } = await import("node:fs/promises");
  const base = join(tmpdir(), `guignet-claude-detect-${process.pid}-${Date.now()}`);
  const outPath = `${base}.out`;
  const errPath = `${base}.err`;
  const { code } = await spawnToFile(["claude", "--version"], {
    cwd: tmpdir(),
    stdoutPath: outPath,
    stderrPath: errPath,
    timeoutMs: 10_000,
  });
  await rm(outPath, { force: true });
  await rm(errPath, { force: true });
  return code === 0;
}

export const claudeCodeAdapter: Adapter = {
  name: "claude-code",
  detect,
  attempt,
  parseCost,
};
