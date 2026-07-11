/**
 * Task taxonomy at mine time (ARCHITECTURE.md §5): kind, size buckets, and
 * path-derived area tags. The report breaks results down by all three — "model
 * A wins on backend bugfixes, loses on UI features" is the actionable shape.
 * All pure functions; the caller supplies the numstat.
 */
import type { NumStat, Taxonomy } from "../core/index.ts";

/** Infer kind from the subject: feat → feature, refactor/perf → refactor, else bugfix. */
export function kindOf(subject: string): Taxonomy["kind"] {
  if (/^feat(\([^)]*\))?!?:/i.test(subject) || /\bfeature\b/i.test(subject)) return "feature";
  if (/^(refactor|perf)(\([^)]*\))?!?:/i.test(subject)) return "refactor";
  return "bugfix";
}

/**
 * Area tags from the fix's source paths, relative to `subdir`. Takes the first
 * couple of directory segments (skipping ubiquitous ones like `src`) so tags
 * are coarse and comparable across tasks. Deduplicated, order-stable.
 */
export function areasOf(sourcePaths: readonly string[], subdir?: string): string[] {
  const skip = new Set(["src", "lib", "app", "packages", "."]);
  const areas: string[] = [];
  const seen = new Set<string>();
  for (const p of sourcePaths) {
    const rel = subdir && p.startsWith(subdir + "/") ? p.slice(subdir.length + 1) : p;
    const segs = rel.split("/").slice(0, -1); // drop the filename
    for (const seg of segs) {
      if (skip.has(seg.toLowerCase())) continue;
      if (!seen.has(seg)) {
        seen.add(seg);
        areas.push(seg);
      }
      break; // one tag per file — the first meaningful segment
    }
  }
  return areas;
}

/** Size buckets: total changed lines and file count across the fix's source diff. */
export function sizeOf(sourceStats: readonly NumStat[]): Taxonomy["size"] {
  let lines = 0;
  for (const s of sourceStats) lines += s.added + s.deleted;
  return { lines, files: sourceStats.length };
}

/** Assemble the full taxonomy for a reconstructed task. */
export function buildTaxonomy(
  subject: string,
  sourcePaths: readonly string[],
  sourceStats: readonly NumStat[],
  subdir?: string,
): Taxonomy {
  return { kind: kindOf(subject), size: sizeOf(sourceStats), areas: areasOf(sourcePaths, subdir) };
}
