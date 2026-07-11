/**
 * Zod schemas — the validated boundaries of every store read and write
 * (CLAUDE.md: `zod` at every store boundary, read AND write). Parsing here is
 * the single place a malformed `.guignet/` file is caught; downstream code
 * consumes the inferred types and trusts them.
 *
 * Most of these describe artifacts that later milestones produce (tasks in M1,
 * runs in M2, verdicts in M3). They are defined now — forward-looking but real
 * — so the store (core/store.ts) has typed boundaries from the first commit and
 * the mutation field (§7) never needs a schema migration.
 */
import { z } from "zod";

/** How a task is categorized at mine time (ARCHITECTURE.md §5, Guignet.md taxonomy). */
export const TaxonomySchema = z.object({
  kind: z.enum(["bugfix", "feature", "refactor"]),
  /** Line/file size buckets, derived from the fix diff. */
  size: z.object({
    lines: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
  }),
  /** Path-derived area tags, e.g. ["backend", "ledger"]. */
  areas: z.array(z.string()),
});
export type Taxonomy = z.infer<typeof TaxonomySchema>;

/**
 * Target-repo configuration: `.guignet/config.json`. Describes how to build and
 * test the repo under benchmark, plus suite/contamination knobs. This is the
 * one file a human hand-edits (everything else under `.guignet/` is
 * machine-written).
 */
export const ConfigSchema = z.object({
  /** The command that runs the repo's tests, e.g. "bun test". Required. */
  testCmd: z.string().min(1),
  /** Optional one-time environment setup, e.g. "bun install". */
  setupCmd: z.string().optional(),
  /**
   * Monorepo package root inside the target repo, e.g. "bun-backend"
   * (ARCHITECTURE.md §3). When set: history walks + diff splits are
   * path-filtered to it, and setup/test commands run with it as cwd inside the
   * worktree. Relative to the repo root; omitted means the repo root itself.
   */
  subdir: z.string().optional(),
  /** Per-attempt default budgets (a run config may tighten these). */
  budgets: z
    .object({
      maxTokens: z.number().int().positive().optional(),
      maxSeconds: z.number().int().positive().optional(),
      maxDollars: z.number().positive().optional(),
    })
    .optional(),
  /**
   * Suite event-spine emission (SUITE_CONTRACTS §2 + ARCHITECTURE.md §13).
   * "auto" (default) emits only when the target repo already has `.suite/`, so
   * Guignet never introduces that directory into a client repo. "on"/"off"
   * force it either way.
   */
  spine: z.enum(["on", "off", "auto"]).default("auto"),
  /**
   * User overrides for the model-cutoff registry (core/cutoffs.json is the
   * baseline). Model id → ISO date (YYYY-MM-DD). Used by contamination splits.
   */
  cutoffs: z.record(z.string(), z.string()).optional(),
  /** Validity-gate replay count `k` (§ gate). Default 2. */
  gateReplays: z.number().int().positive().default(2),
});
export type Config = z.infer<typeof ConfigSchema>;

/**
 * A reconstructed task: `.guignet/tasks/<taskId>/task.json`. The held-out
 * `truth/` (fix.diff, verifier.diff) lives beside it on disk but is NEVER
 * referenced from this record — the leak firewall is structural (§5): this
 * schema has no field that can carry diff content.
 */
export const TaskSchema = z.object({
  id: z.string(),
  /** The task statement shown to the agent — reconstructed from issue/PR/commit text. */
  prompt: z.string(),
  /** Parent commit the agent starts from. */
  baseSha: z.string(),
  /** The commit the task was mined from (provenance; never shown to the agent). */
  sourceSha: z.string(),
  /** Commit authorship date, ISO-8601 UTC — powers contamination cutoff splits (§7). */
  date: z.string(),
  taxonomy: TaxonomySchema,
  /** The verifier command to run (usually the repo test cmd, possibly scoped). */
  verifierCmd: z.string(),
  /** Which discovery heuristics matched (mining-quality debug surface, §5). */
  discoveredBy: z.array(z.enum(["test-source-delta", "conventional", "loose-prefix", "issue-linked"])),
  /**
   * Optional consistent rename map for mutation mode (§7, v1). Present in the
   * schema now so v1 needs no migration; unset in v0.
   */
  mutation: z
    .object({
      symbols: z.record(z.string(), z.string()),
      paths: z.record(z.string(), z.string()),
    })
    .optional(),
});
export type Task = z.infer<typeof TaskSchema>;

/** Validity-gate evidence: `.guignet/tasks/<taskId>/gate.json` (§ gate). */
export const GateSchema = z.object({
  taskId: z.string(),
  admitted: z.boolean(),
  /** k× fail-at-base, k× pass-at-fix replay outcomes. */
  replays: z.object({
    failAtBase: z.number().int().nonnegative(),
    passAtFix: z.number().int().nonnegative(),
    k: z.number().int().positive(),
  }),
  /** Why a task was discarded (empty when admitted) — the mining-quality surface. */
  discardReason: z.string().nullable(),
});
export type Gate = z.infer<typeof GateSchema>;

/** The admitted suite manifest: `.guignet/suite.json` (§ gate). */
export const SuiteSchema = z.object({
  taskIds: z.array(z.string()),
  /** admitted / candidates — published in the report, never hidden. */
  soundnessRate: z.object({
    admitted: z.number().int().nonnegative(),
    candidates: z.number().int().nonnegative(),
  }),
  minedAt: z.string(),
});
export type Suite = z.infer<typeof SuiteSchema>;

/** A run's configuration: `.guignet/runs/<runId>/config.json` (§ run). */
export const RunConfigSchema = z.object({
  runId: z.string(),
  model: z.string(),
  adapter: z.enum(["claude-code", "generic-cli"]),
  /** Attempts per task per config. Default 3; 1 is watermarked in the report. */
  nAttempts: z.number().int().positive(),
  budgets: ConfigSchema.shape.budgets,
});
export type RunConfig = z.infer<typeof RunConfigSchema>;

/** Per-attempt result: `.guignet/runs/<runId>/attempts/<taskId>/<n>/attempt.json`. */
export const AttemptSchema = z.object({
  taskId: z.string(),
  attempt: z.number().int().positive(),
  wallclockMs: z.number().nonnegative(),
  tokens: z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() }),
  dollars: z.number().nonnegative().nullable(),
  exit: z.enum(["completed", "budget-exhausted", "crashed"]),
});
export type Attempt = z.infer<typeof AttemptSchema>;

/** The scored verdict: `.../verdict.json` (§ score). */
export const VerdictSchema = z.object({
  taskId: z.string(),
  attempt: z.number().int().positive(),
  /** The held-out verifier's binary pass/fail — the primary, judge-free verdict. */
  passed: z.boolean(),
  /** Solution diff size vs ground truth (bloat ratio); null if not computed. */
  bloatRatio: z.number().nonnegative().nullable(),
  /** Regurgitation flag: high similarity to ground truth on a pre-cutoff task (§7). */
  regurgitationFlag: z.boolean(),
});
export type Verdict = z.infer<typeof VerdictSchema>;
