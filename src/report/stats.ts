/**
 * Small statistics for the report. Confidence intervals are always rendered
 * (§9 statistical honesty), so the interval math lives here, pure and tested.
 */
import type { Interval } from "./model.ts";

/**
 * Wilson score interval for a binomial proportion at 95% (z=1.96) — the right
 * interval for small n and rates near 0/1, where the naive normal interval
 * misbehaves (and small suites are exactly our case). Returns [low, high]
 * clamped to [0,1]. For n=0 it returns the full [0,1] (we know nothing).
 */
export function wilsonInterval(successes: number, n: number): Interval {
  if (n <= 0) return { low: 0, high: 1 };
  const z = 1.96;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

/** Median of a numeric list, or null if empty. */
export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}
