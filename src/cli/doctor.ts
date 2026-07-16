/**
 * `guignet doctor [--json]` — the suite discovery handshake (SUITE_CONTRACTS
 * §3 / ARCHITECTURE.md §13, schemaVersion 1).
 *
 * Under `--json` this emits EXACTLY ONE JSON object on stdout so peers — the
 * Sirius Suite Hub, `sirius`, `amt`, `hayven` — discover Guignet with no
 * Guignet-specific knowledge (§4 rule 1). Health lives in `ok`, never in the
 * exit code (§3.1: exit 0 + `ok:false` = present-but-unhealthy; a non-zero exit
 * means absent). No `ui` field/capability — Guignet's report is a static HTML
 * file, not a served UI (§3.2). The CLI layer owns process I/O and exit codes;
 * everything here is pure and directly testable.
 *
 * Capabilities are advertised only when the feature exists TODAY. At M0 Guignet
 * has no interop capabilities (`events.emit` lands in M4), so it advertises an
 * empty list — honest, and still a valid handshake.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { configPath, isInitialized, readConfig, storeRoot } from "../core/store.ts";

export const SCHEMA_VERSION = 1;

/** Interop capabilities Guignet implements today. Empty at M0 (see header). */
export const CAPABILITIES: readonly string[] = [];

/** One §3 check row plus whether it gates overall health. */
export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  gating: boolean;
}

/** Inputs doctor needs, injected so checks are testable against temp dirs. */
export interface DoctorEnv {
  /** The repo doctor is inspecting (process.cwd() in prod). */
  cwd: string;
  /** Guignet's version, read from package.json (never hardcoded). */
  version: string;
  /** `Bun.version` when running under Bun, else null. */
  bunVersion: string | null;
  /** Whether the `git` binary is available (probed by the caller). */
  gitAvailable: boolean;
  /** Whether `cwd` is inside a git work tree (probed by the caller). */
  isGitRepo: boolean;
  /** Host platform; defaults to process.platform. Injectable for tests. */
  platform?: NodeJS.Platform;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  version: string;
  initialized: boolean;
}

/** Overall health = the GATING checks only. Exported so the fold is testable. */
export function computeOk(checks: readonly DoctorCheck[]): boolean {
  return checks.every((c) => !c.gating || c.ok);
}

/**
 * Run every check. Read-only — never writes any store. A repo that simply
 * hasn't been set up for benchmarking yet (`no .guignet/config.json`) is a
 * healthy standalone state, exactly like the Suite Hub probing a directory that
 * has nothing to do with Guignet.
 */
export async function collectReport(env: DoctorEnv): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  // Runtime: Guignet is Bun-run. No Bun means it was launched wrong.
  checks.push({
    name: "bun_present",
    ok: env.bunVersion !== null,
    detail: env.bunVersion ? `Bun ${env.bunVersion}` : "not running under Bun",
    gating: true,
  });

  // Git is fundamental — Guignet mines history and replays in worktrees. If the
  // binary is absent, Guignet cannot work in ANY repo, so this gates.
  checks.push({
    name: "git_present",
    ok: env.gitAvailable,
    detail: env.gitAvailable ? "git on PATH" : "git not found on PATH",
    gating: true,
  });

  // Whether THIS dir is a repo is informational: doctor is runnable anywhere,
  // and a non-repo cwd just means "nothing to benchmark here" (non-gating).
  checks.push({
    name: "git_repo",
    ok: env.isGitRepo,
    detail: env.isGitRepo ? `${env.cwd} is a git work tree` : `${env.cwd} is not a git repo — nothing to benchmark here`,
    gating: false,
  });

  // Native Windows is EXPERIMENTAL: priority demotion and the memory gate are
  // best-effort (direct-child priority class, freemem ratio), the CPU load
  // gate is unavailable by construction (os.loadavg is zero on win32), and the
  // pipeline is not yet exercised by Windows CI. WSL2 reports linux and gets
  // full support. Non-gating — the tool still runs — but the user deserves to
  // know before trusting an overnight benchmark to it. Emitted only on win32
  // so the envelope stays minimal everywhere else (§3.1 present-vs-absent).
  if ((env.platform ?? process.platform) === "win32") {
    checks.push({
      name: "platform",
      ok: false,
      detail: "native Windows is experimental (best-effort priority/memory signals; no CPU load gate) — WSL2 recommended for full support",
      gating: false,
    });
  }

  const initialized = isInitialized(env.cwd);
  if (!initialized) {
    checks.push({
      name: "config",
      ok: true,
      detail: `no ${storeRoot(env.cwd)}/config.json — repo not set up for benchmarking yet`,
      gating: true,
    });
    return { ok: computeOk(checks), checks, version: env.version, initialized };
  }

  // A config that EXISTS but is malformed is genuinely broken → gating failure.
  try {
    const config = await readConfig(env.cwd);
    checks.push({
      name: "config",
      ok: true,
      detail: `${configPath(env.cwd)} parses; test cmd: ${config.testCmd}`,
      gating: true,
    });

    // When a monorepo subdir is configured, it must exist in the repo (§3).
    if (config.subdir) {
      const subdirOk = existsSync(join(env.cwd, config.subdir));
      checks.push({
        name: "subdir",
        ok: subdirOk,
        detail: subdirOk ? `subdir '${config.subdir}' present` : `configured subdir '${config.subdir}' does not exist`,
        gating: true,
      });
    }
  } catch (err) {
    checks.push({
      name: "config",
      ok: false,
      detail: `config is present but invalid: ${(err as Error).message}`,
      gating: true,
    });
  }

  return { ok: computeOk(checks), checks, version: env.version, initialized };
}

