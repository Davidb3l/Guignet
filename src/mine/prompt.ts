/**
 * Prompt reconstruction (ARCHITECTURE.md §5, the leak firewall).
 *
 * The agent's task statement is rebuilt from the human-written record — commit
 * subject/body (and, when available, issue/PR text) — NEVER from diff content.
 * This is the one place the spec says paranoia is the design: a prompt that
 * echoes the fix diff turns the benchmark into a copying exercise.
 *
 * The firewall is structural, not a convention. `PromptContext` is the ONLY
 * input to reconstruction, and it has no field that can carry a diff. An LLM
 * cleaner (optional, later) would receive a `PromptContext` and nothing else,
 * so it cannot see the fix even if wired up. The harness works with zero LLM
 * configured — `reconstructPrompt` below is deterministic and provider-free
 * (degraded prompts, still-sound tasks, per §1).
 */
import type { CommitMeta } from "../core/index.ts";

/**
 * Everything reconstruction is allowed to see. Deliberately has NO `diff`,
 * `fix`, `patch`, or `verifier` field — the type IS the firewall. Do not add
 * one; the whole benchmark's validity rests on it.
 */
export interface PromptContext {
  subject: string;
  body: string;
  /** Issue references pulled from the message (e.g. "#142") — context, not code. */
  issueRefs: string[];
}

/** Trailer lines that are process noise, not task description — stripped from the body. */
const TRAILER = /^(co-authored-by|signed-off-by|co-committed-by|reviewed-by|acked-by|tested-by|reported-by|suggested-by|git-svn-id|change-id|pr-link|refs?):/i;

/** Pull `#\d+` issue references out of the message. */
function issueRefs(text: string): string[] {
  const refs = new Set<string>();
  for (const m of text.matchAll(/#(\d+)\b/g)) refs.add(`#${m[1]}`);
  return [...refs];
}

/** Build the (firewalled) context from a commit — the only reconstruction input. */
export function buildPromptContext(commit: CommitMeta): PromptContext {
  const body = commit.body
    .split("\n")
    .filter((line) => !TRAILER.test(line.trim()))
    .join("\n")
    .trim();
  return {
    subject: commit.subject.trim(),
    body,
    issueRefs: issueRefs(`${commit.subject}\n${commit.body}`),
  };
}

/**
 * Reconstruct the agent-facing task statement, deterministically (zero-LLM).
 * A future LLM cleaner would take a `PromptContext` and rewrite it into a
 * cleaner brief — but never sees anything this doesn't already hold.
 */
export function reconstructPrompt(ctx: PromptContext): string {
  const parts = [ctx.subject];
  if (ctx.body) parts.push("", ctx.body);
  return parts.join("\n").trim();
}
