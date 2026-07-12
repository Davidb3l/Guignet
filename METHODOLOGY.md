# Guignet — methodology

> How the referee works, and where it stops short. Guignet's only asset is
> trust, so this document is part of the product: it states the method and its
> limitations plainly. If a number in a report isn't explained here, treat it
> as unexplained.

Guignet turns a repository's own git history into a private, replayable
benchmark for AI coding agents, and reports the results with their confidence
intervals and contamination controls attached. Everything runs locally; the
tool never uploads your code.

## 1. History mining — where tasks come from

Your repository's past is a free, perfectly realistic task dataset. Guignet
walks git history (`--no-merges`, so the actual fix-plus-test commits aren't
hidden behind merge commits) and reconstructs each task-shaped commit into a
tuple:

- **prompt** — the task statement, rebuilt from the human record: commit
  subject and body (and issue/PR text where available). An LLM may later clean
  this up, but the reconstruction can never see the fix — see the leak firewall.
- **base** — the parent commit the agent starts from.
- **ground truth** — the real source fix, held out.
- **verifier** — the tests the commit added or changed, also held out.

**Discovery** runs three heuristics as peers and unions their matches, because
no single one is enough: (a) commits whose diff touches *both* test and source
files — the strongest signal, and the only one that guarantees a verifiable
task; (b) strict conventional-commit prefixes (`fix:`, `feat:`, …); (c) a
configurable loose "scope: summary" prefix, plus issue-linked commits. Each
task records which heuristics surfaced it. On a real repo the test+source signal
does most of the work — conventional prefixes alone were a minority of history.

**The leak firewall.** A benchmark is worthless if the agent can see the answer.
Guignet enforces this structurally, not by convention: the prompt reconstructor
accepts only a `PromptContext` (subject/body/issue refs) that *has no field
capable of carrying a diff*, ground truth lives behind a single module, and a CI
import-boundary check fails the build if any stage that shouldn't touch ground
truth so much as names its path. The mining stage writes ground truth once and
never reads it back.

## 2. The validity gate — why the tasks are trustworthy

A reconstructed task is only admitted after Guignet proves it reproduces
reality, in a clean git worktree with the repo's own setup and test commands:

- the held-out verifier must **FAIL at base** k times (the bug is really
  present), and
- **PASS after the real fix** is applied k times (the fix really resolves it).

Default k = 2. Any task that flakes — passes at base, fails at fix, times out,
or its environment won't stand up — is **discarded, never patched**. Discarding
is the feature: it's what makes the surviving suite sound.

Guignet publishes the **soundness rate** (admitted ÷ discovered candidates) in
every report, and records a per-candidate discard reason. A low soundness rate
is not hidden; it's a signal about mining quality on that repo.

## 3. Execution — running agents fairly

Each attempt runs in its own disposable git worktree checked out at the task's
base commit. Guignet installs the repo's dependencies first, so the agent starts
from the same working environment a developer would (able to resolve imports and
run tests) — setup time is *not* charged against the agent. The harness never
pushes and never touches your real checkout.

Agents are stochastic, so Guignet runs **N attempts per task** (default 3). A
single attempt (n=1) is watermarked "anecdote, not measurement" in the report —
one sample is not a benchmark. Adapters are thin per-harness drivers; v0 ships
`claude-code` (headless) and a `generic-cli` escape hatch that runs any command,
so Guignet is not tied to one agent.

**Cost** is captured by parsing each harness's own transcript for tokens and
dollars — never self-reported by the agent — and wall-clock is measured by the
runner around the agent call only. When an attempt has no priceable transcript
(a crash, a generic command), its cost is recorded as unknown rather than zero,
and any aggregate built from partial coverage is marked a lower bound.

## 4. Scoring — the verdict