/** The §3 handshake envelope. `report` is free-form additive detail. */
export function buildEnvelope(report: DoctorReport): Record<string, unknown> {
  return {
    tool: "guignet",
    version: report.version,
    schemaVersion: SCHEMA_VERSION,
    ok: report.ok,
    capabilities: [...CAPABILITIES],
    checks: report.checks.map((c) => ({ name: c.name, ok: c.ok, detail: c.detail })),
    report: { initialized: report.initialized },
  };
}

/**
 * The envelope for a doctor run that threw before finishing its checks. Without
 * it, a throw would leave stdout empty and §3.1 forces every consumer to
 * classify an INSTALLED-but-broken Guignet as *absent*. Reporting `ok:false`
 * keeps it visible as present-unhealthy.
 */
export function envelopeForFailure(version: string, err: Error): Record<string, unknown> {
  return {
    tool: "guignet",
    version,
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    capabilities: [...CAPABILITIES],
    checks: [{ name: "doctor_ran", ok: false, detail: `doctor could not complete: ${err.message}` }],
    report: { error: err.message },
  };
}

/** The human report — printed when `--json` is absent. */
export function renderHuman(report: DoctorReport): string {
  const lines: string[] = ["guignet doctor", `  version: ${report.version}`, ""];
  for (const c of report.checks) {
    lines.push(`  ${c.ok ? "OK  " : "FAIL"} ${c.name}: ${c.detail}`);
  }
  lines.push("");
  lines.push(report.ok ? "healthy ✓" : "unhealthy — some checks are failing (see above)");
  return lines.join("\n") + "\n";
}

export interface DoctorRun {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Run doctor and return bytes + exit code, no process side effects.
 *
 * `--json`: exactly one JSON object on stdout; exit 0 whenever an envelope was
 * produced (health is in `ok`). Even an unexpected throw yields a parseable
 * `ok:false` envelope at exit 0, so a broken-but-installed Guignet reads as
 * present-unhealthy, not absent (§3.1). Human mode keeps the shell/CI contract:
 * exit `ok ? 0 : 1`.
 */
export async function runDoctor(opts: { json: boolean; env: DoctorEnv }): Promise<DoctorRun> {
  const { json, env } = opts;
  if (json) {
    let envelope: Record<string, unknown>;
    let stderr = "";
    try {
      envelope = buildEnvelope(await collectReport(env));
    } catch (err) {
      stderr = `doctor: ${(err as Error).message}\n`;
      envelope = envelopeForFailure(env.version, err as Error);
    }
    return { stdout: JSON.stringify(envelope) + "\n", stderr, code: 0 };
  }
  const report = await collectReport(env);
  return { stdout: renderHuman(report), stderr: "", code: report.ok ? 0 : 1 };
}
