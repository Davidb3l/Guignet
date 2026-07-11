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

export interface SpawnToFileOptions {
  cwd: string;
  /** File to receive the process's stdout (created/truncated). */
  stdoutPath: string;
  /** File to receive the process's stderr (created/truncated). */
  stderrPath: string;
  /** Wall-clock limit; on expiry the process is SIGKILLed. Omit for no limit. */
  timeoutMs?: number;
  env?: Record<string, string>;
}

/**
 * Spawn `argv` and stream its stdout/stderr STRAIGHT TO FILES (via OS file
 * descriptors), never buffering in this process. This is the agent-supervision
 * lesson from Sirius Forester: an agent can emit far more than a pipe buffer
 * holds (~64 KiB), and reading it into memory risks a deadlock and blows up RSS
 * on long runs. Writing to fds lets the kernel handle backpressure. A
 * wall-clock timeout SIGKILLs a hung agent. Never throws — inspect `code`.
 *
 * Used by the run adapters (§6); test output stays on the buffered `runShell`.
 */
export async function spawnToFile(
  argv: string[],
  opts: SpawnToFileOptions,
): Promise<{ code: number | null; timedOut: boolean }> {
  const { open } = await import("node:fs/promises");
  let outFh: Awaited<ReturnType<typeof open>> | undefined;
  let errFh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    outFh = await open(opts.stdoutPath, "w");
    errFh = await open(opts.stderrPath, "w");
  } catch (err) {
    await outFh?.close();
    process.stderr.write(`guignet: could not open agent log file: ${(err as Error).message}\n`);
    return { code: null, timedOut: false };
  }

  let proc: Bun.Subprocess<"ignore", number, number>;
  try {
    proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdin: "ignore",
      stdout: outFh.fd,
      stderr: errFh.fd,
    });
  } catch {
    await outFh.close();
    await errFh.close();
    return { code: null, timedOut: false };
  }

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      // Kill the whole tree, not just the direct child: an agent spawns tool
      // subprocesses (bash, test runners) that would otherwise ORPHAN and keep
      // running/loading the box across a long overnight run. Best-effort.
      void killTree(proc.pid);
    }, opts.timeoutMs);
  }
  const code = await proc.exited;
  if (timer) clearTimeout(timer);
  await outFh.close();
  await errFh.close();
  return { code, timedOut };
}

/**
 * SIGKILL a process and all its descendants (best-effort, portable via `ps`).
 * Bun.spawn doesn't make the child a process-group leader, so a plain
 * `proc.kill` reaps only the immediate child; we snapshot the tree from `ps`
 * and kill every descendant so nothing survives the wall-clock timeout.
 */
export async function killTree(pid: number): Promise<void> {
  const descendants = collectDescendants(pid);
  // Kill the root first (stop it spawning more), then everything under it.
  for (const p of [pid, ...descendants]) {
    try {
      process.kill(p, "SIGKILL");
    } catch {
      // Already gone — fine.
    }
  }
}

/** Every transitive child pid of `root`, via one `ps` snapshot. */
function collectDescendants(root: number): number[] {
  let out = "";
  try {
    out = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="]).stdout.toString();
  } catch {
    return [];
  }
  const childrenOf = new Map<number, number[]>();
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const kid = Number(m[1]);
    const parent = Number(m[2]);
    const list = childrenOf.get(parent);
    if (list) list.push(kid);
    else childrenOf.set(parent, [kid]);
  }
  const result: number[] = [];
  const stack = [root];
  while (stack.length > 0) {
    for (const kid of childrenOf.get(stack.pop()!) ?? []) {
      result.push(kid);
      stack.push(kid);
    }
  }
  return result;
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
