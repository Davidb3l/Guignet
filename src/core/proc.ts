/**
 * Subprocess execution — run a shell command and capture its output, with a
 * wall-clock timeout that kills a hung process. Shared infrastructure: `gate`
 * runs the target repo's setup/test commands through it now, and M2's runner
 * will drive agent commands through the same seam.
 *
 * Commands are run via `sh -c` so a config's `testCmd` ("bun test tests/x")
 * behaves exactly as it would in the user's shell. Output is buffered — fine
 * for test runs; M2's agent supervision will stream to a file instead (agent
 * logs are large and long-lived; test output is small and short).
 */

export interface ShellResult {
  /** Exit code, or null if the process was killed (timeout/signal). */
  code: number | null;
  stdout: string;
  stderr: string;
  /** True if the wall-clock timeout fired and we killed the process. */
  timedOut: boolean;
}

export interface ShellOptions {
  cwd: string;
  /** Wall-clock limit; on expiry the process is SIGKILLed. Omit for no limit. */
  timeoutMs?: number;
  /** Extra env vars, merged over the current environment. */
  env?: Record<string, string>;
}

/** Run `sh -c <cmd>` in `cwd`, capturing stdout/stderr. Never throws. */
export async function runShell(cmd: string, opts: ShellOptions): Promise<ShellResult> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["sh", "-c", cmd], {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    // Spawn itself failed (cwd gone, sh missing) — surface as a killed run.
    return { code: null, stdout: "", stderr: (err as Error).message, timedOut: false };
  }

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill(9);
    }, opts.timeoutMs);
  }

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (timer) clearTimeout(timer);

  return { code, stdout, stderr, timedOut };
}
