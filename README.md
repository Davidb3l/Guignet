# Guignet

**The referee.** Point it at your repository and it mines your own git history
into replayable, validity-checked tasks, runs any model / agent / config
against them in isolated worktrees — entirely locally — and hands you the only
leaderboard that matters: *on your code*.

Public benchmarks are saturated and measured on other people's repos; eval SaaS
requires uploading private code. Guignet is local-first by category, not by
preference: the tool that never sees your code is the only one you can run on
your real code.

> Named after Charles-Émile Guignet, whose 1859 process made viridian
> ("Guignet's green") commercially producible. *The green that proved itself.*

## Status

Early development. **M0 (scaffold) is complete**: the CLI skeleton, store, suite
discovery handshake, and the leak-firewall boundary check are in place and
green. History mining (M1), the runner (M2), and scoring + the report (M3) are
next.

## Requirements

[Bun](https://bun.sh) ≥ 1.3 and `git`. No npm/node/pnpm.

```sh
bun install
bun run guignet doctor          # validate a repo + suite discovery handshake
bun run check                   # typecheck + import boundaries + tests
```

## CLI

```
guignet doctor            validate the repo, answer the suite discovery handshake
guignet mine              discover + reconstruct tasks from git history      (M1)
guignet gate              replay validity, build the admitted suite          (M1)
guignet run --config X    execute attempts in isolated worktrees             (M2)
guignet score [runId]     verdicts + metrics + contamination                 (M3)
guignet report            regenerate the self-contained HTML report          (M3)
```

All commands accept `--json` (exactly one JSON object on stdout). Exit codes:
`0` ok · `1` failure · `2` usage · `3` soft-blocked.

## License

MIT.