The primary verdict is binary and judge-free: apply the agent's solution to a
fresh worktree, overlay the held-out verifier, run it. Pass or fail. Every
un-judgeable condition (the solution won't apply, the environment won't build,
the verifier crashes or hangs) resolves to a fail — the agent gets no credit for
a solution that couldn't be objectively verified.

**The verifier is authoritative over its own paths.** Agents routinely fix the
source *and* write their own tests — often in the very files the held-out
verifier patches. Before the overlay, Guignet sets aside every part of the
solution that touches a held-out path (a file the verifier diff touches, or any
test-classified file, by the same rule mining used to split fix from verifier).
The agent is judged on its source change alone — the mirror of what the
validity gate proved (base + source fix + verifier) — so its own test edits are
neither punished nor rewarded. This cannot credit a wrong fix: the real
verifier is restored over any agent edit to it, and a solution whose only
change is test edits has nothing to judge and fails. Verdicts record a
`testEditsFiltered` flag whenever this projection removed anything, and the
secondary metrics below are computed on the same source-only projection
(the ground-truth fix is source-only by construction, so anything else would
compare unlike things).

A task is **solved** by a config if at least one of its attempts passes
(resolve@n). The headline number is **$ per solved task**. Solve rates carry a
**95% Wilson confidence interval**, always rendered — on the small suites a
single repo yields, the interval is the honest part of the number.

Secondary metrics: tokens and wall-clock, and a **bloat ratio** (the agent's
change size vs the ground-truth fix).

## 5. Contamination controls — and their honest limits

A model may have trained on your public history. Guignet dates every task and
splits every score by the model's training cutoff, and it flags solutions whose
similarity to the held-out fix is suspiciously high (token-level Jaccard) on
pre-cutoff tasks — verbatim reproduction is memory, not skill. Flag rates are
reported per model. The cutoff registry ships with defaults, is overridable in
config, and every report prints the version it used.

**What the cutoff split actually means depends on your repo's history, and
Guignet frames it accordingly** (`repoVisibility` in config):

- **Public / mixed history:** the pre-cutoff column carries real memorization
  risk; the **post-cutoff column is the clean measure of skill**, and pre-cutoff
  is de-emphasized.
- **Private history:** the model never saw your code, so the same split is *not*
  a contamination correction — it measures **knowledge freshness**. A lower
  post-cutoff score may mean the model lacks ecosystem changes (a new library,
  API, or language version) after its cutoff, not that pre-cutoff was inflated.
  Neither column is called "clean."
- **Unknown (default):** presented as a neutral recency split, with no
  contamination claim in either direction.

In all cases, post-cutoff tasks are also simply *more recent commits*, which can
differ in difficulty for reasons unrelated to the model. So the split is a flag
to investigate, **suggestive, not dispositive**.

## 6. Known limitations

- **Task quality is the whole game.** Terse commit messages produce weak
  prompts; the soundness rate is the honest measure of how well mining worked on
  a given repo. Publish it; don't average it away.
- **The suite is small.** A repo yields tens to low-hundreds of sound tasks, so
  confidence intervals are wide. That's why they're always shown.
- **Pattern resemblance is unmeasured.** Even on a private repo, a task may
  resemble ubiquitous public code the model has seen many times. That is a real
  form of "not novel" that the cutoff split does not capture.
- **Environment fidelity.** A task only admits if its verifier reproduces in a
  hermetic worktree. Tasks that need services the worktree can't provide are
  discarded — conservative, but it caps yield on integration-heavy suites.
- **Dependency isolation** currently preserves `node_modules` between replays;
  other ecosystems' in-tree dependency directories are a known gap.

## 7. Reproducibility

The filesystem is the database. Every stage writes to `.guignet/` and is
idempotent and resumable — a run interrupted at attempt 23 resumes at 23. The
report is pure: `guignet report` regenerates from stored runs with no
re-execution, and emits a `--json` twin of every number in the HTML, so results
are auditable and programmatically consumable. Nothing here requires trusting
Guignet's word over your own inspection of the store.
