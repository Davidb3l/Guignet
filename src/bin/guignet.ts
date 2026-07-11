#!/usr/bin/env bun
/**
 * The `guignet` binary. Bun runs .ts directly, so this needs no build step.
 * The dispatcher (cli/index.ts) is pure over its return code; this shim owns
 * the one process.exit and the last-resort guard that keeps a stack trace off
 * stdout (§4 rule 1).
 */
import { main } from "../cli/index.ts";

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`guignet: fatal: ${err?.message ?? err}\n`);
    process.exit(1);
  },
);
