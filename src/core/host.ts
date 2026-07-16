/**
 * Host citizenship — Guignet must never take the machine away from its user.
 *
 * A benchmark run is a BACKGROUND workload: nothing about it is
 * latency-sensitive, and the human running it (often on their only machine —
 * a laptop or a Mac mini) keeps working while it grinds. The v0 dogfoods
 * proved what happens without this module: 4 concurrent agents × their
 * subprocess trees × concurrent installs × a test runner spawning its own
 * per-core worker pool froze a 16 GB MacBook Air outright. Two mechanisms fix
 * that, both here:
 *
 * 1. PRIORITY (buildPriorityArgv): every subprocess Guignet spawns — agents,
 *    installs, verifiers — runs at reduced scheduling priority by default
 *    (macOS `taskpolicy -c utility`, which also demotes I/O; `nice -n 10`
 *    elsewhere). Under contention the user's foreground wins and Guignet
 *    yields; on an idle machine wall-clock cost is ~zero. Both wrappers
 *    exec() the target in place (same pid), so proc.ts's tree-kill semantics
 *    are unchanged. Opt out per-repo with `host.priority: "normal"`.
 *
 * 2. ADMISSION (waitForHeadroom): the run pool checks the 1-minute load
 *    average before starting each ADDITIONAL concurrent unit and waits while
 *    the host is saturated — with a hard progress guarantee: when nothing
 *    else is RUNNING, admit unconditionally, so a loaded machine degrades
 *    to sequential progress instead of stalling forever (runs are resumable;
 *    a stall behind some wedged third-party process would be its own outage).
 *    The count deliberately excludes units parked in admission — counting
 *    them deadlocks the pool once every puller parks (see run/pool.ts).
 *
 * Load average is the whole signal on purpose: it is portable, cheap, and
 * captures CPU pressure from OTHER processes too (the freeze had Docker
 * burning 5 cores before Guignet added a single process). Memory pressure is
 * deliberately not probed in v0 — `os.freemem()` is misleading on macOS
 * (purgeable/inactive pages read as "used") and a wrong number is worse than
 * none. The priority clamp is the memory story's mitigation for now: a
 * swapping foreground app still schedules ahead of us.
 */
import { availableParallelism, loadavg, platform } from "node:os";

/** What the admission/priority decisions read from the machine. Injectable so
 * tests can simulate any host without loading a real one. */
export interface HostProbe {
  /** 1-minute load average. */
  load1(): number;
  /** Schedulable cores. */
  cores(): number;
  platform(): NodeJS.Platform;
  /** Is `taskpolicy` on PATH? (macOS QoS clamp; absent on other platforms.) */
  hasTaskpolicy(): boolean;
}

/** The real machine. `hasTaskpolicy` is memoized — PATH doesn't change mid-run. */
let taskpolicyMemo: boolean | null = null;
export const realHost: HostProbe = {
  load1: () => loadavg()[0] ?? 0,
  cores: () => Math.max(1, availableParallelism()),
  platform: () => platform(),
  hasTaskpolicy: () => (taskpolicyMemo ??= Bun.which("taskpolicy") !== null),
};

export type SpawnPriority = "low" | "normal";

/**
 * Wrap an argv so the process runs at background-appropriate priority.
 * macOS: `taskpolicy -c utility` (clamps CPU QoS AND I/O tier — the demotion
 * that actually keeps a Mac responsive). Other POSIX: `nice -n 10`. Unknown
 * platforms (or "normal"): unchanged. Both wrappers exec() the target in
 * place, so the child pid the caller sees/kills is the target itself.
 */
export function buildPriorityArgv(
  argv: string[],
  priority: SpawnPriority,
  probe: HostProbe = realHost,
): string[] {
  if (priority === "normal") return argv;
  if (probe.platform() === "darwin" && probe.hasTaskpolicy()) {
    return ["taskpolicy", "-c", "utility", ...argv];
  }
  if (probe.platform() === "linux" || probe.platform() === "darwin") {
    return ["nice", "-n", "10", ...argv];
  }
  return argv;
}

export interface HeadroomOptions {
  /** Admit while load1 <= maxLoadPerCore × cores. Default 1.5 — mild
   * oversubscription is normal on macOS; sustained 1.5×cores is real
   * saturation. */
  maxLoadPerCore: number;
  /** Units currently RUNNING work (not parked in admission — counting parked
   * units here deadlocks the caller's pool; see run/pool.ts). 0 admits
   * unconditionally: the progress guarantee. */
  active: () => number;
  probe?: HostProbe;
  /** Poll interval while waiting. Default 1s — cheap (one loadavg read), and
   * it bounds how long a parked unit lags behind a peer finishing. */
  sleepMs?: number;
  /** Called on the first wait and roughly once a minute after, for stderr. */
  onWait?: (msg: string) => void;
}

/**
 * Resolve when there is headroom for one MORE concurrent unit. Never blocks
 * when nothing is running (see module header): a saturated host degrades the
 * pool to sequential, it never deadlocks it.
 */
export async function waitForHeadroom(opts: HeadroomOptions): Promise<void> {
  const probe = opts.probe ?? realHost;
  const sleepMs = opts.sleepMs ?? 1_000;
  const threshold = opts.maxLoadPerCore * probe.cores();
  let sinceLogMs = Infinity; // fire the first message immediately
  while (opts.active() > 0 && probe.load1() > threshold) {
    if (opts.onWait && sinceLogMs >= 60_000) {
      sinceLogMs = 0;
      opts.onWait(
        `host is busy (load ${probe.load1().toFixed(1)} > ${threshold.toFixed(1)} on ${probe.cores()} cores) — holding extra concurrency while ${opts.active()} unit(s) run`,
      );
    }
    await new Promise((r) => setTimeout(r, sleepMs));
    sinceLogMs += sleepMs;
  }
}

/**
 * The default pool width, load-aware: min(4, floor(cores/2)) as before, MINUS
 * the cores other processes are already using (floor(load1/2) — halved so a
 * transient spike doesn't zero the pool), floored at 1. A machine already
 * half-busy gets a smaller pool from the start instead of discovering
 * saturation mid-run.
 */
export function defaultConcurrency(probe: HostProbe = realHost): number {
  const idleDefault = Math.min(4, Math.floor(probe.cores() / 2));
  const busyCores = Math.floor(probe.load1() / 2);
  return Math.max(1, idleDefault - busyCores);
}
