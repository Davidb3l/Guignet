/**
 * `guignet` — CLI entry and dispatch (ARCHITECTURE.md §10).
 *
 *   guignet doctor            validate repo + suite discovery handshake (§13)
 *   guignet mine              discover + reconstruct tasks            (M1)
 *   guignet gate              validity replay, build suite.json       (M1)
 *   guignet run --config X    execute attempts (resumable)            (M2)
 *   guignet score [runId]     verdicts + metrics + contamination      (M3)
 *   guignet report            regenerate HTML from the store          (M3)
 *
 * Arg parsing is hand-rolled (no commander/yargs) to match the suite style.
 * Conventions (§4): `--json` ⇒ exactly one JSON object on stdout, all logs to
 * stderr; exit codes 0 ok · 1 failure · 2 usage · 3 soft-blocked. Doctor is the
 * §3.1 exception (health in the envelope, not the exit code).
 */
import { fileURLToPath } from "node:url";

import { EXIT, gitAvailable, isGitRepo, type StageRun } from "../core/index.ts";
import { runGate } from "../gate/index.ts";
import { runMine } from "../mine/index.ts";
import { runReport } from "../report/index.ts";
import { runRun } from "../run/index.ts";
import { runScore } from "../score/index.ts";
import { runDoctor, type DoctorEnv } from "./doctor.ts";

const USAGE = `guignet — the referee: private benchmarking of AI coding agents on your repo

Usage:
  guignet doctor [--json]          Validate the repo + suite discovery handshake
  guignet mine [--force] [--json]  Discover + reconstruct tasks from git history
  guignet gate [--force] [--json]  Replay validity, build the admitted suite
  guignet run --config <f> [--json]  Execute attempts in isolated worktrees
  guignet score [<runId>] [--json]   Verdicts + metrics + contamination
  guignet report [--json]          Regenerate the HTML report from the store
  guignet --help                   Show this help

All commands accept --json (exactly one JSON object on stdout). mine/gate/run/
score accept --force. Exit codes: 0 ok · 1 failure · 2 usage · 3 soft-blocked.`;

/** Read the version from package.json (never hardcoded). */
async function readVersion(): Promise<string> {
  try {
    const pkgUrl = new URL("../../package.json", import.meta.url);
    const pkg = JSON.parse(await Bun.file(fileURLToPath(pkgUrl)).text());
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Probe the real environment for doctor's checks (impure; kept out of collect). */
async function buildDoctorEnv(cwd: string): Promise<DoctorEnv> {
  const [available, isRepo] = await Promise.all([gitAvailable(), isGitRepo(cwd)]);
  return {
    cwd,
    version: await readVersion(),
    bunVersion: typeof Bun !== "undefined" ? Bun.version : null,
    gitAvailable: available,
    isGitRepo: isRepo,
  };
}

/** Extract `--config <value>` / `--config=<value>` from args, if present. */
function flagValue(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  if (i !== -1 && i + 1 < args.length && !args[i + 1]!.startsWith("-")) return args[i + 1];
  return undefined;
}

/** Emit a stage's bytes and return its code. */
function emit(run: StageRun): number {
  if (run.stderr) process.stderr.write(run.stderr);
  if (run.stdout) process.stdout.write(run.stdout);
  return run.code;
}

export async function main(argv: string[]): Promise<number> {
  const args = argv.slice();
  const json = args.includes("--json");
  const force = args.includes("--force");
  const wantsHelp = args.includes("--help") || args.includes("-h");
  const positionals = args.filter((a) => !a.startsWith("-"));
  const sub = positionals[0];
  const cwd = process.cwd();

  if (wantsHelp && !sub) {
    // §4 rule 1: nothing non-JSON on stdout under --json. A bare `--json --help`
    // is contradictory (nothing to emit) → usage error, help to stderr.
    if (json) {
      process.stderr.write(USAGE + "\n");
      return EXIT.USAGE;
    }
    process.stdout.write(USAGE + "\n");
    return EXIT.OK;
  }

  switch (sub) {
    case "doctor": {
      const run = await runDoctor({ json, env: await buildDoctorEnv(cwd) });
      if (run.stderr) process.stderr.write(run.stderr);
      process.stdout.write(run.stdout);
      return run.code;
    }
    case "mine":
      return emit(await runMine({ repoRoot: cwd, json, force }));
    case "gate":
      return emit(await runGate({ repoRoot: cwd, json, force }));
    case "run":
      return emit(await runRun({ repoRoot: cwd, json, force, config: flagValue(args, "config") }));
    case "score":
      return emit(await runScore({ repoRoot: cwd, json, force, runId: positionals[1] }));
    case "report":
      return emit(await runReport({ repoRoot: cwd, json }));
    case undefined:
      process.stderr.write(USAGE + "\n");
      return EXIT.USAGE;
    default:
      process.stderr.write(`guignet: unknown command '${sub}'\n\n${USAGE}\n`);
      return EXIT.USAGE;
  }
}
