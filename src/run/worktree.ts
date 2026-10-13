/**
 * Agent workspace lifecycle for the pool. An agent does NOT get a `git
 * worktree` of the target repo: a linked worktree shares the main repo's object
 * store (so `git log --all` shows the held-out FIX commit) and its `.git` file
 * points back at the main checkout, where `.guignet/tasks/<id>/truth/` lives.
 * Instead each attempt gets an ISOLATED workspace — the base commit's tree
 * exported into a fresh directory and committed as the single root commit of a
 * brand-new repo (`createIsolatedWorkspace`, core/git.ts). There is no worktree
 * registration, so nothing to prune and no shared admin area to race on:
 * concurrent attempts only read the source repo.
 *
 * Guignet's OWN worktrees (gate replay, score) are unchanged — they run only
 * Guignet's code, never an agent.
 */
import { rm } from "node:fs/promises";

import { createIsolatedWorkspace } from "../core/index.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Export `sha` of `repoRoot` into `dest` as an isolated single-commit repo,
 * retrying transient failures (e.g. an antivirus/indexer briefly holding a file
 * on Windows) — an environment hiccup is not an agent crash, and mislabeling it
 * would poison results. Returns an error message on final failure, else null.
 * `dest` is cleaned between tries so each starts from nothing.
 */
export async function createAgentWorkspace(repoRoot: string, sha: string, dest: string): Promise<string | null> {
  let error = "unknown error";
  for (let i = 0; i < 3; i++) {
    const r = await createIsolatedWorkspace(repoRoot, sha, dest);
    if (r.ok) return null;
    error = r.error;
    await rm(dest, { recursive: true, force: true }).catch(() => {});
    await sleep(50 * (i + 1));
  }
  return error;
}
