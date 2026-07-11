/**
 * Contamination math (ARCHITECTURE.md §7 — the credibility moat). Pure and
 * unit-tested: the regurgitation signal and the bloat ratio are computed here;
 * cutoff CLASSIFICATION lives in core/cutoffs.ts (classifyEra). A model may have
 * trained on your public history, so a solution that reproduces the held-out
 * fix nearly verbatim on a PRE-cutoff task is memory, not skill — this flags it.
 */
import type { CutoffEra } from "../core/index.ts";

/**
 * The meaningful tokens of a unified diff: lowercased alphanumeric tokens from
 * the ADDED/REMOVED content lines only. File headers (`+++`/`---`), hunk
 * headers (`@@`), and context lines are skipped, so similarity reflects the
 * actual change, not shared surrounding code or path noise.
 */
export function diffTokens(diff: string): Set<string> {
  const tokens = new Set<string>();
  for (const line of diff.split("\n")) {
    if (line[0] !== "+" && line[0] !== "-") continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    for (const t of line.slice(1).toLowerCase().match(/[a-z0-9_]+/g) ?? []) tokens.add(t);
  }
  return tokens;
}

/** Token-level Jaccard similarity of two diffs, 0..1 (§7). */
export function diffSimilarity(a: string, b: string): number {
  const A = diffTokens(a);
  const B = diffTokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Above this similarity on a pre-cutoff task, a solution is flagged as likely
 * regurgitated. Deliberately high — a false flag is worse than a missed one. */
export const DEFAULT_REGURGITATION_THRESHOLD = 0.7;

/** Regurgitation: high similarity to ground truth on a PRE-cutoff task only.
 * Post-cutoff similarity is just a correct fix (the model couldn't have seen it). */
export function isRegurgitation(
  similarity: number,
  era: CutoffEra,
  threshold: number = DEFAULT_REGURGITATION_THRESHOLD,
): boolean {
  return era === "pre" && similarity >= threshold;
}

/** Count added lines in a diff (`+` content lines, excluding the `+++` header). */
export function addedLineCount(diff: string): number {
  let n = 0;
  for (const line of diff.split("\n")) {
    if (line[0] === "+" && !line.startsWith("+++")) n++;
  }
  return n;
}

/** Bloat ratio: the agent's added-line count over the ground-truth fix's. >1
 * means a larger-than-necessary change. Null when the fix added nothing. */
export function bloatRatio(solutionDiff: string, fixDiff: string): number | null {
  const fixLines = addedLineCount(fixDiff);
  return fixLines === 0 ? null : addedLineCount(solutionDiff) / fixLines;
}
