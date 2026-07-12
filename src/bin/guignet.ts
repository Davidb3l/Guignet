#!/usr/bin/env bun
/**
 * The `guignet` binary. Bun runs .ts directly, so this needs no build step.
 * The dispatcher (cli/index.ts) is pure over its return code; this shim owns
 * the one process.exit and the last-resort guard that keeps a stack trace off
 * stdout (§4 rule 1).
 */
import { main } from "../cli/index.ts";

// Top-level await (NOT `.then()`), and set exitCode rather than process.exit().
// Both matter: process.exit() abandons buffered stdout + in-flight fs writes,
// and a floating `.then()` chain lets Bun wind the process down before that
// chain's async work finishes — either way, on a large repo (hundreds of tasks)
// the output and the store were silently truncated. Awaiting the whole run and
// letting the loop drain keeps every write intact and still exits promptly (our
// stages leave no open handles: subprocesses are awaited, timers cleared).
try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`guignet: fatal: ${(err as { message?: string })?.message ?? err}\n`);
  process.exitCode = 1;
}
