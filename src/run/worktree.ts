/**
 * Safe worktree lifecycle for the pool. Multiple attempts run concurrently, and
 * `git worktree add`/`remove` all mutate the SAME repo's `.git/worktrees`
 * administrative area — concurrent invocations can lose a lock race. Two
 * defenses:
 *   - Serialize add/remove through a process-wide mutex. These are fast git
 *     operations; the long pole (the agent run) stays fully parallel, so
 *     serializing them costs ~nothing while removing the race entirely.
 *   - On the rare failure that slips through, retry add (a lock is transient,
 *     not an agent crash — mislabeling it would poison results) and prune a
 *     failed remove so a dangling registration can't accumulate over a long run.
 */
import { git, worktreeAdd, worktreeRemove } from "../core/index.ts";

// A promise-chain mutex: each critical section awaits the previous one.
let tail: Promise<unknown> = Promise.resolve();
function withGitLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => {});
  return run;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Add a detached worktree at `sha`, retrying transient lock failures. */
export function safeWorktreeAdd(repoRoot: string, sha: string, dest: string): Promise<boolean> {
  return withGitLock(async () => {
    for (let i = 0; i < 3; i++) {
      const r = await worktreeAdd(repoRoot, sha, dest);
      if (r.ok) return true;
      await sleep(50 * (i + 1));
    }
    return false;
  });
}

/** Remove a worktree; on failure, prune so no dangling registration lingers. */
export function safeWorktreeRemove(repoRoot: string, dest: string): Promise<void> {
  return withGitLock(async () => {
    const r = await worktreeRemove(repoRoot, dest);
    if (!r.ok) await git(["worktree", "prune"], repoRoot);
  });
}
