/**
 * The suite event spine (SUITE_CONTRACTS §2) — Guignet's producer side.
 *
 * Append-only `<repo-root>/.suite/events/<YYYY-MM-DD>.jsonl`, one envelope per
 * line, bucketed by UTC day. Guignet emits past-tense facts (`suite.mined`,
 * `task.admitted`, `run.completed`, `report.generated`) so the Suite Hub and
 * peers can observe a benchmark without any Guignet-specific knowledge.
 *
 * Producer rules honored (§2): one O_APPEND write per line; lines < 4 KiB;
 * facts emitted past-tense AFTER they are durable in `.guignet/`; only the
 * `guignet:` scheme in `source`. Emission is BEST-EFFORT — a failed append is
 * logged to stderr and swallowed, never gating the benchmark work.
 *
 * Guignet-specific gate (ARCHITECTURE.md §13): Guignet runs against CLIENT
 * repos, so it must never introduce `.suite/` into a repo that lacks it.
 * `shouldEmit` resolves the config's `spine` setting:
 *   - "auto" (default): emit only if `<repo>/.suite/` already exists.
 *   - "on":  always emit (creates `.suite/` if needed).
 *   - "off": never emit.
 * Wiring these emissions into the stages is an M4 task; the mechanism ships now.
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Spine envelope version (§2). */
export const SPINE_VERSION = 1;

/** Event types Guignet owns (§2 registry). */
export type GuignetEventType =
  | "suite.mined"
  | "task.admitted"
  | "run.completed"
  | "report.generated";

/** One line of the spine (§2 envelope). */
export interface SuiteEvent {
  v: number;
  id: string;
  ts: string; // ISO-8601 UTC
  source: "guignet";
  type: GuignetEventType;
  refs: string[];
  data: Record<string, unknown>;
}

export type SpineSetting = "on" | "off" | "auto";

/** The `guignet:` suite URIs (§1). */
export const uri = {
  task: (id: string): string => `guignet:task/${id}`,
  run: (id: string): string => `guignet:run/${id}`,
  report: (id: string): string => `guignet:report/${id}`,
};

/** The `.suite/` dir and its events subdir for a repo. */
export function suiteDir(repoRoot: string): string {
  return join(repoRoot, ".suite");
}
export function eventsDir(repoRoot: string): string {
  return join(suiteDir(repoRoot), "events");
}

/** The daily bucket filename for an ISO-8601 UTC timestamp: `YYYY-MM-DD.jsonl`. */
export function bucketFor(ts: string): string {
  return `${ts.slice(0, 10)}.jsonl`;
}

/**
 * Resolve the §13 emission gate. Pure so it is directly testable: the "auto"
 * branch is the important one — it must be false when `.suite/` is absent, so
 * an engagement against a client repo never creates that directory uninvited.
 */
export function shouldEmit(setting: SpineSetting, repoRoot: string): boolean {
  switch (setting) {
    case "off":
      return false;
    case "on":
      return true;
    case "auto":
      return existsSync(suiteDir(repoRoot));
  }
}

/** Build a spine envelope. Pure — `id`/`ts` injected so the shape is testable. */
export function buildEvent(
  type: GuignetEventType,
  refs: string[],
  data: Record<string, unknown>,
  id: string,
  ts: string,
): SuiteEvent {
  return { v: SPINE_VERSION, id, ts, source: "guignet", type, refs, data };
}

/**
 * Append one event to the spine IFF the setting permits it (§13). Best-effort:
 * any failure is logged to stderr and swallowed. Returns whether a line was
 * actually written (useful in tests; callers ignore it).
 */
export async function emitEvent(
  setting: SpineSetting,
  repoRoot: string,
  type: GuignetEventType,
  refs: string[],
  data: Record<string, unknown>,
): Promise<boolean> {
  if (!shouldEmit(setting, repoRoot)) return false;
  try {
    const id = crypto.randomUUID();
    const ts = new Date().toISOString();
    const event = buildEvent(type, refs, data, id, ts);
    const line = JSON.stringify(event) + "\n";
    // §2.1 rule 2: a conformant line is < 4096 bytes including the newline.
    // Our payloads are counts/paths, so this is a guard, not an expected path.
    if (new TextEncoder().encode(line).length >= 4096) {
      throw new Error(`event line >= 4096 bytes (type ${type}); keep bulk in the store`);
    }
    const dir = eventsDir(repoRoot);
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, bucketFor(ts)), line, "utf-8");
    return true;
  } catch (err) {
    process.stderr.write(`guignet: suite event emit failed (${type}): ${(err as Error).message}\n`);
    return false;
  }
}
