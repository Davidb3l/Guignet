# Guignet

**The referee.** Point it at your repository and it mines your own git history
into replayable, validity-checked tasks, runs any model / agent / config
against them in isolated worktrees — entirely locally — and hands you the only
leaderboard that matters: *on your code*.

Public benchmarks are saturated and measured on other people's repos; eval SaaS
requires uploading private code. Guignet is local-first by category, not by
preference: the tool that never sees your code is the only one you can run on
your real code.

> Named after Charles-Émile Guignet, whose 1859 process made viridian —
> hydrated chromium oxide green, still called "Guignet's green" — commercially
> producible: a pigment that had to prove itself before anyone would trust it.
> *The green that proved itself.*

## Status

The full pipeline works end to end — `mine → gate → run → score → report` —
and has been dogfooded on two repositories: a private production codebase and
the public [honojs/hono](https://github.com/honojs/hono) framework (a non-Bun,
vitest-based project), which produced a real Sonnet-vs-Haiku leaderboard with
confidence intervals and a contamination split. Still pre-1.0; the report and
CLI contracts are stable, hardening continues.

## How it works

1. **`mine`** walks your git history for task-shaped commits (a fix plus the
   tests that prove it) and reconstructs each into a prompt, a base commit, a
   held-out fix, and a held-out verifier. A leak firewall — enforced by a CI
   boundary check — keeps the fix out of the prompt.
2. **`gate`** admits a task only after replaying it in a clean worktree: the
   verifier must fail at base and pass at the real fix, k times each. Flaky
   tasks are discarded, never patched. The **soundness rate** is published.
3. **`run`** executes N attempts per task (default 3) in disposable worktrees,
   through an adapter (`claude-code` or the `generic-cli` escape hatch). Cost is
   parsed from the harness's own transcript, never self-reported.
4. **`score`** applies each solution over the held-out verifier — binary,
   judge-free — and computes contamination controls (cutoff split, regurgitation
   flags) and secondary metrics.
5. **`report`** renders one self-contained HTML file (no framework, no CDN,
   renders offline) plus a `--json` twin of every number in it.

See [`METHODOLOGY.md`](METHODOLOGY.md) for the full method and its honest limits.

## Host citizenship

A benchmark run is background work, and Guignet treats your machine that way:
every subprocess it spawns — agents, installs, verifiers — runs at reduced
scheduling priority (`taskpolicy -c utility` on macOS, `nice` on Linux;
unchanged on other platforms), so your foreground always wins under
contention. The run pool is host-aware on two kernel signals — CPU load
average and the kernel's own memory-pressure verdict
(`kern.memorystatus_vm_pressure_level` on macOS, PSI on Linux). Memory
pressure "warn" narrows the pool's *starting* width (it's a chronic steady
state on 8–16 GB Macs, so it never throttles a run mid-flight); "critical"
and CPU saturation hold extra concurrency, degrading to sequential progress
(never a stall, never a freeze). On hosts with no pressure signal (e.g. a
Linux kernel without PSI) the memory gate quietly disarms — fail-open — and
the CPU gate stands alone. Runs are resumable, so interrupting one costs
nothing.

Low priority is also what gets starved on a busy machine, so a verifier could
time out under contention where it would have passed — `score` therefore
retries a timed-out verifier once at normal priority before recording a
failure (a genuine hang still times out; only a real pass can flip the
verdict). `gate` stays conservative: a timeout there discards the task, which
is fail-safe. Opt out of all of it with `host.priority: "normal"` if you're
benchmarking on a dedicated box and want every cycle.

## Requirements

[Bun](https://bun.sh) ≥ 1.3 and `git`. No npm/node/pnpm.

## Quickstart

Create `.guignet/config.json` in the target repo:

```json
{
  "testCmd": "bun test",
  "setupCmd": "bun install",
  "repoVisibility": "public"
}
```

Then run the pipeline (each stage is idempotent and resumable):

```sh
guignet doctor                       # validate the repo + suite discovery handshake
guignet mine                         # reconstruct tasks from git history
guignet gate                         # replay validity → the admitted suite
guignet run --config run.json        # execute attempts (a run config names the model/adapter)
guignet score                        # verdicts + metrics + contamination
guignet report                       # → .guignet/reports/<ts>/guignet-report.html
```

A run config:

```json
{ "runId": "2026-07-11-sonnet", "adapter": "claude-code", "model": "sonnet", "nAttempts": 3 }
```

Every command accepts `--json` (exactly one JSON object on stdout). Exit codes:
`0` ok · `1` failure · `2` usage · `3` soft-blocked.

## Config reference

| Key | Meaning |
|---|---|
| `testCmd` | how the repo runs its tests (verifier commands scope to it) |
| `setupCmd` | one-time environment setup, e.g. `bun install` |
| `subdir` | package root inside a monorepo |
| `repoVisibility` | `public` / `private` / `mixed` / `unknown` — frames the cutoff split (contamination vs knowledge-freshness) |
| `cutoffs` | per-model training-cutoff overrides (ISO dates) |
| `gateReplays` | validity replay count `k` (default 2) |
| `testCwd` | where setup/verifier/agent run: `subdir` (default) or `repo` — use `repo` for workspace test runners (vitest `projects`, pnpm/nx) that must execute at the repo root |
| `host.priority` | scheduling priority for all spawned work: `low` (default — yields to your foreground) / `normal` |
| `host.maxLoadPerCore` | run-pool admission threshold: add concurrency only while load1 ≤ this × cores (default 1.5) |
| `spine` | suite event emission: `auto` (default, only if `.suite/` exists) / `on` / `off` |

## Development

```sh
bun install
bun run check    # typecheck + import-boundary firewall + tests
```

## License

MIT.
