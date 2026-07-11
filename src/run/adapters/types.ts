/**
 * The adapter contract (ARCHITECTURE.md §6). An adapter knows how to drive ONE
 * agent harness headlessly inside a worktree and how to read that harness's own
 * transcript for cost. v0 ships exactly two: `claude-code` and `generic-cli`.
 *
 * Split of responsibility with the runner (run/index.ts):
 *   - The adapter runs the agent in `worktreePath`, writing its raw session
 *     record into `transcriptDir`, and reports only an exit status.
 *   - The RUNNER computes the solution diff uniformly (`captureWorktreeDiff`)
 *     and measures wall-clock — it never trusts the adapter for those.
 *   - `parseCost` reads the transcript the adapter wrote and returns token/$
 *     cost. Parsing the harness's OWN transcript (not a free-text agent claim)
 *     is the "never trust self-reporting" rule (§5, §9 wedge). An adapter with
 *     no parseable transcript (generic-cli) returns null.
 */
import type { TokenUsage } from "../../core/index.ts";

export type AttemptExit = "completed" | "budget-exhausted" | "crashed";

export interface AttemptInput {
  /** The task statement (already reconstructed + firewalled by mine). */
  prompt: string;
  /** Disposable worktree checked out at the task's base commit. */
  worktreePath: string;
  /** Pre-created dir where the adapter must write its raw session record. */
  transcriptDir: string;
  /** Model id — adapter-specific meaning (claude-code → `--model`). */
  model?: string;
  /** Per-attempt budget. `maxSeconds` is the wall-clock kill; the rest are
   * adapter-dependent (recorded even when not hard-enforceable). */
  budget: { maxTokens?: number; maxSeconds?: number; maxDollars?: number };
}

export interface AttemptCost {
  tokens: TokenUsage;
  dollars: number | null;
}

export interface Adapter {
  readonly name: string;
  /** Is this harness available on this machine? (`guignet doctor`/run preflight.) */
  detect(): Promise<boolean>;
  /** Run the agent in the worktree, writing its session record to transcriptDir. */
  attempt(input: AttemptInput): Promise<{ exit: AttemptExit }>;
  /** Parse the written transcript for token/$ cost, or null if unparseable. */
  parseCost(transcriptDir: string): Promise<AttemptCost | null>;
}
