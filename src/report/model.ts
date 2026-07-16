/**
 * The ReportModel — every number the report shows, computed once by aggregate.ts
 * and rendered by both the HTML template (§8) and the `--json` twin. This is the
 * contract between the data side and the design side: the template reads only
 * this, so the two can be built independently. Everything here is already
 * rounded/derived — the template does presentation, not arithmetic.
 */

export interface Interval {
  low: number;
  high: number;
}

/** A cutoff subset of one config's tasks (pre / post / unknown), with its own rate. */
export interface SubsetReport {
  tasksTotal: number;
  tasksSolved: number;
  /** solved/total, 0..1; null when the subset is empty. */
  solveRate: number | null;
  ci: Interval | null;
}

/** One run config = one leaderboard row. */
export interface ConfigReport {
  runId: string;
  /** Human label, e.g. "claude-opus-4-8 · claude-code". */
  label: string;
  model: string;
  adapter: string;
  nAttempts: number;
  /** n=1 ⇒ "anecdote, not measurement" watermark (§9 statistical honesty). */
  watermarked: boolean;
  /** The model's training cutoff used for the split, or null if unknown. */
  cutoffDate: string | null;

  /** THE executive number: total $ spent / tasks solved. Null if unknown/none.
   * When coverage is partial (below) this is a LOWER BOUND — some attempts had
   * no priceable transcript, so their real cost is missing from the numerator. */
  dollarsPerSolvedTask: number | null;
  /** How many attempts had a known $ figure vs the total — so the report can
   * footnote a partial-cost number rather than silently summing nulls as $0. */
  dollarsCoverage: { known: number; total: number };

  /** Overall resolve rate: a task is solved if ≥1 of its attempts passed. */
  tasksTotal: number;
  tasksSolved: number;
  solveRate: number;
  ci: Interval;

  /** Contamination split — post is the clean, headline column (§7). */
  split: { pre: SubsetReport; post: SubsetReport; unknown: SubsetReport };

  totalDollars: number | null;
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number } | null;
  /** Attempts with a known token figure vs total (partial-coverage footnote). */
  tokensCoverage: { known: number; total: number };
  medianWallclockMs: number | null;
  medianBloatRatio: number | null;

  /** Regurgitation flags among PRE-cutoff attempts (where the signal is meaningful). */
  flaggedCount: number;
  preCutoffAttempts: number;
  flagRate: number | null;

  /** Attempts whose solution ALSO edited held-out verifier/test paths — those
   * edits were set aside before judging (verifier-authoritative overlay,
   * METHODOLOGY §4). Disclosed because a judged diff that differs from
   * solution.diff on disk must never be silent. Rate is over ALL scored
   * attempts (unlike flagRate's pre-cutoff-only denominator: regurgitation is
   * only meaningful pre-cutoff, but the overlay is era-independent). */
  testEditsFilteredCount: number;
  testEditsFilteredRate: number | null;
}

/** One cell of the kind × area heatmap (for the primary config). */
export interface TaxonomyCell {
  kind: string;
  area: string;
  tasksTotal: number;
  tasksSolved: number;
  solveRate: number;
}

export interface ReportModel {
  generatedAt: string;
  repoName: string;
  /** Public/private history — frames the cutoff split (contamination vs
   * knowledge-freshness vs neutral). From config.repoVisibility. */
  repoVisibility: "public" | "private" | "mixed" | "unknown";
  suite: {
    admitted: number;
    candidates: number;
    /** admitted/candidates, 0..1 — the published soundness rate (§9). */
    soundnessRate: number;
    minedAt: string;
  };
  /** Leaderboard rows, sorted by post-cutoff solve rate (the headline) desc. */
  configs: ConfigReport[];
  /** kind × area solve-rate heatmap for the primary (top) config. */
  taxonomy: {
    forLabel: string | null;
    kinds: string[];
    areas: string[];
    cells: TaxonomyCell[];
    /** Distinct areas dropped by the readability cap (0 when all are shown). */
    areasOmitted: number;
  };
  methodology: {
    gateReplays: number;
    cutoffRegistryVersion: string;
    adapters: string[];
    totalRuns: number;
    totalAttempts: number;
  };
}
