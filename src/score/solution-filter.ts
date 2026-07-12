/**
 * Source-only projection of an agent's solution diff — the heart of the
 * verifier-authoritative overlay (score/verdict.ts, METHODOLOGY.md §4).
 *
 * Agents routinely fix the source AND write their own tests — often in the very
 * files the held-out verifier patches. The verifier is authoritative over its
 * own paths: the agent is judged ONLY on its source changes, mirroring what the
 * gate validated (base + fix.diff + verifier.diff, where fix.diff is
 * source-only by construction). So before the overlay, we strip from the
 * solution every per-file block that touches (a) a path the verifier diff
 * itself touches, or (b) any test-classified path (core/classify.ts — the SAME
 * rule mine used to build the fix/verifier split). (b) ⊇ (a) for honestly-mined
 * tasks, but both are kept: (a) is derived from the actual truth artifact and
 * covers verifier files the classifier wouldn't call tests; (b) additionally
 * closes the gaming vector where an agent edits a test helper/fixture OUTSIDE
 * the verifier's paths that the verifier's tests import.
 *
 * Parsing is deliberately over-eager: a block is dropped if ANY candidate path
 * extracted from it matches. Both parsing failure modes are fail-safe — an
 * over-match can only remove agent work (never wrongly credit), and an
 * under-match leaves the collision in place, where the verifier apply then
 * fails exactly as the old strict semantic did.
 */
import { isTestFile } from "../core/index.ts";

/** One per-file block of a unified diff: its raw text + every path we could
 * attribute to it (old and new side; renames/copies contribute both). */
interface DiffBlock {
  text: string;
  paths: Set<string>;
}

/** `git diff` quotes a path (C-style, in double quotes) only when it contains
 * control/non-ASCII chars; this undoes the common escapes we could meet. */
function unquote(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  return p
    .slice(1, -1)
    .replace(/\\([\\"tnr])/g, (_, c: string) => ({ "\\": "\\", '"': '"', t: "\t", n: "\n", r: "\r" })[c] ?? c)
    .replace(/\\(\d{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
}

/** Strip a diff path prefix (`a/…` / `b/…`) and ignore the null sentinel. */
function stripSide(p: string): string | null {
  const u = unquote(p.trim());
  if (u === "/dev/null") return null;
  return u.startsWith("a/") || u.startsWith("b/") ? u.slice(2) : u;
}

/** Candidate paths from a `diff --git a/X b/Y` header line. Unquoted paths
 * containing " b/" are ambiguous, so BOTH plausible splits are returned —
 * over-matching is the safe direction here (see module header). */
function headerPaths(line: string): string[] {
  const rest = line.slice("diff --git ".length);
  // Quoted form: `diff --git "a/X" "b/Y"` (either side may be quoted).
  const quoted = rest.match(/"((?:[^"\\]|\\.)*)"/g);
  if (quoted && quoted.length > 0) {
    const out: string[] = [];
    for (const q of quoted) {
      const p = stripSide(q);
      if (p) out.push(p);
    }
    // The other side may still be unquoted — fall through to collect it too.
    const unq = rest.replace(/"((?:[^"\\]|\\.)*)"/g, "").trim();
    for (const part of unq.split(/\s+/)) {
      const p = part ? stripSide(part) : null;
      if (p) out.push(p);
    }
    return out;
  }
  // Unquoted: every ` b/` boundary is a plausible a/b split point.
  const out: string[] = [];
  for (let i = rest.indexOf(" b/"); i !== -1; i = rest.indexOf(" b/", i + 1)) {
    const a = stripSide(rest.slice(0, i));
    const b = stripSide(rest.slice(i + 1));
    if (a) out.push(a);
    if (b) out.push(b);
  }
  // No ` b/` at all (shouldn't happen for git output) — take the raw remainder.
  if (out.length === 0) {
    const p = stripSide(rest);
    if (p) out.push(p);
  }
  return out;
}

/** Split a unified diff into per-file blocks. Any preamble before the first
 * `diff --git` header is kept as a path-less block (never dropped). */
function splitBlocks(diff: string): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  let cur: DiffBlock | null = null;
  // Path sniffing must stop at the first `@@` of each block: past it, a deleted
  // content line can impersonate a `---` file header (e.g. a removed SQL
  // comment `-- tests/x` renders as `--- tests/x`).
  let inHeader = false;
  for (const line of diff.split(/(?<=\n)/)) {
    // Block headers are the only lines that can start with `diff --git` at
    // column 0 — content lines always carry a +/-/space/@@ prefix.
    if (line.startsWith("diff --git ")) {
      if (cur) blocks.push(cur);
      cur = { text: "", paths: new Set(headerPaths(line.trimEnd())) };
      inHeader = true;
    } else if (!cur) {
      cur = { text: "", paths: new Set() }; // preamble — path-less, never dropped
    }
    cur.text += line;
    if (line.startsWith("@@")) inHeader = false;
    if (!inHeader) continue;
    // Secondary path sources in the block's header section — more reliably
    // parseable than `diff --git` when names contain spaces, and they cover
    // renames/copies (whose blocks may have no ---/+++ lines at all).
    const m =
      line.match(/^(?:---|\+\+\+) (.+?)\t?\n?$/) ??
      line.match(/^(?:rename|copy) (?:from|to) (.+?)\n?$/);
    if (m?.[1]) {
      const p = stripSide(m[1]);
      if (p) cur.paths.add(p);
    }
  }
  if (cur) blocks.push(cur);
  return blocks;
}

/** Every file path a unified diff touches (old + new side, unquoted,
 * repo-root-relative). Used to extract the held-out verifier's path set. */
export function diffFilePaths(diff: string): Set<string> {
  const out = new Set<string>();
  for (const b of splitBlocks(diff)) for (const p of b.paths) out.add(p);
  return out;
}

/** The result of projecting a solution onto its judgeable (source) side. */
export interface FilteredSolution {
  /** The solution with every held-out-path block removed — what gets applied. */
  kept: string;
  /** The distinct paths whose blocks were removed (sorted, for stable notes). */
  droppedPaths: string[];
}

/**
 * Remove from `solutionDiff` every per-file block that touches a held-out path:
 * a member of `verifierPaths`, or any test-classified path. Pure text surgery —
 * per-file blocks of a unified diff are independent under `git apply`, so
 * removing whole blocks can never break the remaining ones.
 */
export function stripHeldOutPaths(solutionDiff: string, verifierPaths: ReadonlySet<string>): FilteredSolution {
  const kept: string[] = [];
  const dropped = new Set<string>();
  for (const block of splitBlocks(solutionDiff)) {
    const hit = [...block.paths].some((p) => verifierPaths.has(p) || isTestFile(p));
    if (hit) for (const p of block.paths) dropped.add(p);
    else kept.push(block.text);
  }
  return { kept: kept.join(""), droppedPaths: [...dropped].sort() };
}
