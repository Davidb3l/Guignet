/**
 * Bounded-concurrency map (ARCHITECTURE.md §5: worktree pool, default
 * min(4, cores/2) — agent runs are heavy). Runs `worker` over `items` with at
 * most `limit` in flight at once, preserving result order. A worker that throws
 * rejects the whole run — callers should make `worker` catch its own errors and
 * return an outcome, so one bad attempt never aborts the batch.
 *
 * `admit` (optional) is the host-citizenship seam (core/host.ts): awaited
 * before each unit's work starts, with a LIVE count of the units actually
 * RUNNING work. The run wires it to waitForHeadroom, which holds additional
 * units while the machine is saturated but always admits when nothing is
 * running — a busy host degrades the pool to sequential progress; it never
 * freezes the machine (the v0 dogfood froze a 16 GB laptop) and never stalls
 * the run.
 *
 * Two admission properties are load-bearing, both review-caught and pinned by
 * the saturated-host regression test:
 * - The count covers RUNNING units only. If parked units counted (an earlier
 *   draft), a saturated host parked every puller with each seeing the others
 *   as "in flight" — the count could never fall to zero again: a permanent
 *   stall with work remaining.
 * - Admissions are SERIALIZED (one unit inside the gate at a time, and the
 *   running count is incremented before the gate is released). Without this,
 *   all pullers pass their admission check in the same synchronous tick —
 *   each seeing running=0 before any increments — and a saturated host gets
 *   a full-width thundering herd at startup instead of one runner. The
 *   serialization cannot deadlock: the gate holder either admits (and
 *   releases) or is parked in waitForHeadroom, whose running==0 check is
 *   guaranteed to eventually pass precisely because parked units don't count.
 */
import { defaultConcurrency as loadAwareConcurrency } from "../core/index.ts";

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  admit?: (running: () => number) => Promise<void>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let running = 0;
  let gate: Promise<void> = Promise.resolve();
  const width = Math.max(1, Math.min(limit, items.length));

  async function pull(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      if (admit) {
        const prev = gate;
        let release!: () => void;
        gate = new Promise<void>((r) => (release = r));
        await prev;
        try {
          await admit(() => running);
          running++; // inside the gate: the next admission sees this unit
        } finally {
          release();
        }
      } else {
        running++;
      }
      try {
        results[i] = await worker(items[i]!, i);
      } finally {
        running--;
      }
    }
  }

  await Promise.all(Array.from({ length: width }, () => pull()));
  return results;
}

/** The default pool width — load-aware (core/host.ts): min(4, floor(cores/2)),
 * reduced when other processes are already burning cores, at least 1. */
export function defaultConcurrency(): number {
  return loadAwareConcurrency();
}
