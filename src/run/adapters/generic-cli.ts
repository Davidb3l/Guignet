/**
 * The `generic-cli` adapter (ARCHITECTURE.md §6) — the escape hatch that makes
 * Guignet harness-neutral on day one: spawn ANY command template with `{prompt}`
 * and `{worktree}` substituted, run it in the worktree, and let the runner
 * observe the resulting diff. The referee can't only know how to referee one
 * team, so this ships in v0 alongside claude-code.
 *
 * It has no standardized transcript, so `parseCost` returns null — generic-cli
 * runs report wall-clock but no token/$ cost. That's honest: we never invent a
 * number a harness didn't give us (§5).
 */
import { spawnToFile } from "../../core/index.ts";
import type { Adapter, AttemptCost, AttemptExit, AttemptInput } from "./types.ts";

/** Wall-clock ceiling when the run config sets no `budget.maxSeconds`. Without
 * one, a hung generic agent would block its pool slot forever (and a resume
 * would re-hang it) — violating the §5 "bounded" contract. Mirrors the
 * claude-code adapter's default. */
const DEFAULT_TIMEOUT_MS = 900_000;

/** POSIX single-quote a string so shell metacharacters in it are inert. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Substitute the template placeholders, both SAFELY SINGLE-QUOTED so a path or
 * prompt containing a space or shell metacharacter can't break the command:
 * use them bare in the template (`myagent --task {prompt} --dir {worktree}`),
 * not wrapped in more quotes. The prompt and worktree are also exported as env
 * vars for templates that prefer them (`GUIGNET_PROMPT`, `GUIGNET_WORKTREE`).
 */
export function substituteCmd(cmd: string, prompt: string, worktree: string): string {
  return cmd.replaceAll("{worktree}", shQuote(worktree)).replaceAll("{prompt}", shQuote(prompt));
}

export function makeGenericCliAdapter(cmdTemplate: string): Adapter {
  return {
    name: "generic-cli",

    // There's no single binary to detect — the user supplied the command, so
    // availability is their responsibility. Report present; a broken command
    // surfaces as a crashed attempt, not an absent adapter.
    async detect(): Promise<boolean> {
      return cmdTemplate.trim().length > 0;
    },

    async attempt(input: AttemptInput): Promise<{ exit: AttemptExit }> {
      const cmd = substituteCmd(cmdTemplate, input.prompt, input.worktreePath);
      const timeoutMs = input.budget.maxSeconds ? input.budget.maxSeconds * 1000 : DEFAULT_TIMEOUT_MS;
      const { code, timedOut } = await spawnToFile(["sh", "-c", cmd], {
        cwd: input.worktreePath,
        stdoutPath: `${input.transcriptDir}/stdout.log`,
        stderrPath: `${input.transcriptDir}/stderr.log`,
        timeoutMs,
        env: { GUIGNET_PROMPT: input.prompt, GUIGNET_WORKTREE: input.worktreePath },
        priority: input.priority,
      });
      if (timedOut) return { exit: "budget-exhausted" };
      if (code !== 0) return { exit: "crashed" };
      return { exit: "completed" };
    },

    // No standardized transcript ⇒ no trustworthy token/$ figure to report.
    async parseCost(): Promise<AttemptCost | null> {
      return null;
    },
  };
}
