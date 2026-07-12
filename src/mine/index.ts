/**
 * `mine` — candidate discovery + task reconstruction (ARCHITECTURE.md §5).
 *
 * Walks the target repo's history (first-parent, optionally scoped to a
 * monorepo `subdir`), finds task-shaped commits via three peer heuristics
 * (discover.ts), and for each reconstructs a task: a prompt from the human
 * record (prompt.ts, firewalled), a taxonomy (taxonomy.ts), and the held-out
 * ground truth split into fix.diff (source) + verifier.diff (tests). Everything
 * that becomes a task is written through the store; every candidate — kept or
 * discarded, with the reason — is written to the candidate log.
 *
 * Firewall (§5): `mine` calls `writeTruth` (once per task) and NEVER reads it
 * back. The prompt cleaner sees only a `PromptContext`, which cannot carry a
 * diff. The import-boundary check enforces both.
 */
import { existsSync } from "node:fs";

import {
  EXIT,
  changedFiles,
  emitEvent,
  fileDiff,
  listCommits,
  numstat,
  readConfig,
  taskDir,
  taskId,
  writeCandidateLog,
  writeTask,
  type Candidate,
  type CommitMeta,
  type Config,
  type DiscoveredBy,
  type ExitCode,
  type StageRun,
  type Task,
} from "../core/index.ts";
import { writeTruth } from "../core/truth.ts";
import { classifyPaths } from "./classify.ts";
import { compileLoosePrefix, discover } from "./discover.ts";
import { buildPromptContext, reconstructPrompt } from "./prompt.ts";
import { buildTaxonomy } from "./taxonomy.ts";

/**
 * POSIX single-quote a shell argument: wrap in `'…'` and escape any embedded
 * quote as `'\''`. Unlike double quotes, this neutralizes `$`, backtick, and
 * `\` too — so a test path containing shell metacharacters can't be expanded or
 * mangled when the verifier runs under `sh -c` (a mangled path would run the
 * wrong scope, or none, and spuriously discard a sound task).
 */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Build the verifier command: the repo's test cmd scoped to the changed tests,
 * with paths made relative to `subdir` (the runner's cwd is the subdir). */
export function buildVerifierCmd(testCmd: string, testPaths: readonly string[], subdir?: string): string {
  const rel = testPaths.map((p) => (subdir && p.startsWith(subdir + "/") ? p.slice(subdir.length + 1) : p));
  return `${testCmd} ${rel.map(shQuote).join(" ")}`;
}

interface MineResult {
  discovered: number;
  reconstructed: number;
  discarded: number;
  discardReasons: Record<string, number>;
}

/**
 * Reconstruct one candidate into a task on disk, or return why it was discarded.
 * Takes the ALREADY-classified paths from the caller (the discovery pass
 * computed them) so no second `git diff` runs per candidate.
 */
async function reconstruct(
  repoRoot: string,
  commit: CommitMeta,
  discoveredBy: DiscoveredBy[],
  testPaths: string[],
  sourcePaths: string[],
  config: Config,
  seenIds: Set<string>,
  force: boolean,
): Promise<{ taskId: string } | { discard: string }> {
  const parent = commit.parentSha;
  if (!parent) return { discard: "root commit (no base to diff against)" };

  const subdir = config.subdir;
  if (testPaths.length === 0) return { discard: "no test files changed (nothing to verify)" };
  if (sourcePaths.length === 0) return { discard: "no source files changed (nothing to fix)" };

  const [verifierDiff, fixDiff] = await Promise.all([
    fileDiff(repoRoot, parent, commit.sha, testPaths),
    fileDiff(repoRoot, parent, commit.sha, sourcePaths),
  ]);
  if (!verifierDiff.trim()) return { discard: "empty verifier diff" };
  if (!fixDiff.trim()) return { discard: "empty fix diff" };

  const id = await taskId({ baseSha: parent, verifierPaths: testPaths });
  if (seenIds.has(id)) return { discard: "duplicate task id (same base + verifier set as an earlier commit)" };
  seenIds.add(id);

  // Resume: an already-reconstructed task stands unless --force redoes it.
  if (existsSync(taskDir(repoRoot, id)) && !force) return { taskId: id };

  const sourceStats = await numstat(repoRoot, parent, commit.sha, sourcePaths);
  const task: Task = {
    id,
    prompt: reconstructPrompt(buildPromptContext(commit)),
    baseSha: parent,
    sourceSha: commit.sha,
    date: commit.isoDate,
    taxonomy: buildTaxonomy(commit.subject, sourcePaths, sourceStats, subdir),
    verifierCmd: buildVerifierCmd(config.testCmd, testPaths, subdir),
    discoveredBy,
  };
  await writeTask(repoRoot, task);
  await writeTruth(repoRoot, id, { fixDiff, verifierDiff });
  return { taskId: id };
}

export async function runMine(opts: { repoRoot: string; json: boolean; force: boolean }): Promise<StageRun> {
  const { repoRoot, json, force } = opts;

  let config: Config;
  try {
    config = await readConfig(repoRoot);
  } catch (err) {
    return { stdout: "", stderr: `guignet mine: ${(err as Error).message}\n`, code: EXIT.FAILURE };
  }

  const loose = compileLoosePrefix(config.discovery?.loosePrefix);
  const commits = await listCommits(repoRoot, { subdir: config.subdir, limit: config.discovery?.limit });

  const candidates: Candidate[] = [];
  const seenIds = new Set<string>();
  const result: MineResult = { discovered: 0, reconstructed: 0, discarded: 0, discardReasons: {} };

  for (const commit of commits) {
    const parent = commit.parentSha;
    const changed = parent ? await changedFiles(repoRoot, parent, commit.sha, config.subdir) : [];
    const { testPaths, sourcePaths } = classifyPaths(changed.map((c) => c.path));
    const discoveredBy = discover(
      { subject: commit.subject, body: commit.body, hasTest: testPaths.length > 0, hasSource: sourcePaths.length > 0 },
      loose,
    );
    if (discoveredBy.length === 0) continue; // not task-shaped — not a candidate

    result.discovered++;
    const outcome = await reconstruct(repoRoot, commit, discoveredBy, testPaths, sourcePaths, config, seenIds, force);
    const base = { sha: commit.sha, subject: commit.subject, date: commit.isoDate, discoveredBy };
    if ("taskId" in outcome) {
      result.reconstructed++;
      candidates.push({ ...base, outcome: "reconstructed", taskId: outcome.taskId, discardReason: null });
    } else {
      result.discarded++;
      result.discardReasons[outcome.discard] = (result.discardReasons[outcome.discard] ?? 0) + 1;
      candidates.push({ ...base, outcome: "discarded", taskId: null, discardReason: outcome.discard });
    }
  }

  await writeCandidateLog(repoRoot, { minedAt: new Date().toISOString(), candidates });

  // Suite event spine (§13) — config-gated + best-effort; a no-op unless the
  // target repo opts in (default "auto" emits only when .suite/ already exists).
  await emitEvent(config.spine, repoRoot, "suite.mined", [], { candidates: result.discovered });

  const code: ExitCode = result.reconstructed > 0 ? EXIT.OK : EXIT.SOFT_BLOCKED;
  if (json) return { stdout: JSON.stringify(result) + "\n", stderr: "", code };

  const lines = [
    `Discovered ${result.discovered} candidate(s); reconstructed ${result.reconstructed}, discarded ${result.discarded}.`,
  ];
  for (const [reason, n] of Object.entries(result.discardReasons).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${n}× ${reason}`);
  }
  return { stdout: lines.join("\n") + "\n", stderr: "", code };
}
