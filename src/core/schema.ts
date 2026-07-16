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

/** The discovery heuristics that can surface a candidate (ARCHITECTURE.md §5). */
export const DiscoveredBySchema = z.enum([
  "test-source-delta",
  "conventional",
  "loose-prefix",
  "issue-linked",
]);
export type DiscoveredBy = z.infer<typeof DiscoveredBySchema>;

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
  /**
   * WHERE setup + verifier (and the agent) execute, relative to the worktree
   * (ARCHITECTURE.md §3). Independent of `subdir`, which only scopes MINING.
   * - "subdir" (default): run with `subdir` as cwd — right for a self-contained
   *   package whose test runner works from its own directory.
   * - "repo": run at the worktree ROOT even though mining stays scoped to
   *   `subdir`. This is the shape a WORKSPACE test runner needs — vitest
   *   `projects`, pnpm/nx/turbo workspaces — where a scoped run must execute at
   *   the workspace root or the runner can't resolve its project graph (a run
   *   from inside the package fails with "no projects/tests found"). When "repo",
   *   mined verifier paths stay repo-root-relative instead of being stripped to
   *   `subdir`.
   * Has no effect without `subdir` (repo root is already the cwd). Changing it
   * (or `subdir`) on an already-mined repo needs `guignet mine --force` — the
   * verifier path shape is baked into each task at mine time.
   */
  testCwd: z.enum(["subdir", "repo"]).default("subdir"),
  /** Per-attempt default budgets (a run config may tighten these). */
  budgets: z
    .object({
      maxTokens: z.number().int().positive().optional(),
      maxSeconds: z.number().int().positive().optional(),
      maxDollars: z.number().positive().optional(),
    })
    .optional(),
  /**
   * Host citizenship (core/host.ts): Guignet is a background workload and must
   * never take the machine away from its user — the v0 dogfoods froze a 16 GB
   * laptop before these existed.
   * - `priority`: scheduling priority for EVERY spawned subprocess (agents,
   *   installs, verifiers). "low" (default) = macOS `taskpolicy -c utility` /
   *   `nice -n 10` elsewhere — the user's foreground always wins under
   *   contention, near-zero cost on an idle machine. "normal" opts out.
   * - `maxLoadPerCore`: the run pool admits an ADDITIONAL concurrent attempt
   *   only while load1 ≤ maxLoadPerCore × cores (progress guarantee: the
   *   first unit always runs, so a busy host degrades to sequential, never
   *   stalls). Default 1.5.
   */
  host: z
    .object({
      priority: z.enum(["low", "normal"]).default("low"),
      maxLoadPerCore: z.number().positive().default(1.5),
    })
    .default({}),
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
  /**
   * The target repo's public/private history — decides how the cutoff split is
   * FRAMED (§7). For a public/mixed repo, pre-cutoff tasks carry real
   * memorization-contamination risk (post-cutoff is the clean number). For a
   * private repo the model never saw the code, so the same split instead
   * measures knowledge freshness (post-cutoff may be HARDER — the model lacks
   * ecosystem changes after its cutoff), not contamination. Default "unknown"
   * presents the split neutrally rather than overclaiming either way.
   */
  repoVisibility: z.enum(["public", "private", "mixed", "unknown"]).default("unknown"),
  /** Validity-gate replay count `k` (§ gate). Default 2. */
  gateReplays: z.number().int().positive().default(2),
  /** Per-verifier-run wall-clock cap (ms). A run exceeding it is treated as an
   * unsound task, not a slow one, so this sits well above an honest suite.
   * Default 600_000 (10 min). */
  verifierTimeoutMs: z.number().int().positive().default(600_000),
  /** Discovery tuning for `mine` (§5). Sensible defaults live in the code. */
  discovery: z
    .object({
      /** How many first-parent commits to walk (newest-first). Default 1000. */
      limit: z.number().int().positive().optional(),
      /**
       * A JS-regex source (no slashes) for the loose "scope: summary" prefix
       * heuristic, e.g. matching `GL: …` / `security: …`. Anchored at the start
       * of the subject. When omitted, a built-in default is used.
       */
      loosePrefix: z.string().optional(),
    })
    .optional(),
});
export type Config = z.infer<typeof ConfigSchema>;
export type RepoVisibility = Config["repoVisibility"];

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
  discoveredBy: z.array(DiscoveredBySchema),
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

/**
 * One discovered commit and what became of it: an entry in the candidate log
 * (`.guignet/candidates.json`). Records EVERY commit discovery considered — the
 * ones reconstructed into tasks and the ones discarded, with the reason. This
 * is the mining-quality debug surface (ARCHITECTURE.md §5). Note it carries no
 * diff content — it lives outside the firewall.
 */
