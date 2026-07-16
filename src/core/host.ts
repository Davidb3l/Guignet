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
 * Both pressure signals are read from the kernel's own accounting, never
 * derived: load average for CPU (portable, and it sees OTHER processes too —
 * the freeze had Docker burning 5 cores before Guignet added a single
 * process), and for memory the kernel's pressure verdict itself — macOS
 * `kern.memorystatus_vm_pressure_level` (the tri-state memorystatus uses to
 * decide jetsam), Linux PSI (`/proc/pressure/memory`, stall-time share).
 * `os.freemem()` is deliberately NOT used: on macOS it counts purgeable/
 * inactive pages as "used", and a wrong number is worse than none. A probe
 * that errors reports "normal" (fail-open): a broken probe must not stall a
 * run, and the load gate still stands on its own.
 */
import { readFileSync } from "node:fs";
import { availableParallelism, loadavg, platform } from "node:os";

/** What the admission/priority decisions read from the machine. Injectable so
 * tests can simulate any host without loading a real one. */
/** The kernel's memory-pressure verdict, coarsened to what admission needs. */
export type MemPressure = "normal" | "warn" | "critical";

export interface HostProbe {
  /** 1-minute load average. */
  load1(): number;
  /** Schedulable cores. */
  cores(): number;
  platform(): NodeJS.Platform;
  /** Is `taskpolicy` on PATH? (macOS QoS clamp; absent on other platforms.) */
  hasTaskpolicy(): boolean;
  /** The kernel's memory-pressure level; "normal" when there is no signal. */
  memPressure(): MemPressure;
}

/** macOS: the memorystatus pressure level (1 normal / 2 warn / 4 critical) —
 * the same tri-state the kernel uses to decide jetsam. ~1ms sysctl spawn. */
function darwinMemPressure(): MemPressure {
  const out = Bun.spawnSync(["sysctl", "-n", "kern.memorystatus_vm_pressure_level"]).stdout.toString();
  const level = Number.parseInt(out, 10);
  return level >= 4 ? "critical" : level >= 2 ? "warn" : "normal";
}

/** Linux: PSI — the share of the last 10s that SOME task stalled on memory.
 * A plain file read; ≥10% is real pressure, ≥50% is thrashing. */
function linuxMemPressure(): MemPressure {
  const some = readFileSync("/proc/pressure/memory", "utf-8").match(/^some avg10=([\d.]+)/);
  const pct = some ? Number.parseFloat(some[1]!) : 0;
  return pct >= 50 ? "critical" : pct >= 10 ? "warn" : "normal";
}

/** The real machine. `hasTaskpolicy` is memoized — PATH doesn't change mid-run. */
let taskpolicyMemo: boolean | null = null;
export const realHost: HostProbe = {
  load1: () => loadavg()[0] ?? 0,
  cores: () => Math.max(1, availableParallelism()),
  platform: () => platform(),
  hasTaskpolicy: () => (taskpolicyMemo ??= Bun.which("taskpolicy") !== null),
  memPressure: () => {
    try {
      if (platform() === "darwin") return darwinMemPressure();
      if (platform() === "linux") return linuxMemPressure();
    } catch {
      /* fail-open below */
    }
    return "normal"; // no signal (or a broken probe) must never stall a run
  },
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
  // CPU saturation OR CRITICAL memory pressure holds extra concurrency.
  // Deliberately not "warn": on 8–16 GB Macs warn is a chronic steady state
  // (compressed memory / lazy reclaim under ordinary multitasking), and
  // gating on it would silently serialize whole runs — even against an
  // explicit maxConcurrency. Warn instead narrows the STARTING width
  // (defaultConcurrency below); critical means reclaim is losing, which is
  // the swap-death vector an extra ~1 GB agent attempt would feed.
  const busy = (): string | null => {
    const load = probe.load1();
    if (load > threshold) return `load ${load.toFixed(1)} > ${threshold.toFixed(1)} on ${probe.cores()} cores`;
    return probe.memPressure() === "critical" ? "memory pressure critical" : null;
  };
  let reason: string | null;
  while (opts.active() > 0 && (reason = busy()) !== null) {
    if (opts.onWait && sinceLogMs >= 60_000) {
      sinceLogMs = 0;
      opts.onWait(`host is busy (${reason}) — holding extra concurrency while ${opts.active()} unit(s) run`);
    }
    await new Promise((r) => setTimeout(r, sleepMs));
    sinceLogMs += sleepMs;
  }
}

/**
 * The default pool width, host-aware: min(4, floor(cores/2)) as before, MINUS
 * the cores other processes are already using (floor(load1/2) — halved so a
 * transient spike doesn't zero the pool), then halved under memory-pressure
 * "warn" and forced to 1 under "critical" (each agent attempt costs ~1 GB+;
 * starting wide into pressure is the swap-death vector). Floored at 1. A
 * machine already strained gets a smaller pool from the start instead of
 * discovering saturation mid-run.
 */
export function defaultConcurrency(probe: HostProbe = realHost): number {
  const mem = probe.memPressure();
  if (mem === "critical") return 1;
  const idleDefault = Math.min(4, Math.floor(probe.cores() / 2));
  const busyCores = Math.floor(probe.load1() / 2);
  const width = Math.max(1, idleDefault - busyCores);
  return mem === "warn" ? Math.max(1, Math.floor(width / 2)) : width;
}
