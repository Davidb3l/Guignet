/**
 * Candidate discovery (ARCHITECTURE.md §5). Three heuristics run as PEERS and
 * their matches are unioned — the dogfood corpus showed strict conventional
 * commits are only ~10–18% of real history while ~37% of commits touch tests
 * AND source, so keying only on `fix:`/`feat:` would starve the suite.
 *
 *   1. test-source-delta — the diff modifies test files AND source files. The
 *      strongest signal, and the only one that guarantees a verifiable task.
 *   2. conventional — a strict `fix:` / `feat:` / `refactor:` … prefix.
 *   3. loose-prefix — a configurable `scope: summary` prefix (`GL:`, `security:`),
 *      OR an issue link (`#123`, `fixes #123`) → recorded as `issue-linked`.
 *
 * A commit is a CANDIDATE iff at least one heuristic matches. Which ones matched
 * is recorded on the task and in the candidate log (mining-quality surface). A
 * commit that matches a prefix heuristic but lacks the test+source split is
 * still a candidate — it's then discarded at reconstruction with a clear reason,
 * which is exactly the debug signal we want to keep.
 */
import type { DiscoveredBy } from "../core/index.ts";

/** Strict conventional-commit prefixes (the type list is intentionally broad). */
const CONVENTIONAL = /^(fix|feat|refactor|perf|bug|hotfix|fixup|chore|revert)(\([^)]*\))?!?:/i;

/** Default loose "scope: summary" prefix — a short leading token then a colon.
 * Bounded length and a leading letter avoid matching URLs (`https://`) or code. */
const DEFAULT_LOOSE = /^[A-Za-z][\w ()./-]{0,48}:\s/;

/** Issue references anywhere in the message. */
const ISSUE_REF = /(?:^|\s)#\d+\b|\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s+#\d+\b/i;

export interface DiscoveryInput {
  subject: string;
  body: string;
  hasTest: boolean;
  hasSource: boolean;
}

/** Compile the loose-prefix regex from config, falling back to the default. */
export function compileLoosePrefix(source: string | undefined): RegExp {
  if (!source) return DEFAULT_LOOSE;
  try {
    return new RegExp(source);
  } catch {
    // A bad user regex must not crash mining — degrade to the default.
    return DEFAULT_LOOSE;
  }
}

/** The heuristics that match this commit. Empty array ⇒ not a candidate. */
export function discover(input: DiscoveryInput, loosePrefix: RegExp): DiscoveredBy[] {
  const hits: DiscoveredBy[] = [];
  if (input.hasTest && input.hasSource) hits.push("test-source-delta");
  if (CONVENTIONAL.test(input.subject)) hits.push("conventional");
  if (loosePrefix.test(input.subject)) hits.push("loose-prefix");
  if (ISSUE_REF.test(input.subject) || ISSUE_REF.test(input.body)) hits.push("issue-linked");
  return hits;
}
