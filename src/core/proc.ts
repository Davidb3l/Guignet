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
 *
 * Everything spawned here runs at LOW scheduling priority by default
 * (core/host.ts): benchmark work is background work, and it must never take
 * the machine away from the user running it.
 */
import { buildPriorityArgv, demotePriority, type SpawnPriority } from "./host.ts";

/**
 * The platform shell for a command string: `sh -c` on POSIX; on native
 * Windows, node's full `shell: true` recipe — `%ComSpec% /d /s /c "<cmd>"`
 * with the command EXPLICITLY quote-wrapped AND the argv spawned verbatim
 * (`windowsVerbatimArguments`, see `verbatim`). All three parts are load-
 * bearing: /s strips exactly the outer quote pair we add, and verbatim stops
 * the spawn layer from MSVCRT-escaping the command's own embedded quotes —
 * without it, `bun test "tests/x y.test.ts"` reaches cmd.exe as `\"...\"`
 * (which cmd does not understand) and the workload parses mangled args
 * (review-caught; the quoted-arg runShell test pins it on the Windows CI
 * job). Exported for tests: no Windows box in this loop, so the shape is
 * pinned pure. Windows-native execution is EXPERIMENTAL (see doctor); WSL2
 * is the supported route and takes the POSIX path.
 */
export function shellArgv(cmd: string, plat: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env): string[] {
  if (plat === "win32") return [env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", `"${cmd}"`];
  return ["sh", "-c", cmd];
}

/** Spawn-option companion to shellArgv: pass argv through untouched on
 * Windows (node does exactly this for `shell: true`). Ignored on POSIX. */
function verbatim(plat: NodeJS.Platform = process.platform): { windowsVerbatimArguments?: boolean } {
  return plat === "win32" ? { windowsVerbatimArguments: true } : {};
}

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
  /** Scheduling priority (core/host.ts). Default "low": Guignet's spawns are
   * background work and must yield to the user's foreground under contention.
   * "normal" opts out (config `host.priority`). */
  priority?: SpawnPriority;
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
  /** Scheduling priority (core/host.ts). Default "low" — see ShellOptions. */
  priority?: SpawnPriority;
  /** Windows only: spawn the argv verbatim (no MSVCRT escaping). Set this iff
   * the argv is a `shellArgv(...)` cmd.exe invocation — node's `shell: true`
   * contract. Leave unset for real argv arrays (e.g. the claude-code adapter),
   * where the default escaping is exactly right. Ignored on POSIX. */
  windowsVerbatimArguments?: boolean;
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
    proc = Bun.spawn(buildPriorityArgv(argv, opts.priority ?? "low"), {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdin: "ignore",
      stdout: outFh.fd,
      stderr: errFh.fd,
      ...(opts.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
  } catch {
    await outFh.close();
    await errFh.close();
    return { code: null, timedOut: false };
  }
  // Windows has no exec-in-place wrapper — demote the spawned child directly.
  if ((opts.priority ?? "low") === "low") demotePriority(proc.pid);

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

/** The Windows tree-kill argv (`taskkill /T` kills the whole descendant tree,
 * `/F` forcefully — the platform's `ps`-walk-and-SIGKILL equivalent).
 * Exported for tests: the argv shape is pinned pure, no Windows box needed. */
export function win32KillArgv(pid: number): string[] {
  return ["taskkill", "/pid", String(pid), "/T", "/F"];
}

/**
 * Kill a process and all its descendants (best-effort). POSIX: Bun.spawn
 * doesn't make the child a process-group leader, so a plain `proc.kill`
 * reaps only the immediate child; we snapshot the tree from `ps` and SIGKILL
 * every descendant so nothing survives the wall-clock timeout. Windows:
 * `taskkill /T /F` does the tree walk natively.
 */
export async function killTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    try {
      Bun.spawnSync(win32KillArgv(pid));
    } catch {
      // taskkill missing/failed — nothing more we can do best-effort.
    }
    return;
  }
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
    proc = Bun.spawn(buildPriorityArgv(shellArgv(cmd), opts.priority ?? "low"), {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...verbatim(),
    });
  } catch (err) {
    // Spawn itself failed (cwd gone, shell missing) — surface as a killed run.
    return { code: null, stdout: "", stderr: (err as Error).message, timedOut: false };
  }
  // Windows has no exec-in-place wrapper — demote the spawned child directly.
  if ((opts.priority ?? "low") === "low") demotePriority(proc.pid);

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      // Kill the whole tree, not just the `sh` child: a test runner (vitest,
      // jest) spawns worker processes that would otherwise ORPHAN on a timeout
      // and pile up across a long gate/score run, loading the machine. Same
      // reasoning as spawnToFile. Best-effort.
      void killTree(proc.pid);
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