export const CandidateSchema = z.object({
  sha: z.string(),
  subject: z.string(),
  date: z.string(),
  discoveredBy: z.array(DiscoveredBySchema),
  outcome: z.enum(["reconstructed", "discarded"]),
  /** The task id when reconstructed; null when discarded. */
  taskId: z.string().nullable(),
  /** Why it was discarded (empty when reconstructed) — mining-quality signal. */
  discardReason: z.string().nullable(),
});
export type Candidate = z.infer<typeof CandidateSchema>;

/** The candidate log: `.guignet/candidates.json`, written by `mine`. */
export const CandidateLogSchema = z.object({
  minedAt: z.string(),
  candidates: z.array(CandidateSchema),
});
export type CandidateLog = z.infer<typeof CandidateLogSchema>;

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

/** The harness driving an attempt (ARCHITECTURE.md §6). v0 ships exactly two. */
export const AdapterNameSchema = z.enum(["claude-code", "generic-cli"]);
export type AdapterName = z.infer<typeof AdapterNameSchema>;

/** A run's configuration: `.guignet/runs/<runId>/config.json` (§ run). */
export const RunConfigSchema = z.object({
  runId: z.string(),
  adapter: AdapterNameSchema,
  /** Model id — adapter-specific (claude-code passes it to `--model`). Optional
   * so an adapter can use its own default. */
  model: z.string().optional(),
  /** Attempts per task per config. Default 3; n=1 is watermarked "anecdote, not
   * measurement" in the report (statistical honesty is a wedge — §9). */
  nAttempts: z.number().int().positive().default(3),
  budgets: ConfigSchema.shape.budgets,
  /** Bounded worktree-pool concurrency. Default min(4, cores/2) resolved in run. */
  maxConcurrency: z.number().int().positive().optional(),
  /** generic-cli only: the command template. `{prompt}` and `{worktree}` are
   * substituted before it runs (the escape hatch that makes Guignet
   * harness-neutral, §6). Required when adapter is "generic-cli". */
  genericCli: z.object({ cmd: z.string().min(1) }).optional(),
});
export type RunConfig = z.infer<typeof RunConfigSchema>;

/** Token accounting for one attempt, parsed from the harness's own transcript
 * (never self-reported, §5). Cache tokens are split out — they're a large,
 * cheaper slice of real cost that the report needs to show honestly. */
export const TokenUsageSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative().default(0),
  cacheCreation: z.number().int().nonnegative().default(0),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

/** Per-attempt result: `.guignet/runs/<runId>/attempts/<taskId>/<n>/attempt.json`. */
export const AttemptSchema = z.object({
  taskId: z.string(),
  attempt: z.number().int().positive(),
  wallclockMs: z.number().nonnegative(),
  /** Null when the adapter has no parseable transcript (e.g. generic-cli). */
  tokens: TokenUsageSchema.nullable(),
  dollars: z.number().nonnegative().nullable(),
  exit: z.enum(["completed", "budget-exhausted", "crashed"]),
});
export type Attempt = z.infer<typeof AttemptSchema>;

/** Which side of a model's training cutoff a task's date falls on (§7). The
 * post-cutoff subset is the clean, headline number; "unknown" means the model
 * isn't in the cutoff registry, so no split can be drawn. */
export const CutoffEraSchema = z.enum(["pre", "post", "unknown"]);
export type CutoffEra = z.infer<typeof CutoffEraSchema>;

/** The scored verdict: `.../verdict.json` (§ score). */
export const VerdictSchema = z.object({
  taskId: z.string(),
  attempt: z.number().int().positive(),
  /** The held-out verifier's binary pass/fail — the primary, judge-free verdict. */
  passed: z.boolean(),
  /** Solution diff size vs ground truth (bloat ratio); null if not computed. */
  bloatRatio: z.number().nonnegative().nullable(),
  /** Token-level Jaccard similarity of solution vs ground-truth fix, 0..1 (§7). */
  similarity: z.number().min(0).max(1).nullable(),
  /** Regurgitation flag: high similarity to ground truth on a PRE-cutoff task (§7). */
  regurgitationFlag: z.boolean(),
  /** Which side of the run model's training cutoff this task's date falls on. */
  cutoffEra: CutoffEraSchema,
  /**
   * True when the solution ALSO edited held-out verifier/test paths and those
   * edits were set aside before judging (score/verdict.ts — the verifier is
   * authoritative over its own paths; the agent is judged on its source fix
   * only). Transparency, not a penalty: pass/fail above already reflects the
   * source-only projection. Defaulted so verdicts written before this field
   * existed still parse.
   */
  testEditsFiltered: z.boolean().default(false),
});
export type Verdict = z.infer<typeof VerdictSchema>;
