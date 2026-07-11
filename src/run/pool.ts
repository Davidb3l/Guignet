/**
 * Bounded-concurrency map (ARCHITECTURE.md §5: worktree pool, default
 * min(4, cores/2) — agent runs are heavy). Runs `worker` over `items` with at
 * most `limit` in flight at once, preserving result order. A worker that throws
 * rejects the whole run — callers should make `worker` catch its own errors and
 * return an outcome, so one bad attempt never aborts the batch.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));

  async function pull(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  }

  await Promise.all(Array.from({ length: width }, () => pull()));
  return results;
}

/** The default pool width: min(4, floor(cores/2)), at least 1. Agent runs are heavy. */
export function defaultConcurrency(): number {
  const cores = navigator.hardwareConcurrency || 4;
  return Math.max(1, Math.min(4, Math.floor(cores / 2)));
}
