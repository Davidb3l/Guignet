/**
 * The report template (ARCHITECTURE.md §8 — "the referee wears viridian"). A
 * single self-contained HTML string: inline CSS + inline SVG charts, NO
 * webfonts, NO CDN, NO framework — it must render offline inside an enterprise
 * network (the local-first wedge showing up in the artifact itself). Dark-first
 * with a print stylesheet for exec decks. Pure over the ReportModel: every
 * number here is already computed in aggregate.ts, so the `--json` twin and this
 * page can never disagree.
 *
 * Aesthetic: a lab instrument's output. Near-black ground with a green cast,
 * viridian chrome, serif letterhead gravitas for headings, ui-monospace tabular
 * numerals for every figure/SHA/dollar. Calm, precise, expensive.
 */
import type { ConfigReport, Interval, ReportModel, SubsetReport } from "./model.ts";

// --- escaping + formatting -------------------------------------------------

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
function pct(x: number | null): string {
  return x === null ? "—" : `${(x * 100).toFixed(1)}%`;
}
function money(x: number | null): string {
  if (x === null) return "—";
  return x < 1 ? `$${x.toFixed(4)}` : `$${x.toFixed(2)}`;
}
function grp(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function dur(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
function ratio(x: number | null): string {
  return x === null ? "—" : `${x.toFixed(2)}×`;
}

// --- inline SVG charts -----------------------------------------------------

/** A solve-rate bar with a Wilson CI whisker overlaid. 0..1 mapped across W. */
function whisker(rate: number, ci: Interval): string {
  const W = 176;
  const H = 22;
  const y = H / 2;
  const x = rate * W;
  const lo = ci.low * W;
  const hi = ci.high * W;
  return `<svg class="whisker" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="solve rate ${pct(rate)}, 95% CI ${pct(ci.low)}–${pct(ci.high)}">
    <line x1="0" y1="${y}" x2="${W}" y2="${y}" class="wk-track"/>
    <rect x="0" y="${y - 3}" width="${x.toFixed(1)}" height="6" class="wk-fill"/>
    <line x1="${lo.toFixed(1)}" y1="${y}" x2="${hi.toFixed(1)}" y2="${y}" class="wk-ci"/>
    <line x1="${lo.toFixed(1)}" y1="${y - 4}" x2="${lo.toFixed(1)}" y2="${y + 4}" class="wk-ci"/>
    <line x1="${hi.toFixed(1)}" y1="${y - 4}" x2="${hi.toFixed(1)}" y2="${y + 4}" class="wk-ci"/>
    <circle cx="${x.toFixed(1)}" cy="${y}" r="3.5" class="wk-dot"/>
  </svg>`;
}

/** Interpolate the heatmap cell colour from surface → emerald by solve rate. */
function heatColor(rate: number): string {
  const from = [16, 32, 26]; // --g-surface #10201A
  const to = [80, 200, 120]; // --g-pass    #50C878
  const mix = from.map((f, i) => Math.round(f + (to[i]! - f) * rate));
  return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
}

// --- sections --------------------------------------------------------------

function headlineStrip(configs: ConfigReport[]): string {
  const top = configs[0];
  if (!top) {
    return `<section class="headline reveal"><div class="hl-label">$ per solved task</div><div class="hl-number">—</div><div class="hl-sub">no scored runs yet — run mine → gate → run → score</div></section>`;
  }
  const partial = top.dollarsCoverage.known < top.dollarsCoverage.total;
  const prefix = partial && top.dollarsPerSolvedTask !== null ? "≥" : "";
  return `<section class="headline reveal">
    <div class="hl-label">$ per solved task · headline config</div>
    <div class="hl-number">${prefix}${esc(money(top.dollarsPerSolvedTask))}</div>
    <div class="hl-sub"><span class="mono">${esc(top.label)}</span> — solved <span class="mono">${top.tasksSolved}</span> of <span class="mono">${top.tasksTotal}</span> tasks${partial ? ` <span class="hl-partial">lower bound · ${top.dollarsCoverage.known}/${top.dollarsCoverage.total} attempts priced</span>` : ""}${top.watermarked ? ` <span class="watermark">n=1 · anecdote, not measurement</span>` : ""}</div>
  </section>`;
}

function leaderboard(configs: ConfigReport[]): string {
  if (configs.length === 0) return "";
  const rows = configs
    .map((c) => {
      // The board is SORTED by post-cutoff rate (the clean headline, §7/§8), so
      // it must DISPLAY that rate — else a row can look mis-sorted. Fall back to
      // overall only when a config has no post-cutoff tasks, and say so.
      const usePost = c.split.post.solveRate !== null && c.split.post.ci !== null;
      const rate = usePost ? c.split.post.solveRate! : c.solveRate;
      const ci = usePost ? c.split.post.ci! : c.ci;
      const n = usePost ? c.split.post.tasksTotal : c.tasksTotal;
      const rateNote = usePost
        ? `95% CI ${esc(pct(ci.low))}–${esc(pct(ci.high))} · n=${n}`
        : `95% CI ${esc(pct(ci.low))}–${esc(pct(ci.high))} · n=${n} · overall (no post-cutoff tasks)`;
      // Partial-cost coverage ⇒ the $/solved is a lower bound; mark it honestly.
      const dc = c.dollarsCoverage;
      const costPartial = dc.known < dc.total;
      const cost = `${costPartial && c.dollarsPerSolvedTask !== null ? "≥" : ""}${esc(money(c.dollarsPerSolvedTask))}`;
      const costNote = costPartial ? `<div class="ci-note mono">${dc.known}/${dc.total} attempts priced</div>` : "";
      const tc = c.tokensCoverage;
      const tok = c.tokens ? `${grp(c.tokens.output)}${tc.known < tc.total ? "*" : ""}` : "—";
      return `<tr>
        <td class="lb-config"><span class="mono">${esc(c.label)}</span>${c.watermarked ? ` <span class="watermark sm">n=1</span>` : ""}</td>
        <td class="num">${c.nAttempts}</td>
        <td class="lb-rate"><div class="rate-cell"><span class="mono rate-num">${esc(pct(rate))}</span>${whisker(rate, ci)}</div><div class="ci-note mono">${rateNote}</div></td>
        <td class="num money">${cost}${costNote}</td>
        <td class="num">${tok}</td>
        <td class="num">${esc(dur(c.medianWallclockMs))}</td>
        <td class="num">${esc(ratio(c.medianBloatRatio))}</td>
      </tr>`;
    })
    .join("");
  return `<section class="reveal">
    <h2>Leaderboard <span class="th-note">solve rate shown is post-cutoff · CI always shown</span></h2>
    <div class="scroll"><table class="lb">
      <thead><tr><th>Config</th><th class="num">n</th><th>Post-cutoff solve rate <span class="th-note">(95% CI)</span></th><th class="num">$/solved</th><th class="num">Output tok</th><th class="num">Median wall</th><th class="num">Bloat</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="note sm">$/solved uses cost parsed from each harness's own transcript (never self-reported). <span class="mono">*</span>/<span class="mono">≥</span> mark configs where some attempts had no priceable transcript, so the figure is a lower bound.</p>
  </section>`;
}

/**
 * How the cutoff split is framed depends on the repo's public/private history
 * (§7). Same underlying number, different meaning — so different copy. Getting
 * this right is the whole point: calling a private repo's pre-cutoff column
 * "possibly seen" would be a contamination overclaim (the model never saw it).
 */
interface SplitFraming {
  title: string;
  note: string;
  postTag: string;
  preTag: string;
  /** Only gray the pre column when it genuinely carries contamination suspicion. */
  grayPre: boolean;
}
function splitFraming(v: ReportModel["repoVisibility"]): SplitFraming {
  const caveat = "Post-cutoff tasks are also simply more recent commits, so this split is suggestive, not dispositive.";
  switch (v) {
    case "public":
      return {
        title: "Contamination split",
        note: `The model may have trained on this repo's public history. The <strong>post-cutoff</strong> column is the honest measure of skill; pre-cutoff is grayed because the model may have seen those fixes. ${caveat}`,
        postTag: `<span class="split-tag">clean</span>`,
        preTag: `<span class="split-tag muted">possibly seen</span>`,
        grayPre: true,
      };
    case "mixed":
      return {
        title: "Contamination split · mixed history",
        note: `Some of this repo's history was public, so pre-cutoff tasks carry contamination risk for the public era. A fully clean read would need private-era selection (not in v0). ${caveat}`,
        postTag: `<span class="split-tag">clean</span>`,
        preTag: `<span class="split-tag muted">possibly seen</span>`,
        grayPre: true,
      };
    case "private":
      return {
        title: "Cutoff split · knowledge freshness",
        note: `This repo is private, so memorization-contamination risk is low — the model never saw these commits. Instead the split shows knowledge freshness: post-cutoff tasks may lean on ecosystem changes (a new library, API, or language version) the model doesn't know, so a lower post-cutoff score reflects staleness, not contamination. Neither column is "clean." ${caveat}`,
        postTag: `<span class="split-tag muted">newer than model</span>`,
        preTag: `<span class="split-tag muted">within model era</span>`,
        grayPre: false,
      };
    default: // unknown
      return {
        title: "Cutoff split · informational",
        note: `Set <span class="mono">repoVisibility</span> ("public" | "private" | "mixed") in <span class="mono">.guignet/config.json</span> for a contamination-vs-freshness read. As shown this is a plain recency split — no contamination claim either way. ${caveat}`,
        postTag: "",
        preTag: "",
        grayPre: false,
      };
  }
}

function subsetCell(s: SubsetReport, primary: boolean, f: SplitFraming): string {
  const cls = primary ? "split-post" : f.grayPre ? "split-pre split-pre-gray" : "split-pre";
  const rate = s.solveRate === null
    ? `<span class="split-num">—</span>`
    : `<span class="split-num mono">${esc(pct(s.solveRate))}</span>`;
  const ci = s.ci ? `<div class="ci-note mono">CI ${esc(pct(s.ci.low))}–${esc(pct(s.ci.high))}</div>` : "";
  return `<div class="split-box ${cls}">
    <div class="split-head">${primary ? "post-cutoff" : "pre-cutoff"}${primary ? ` ${f.postTag}` : ` ${f.preTag}`}</div>
    ${rate}
    <div class="split-meta mono">${s.tasksSolved}/${s.tasksTotal} tasks</div>
    ${ci}
  </div>`;
}

function cutoffSplit(model: ReportModel): string {
  const scored = model.configs.filter((c) => c.cutoffDate !== null);
  if (scored.length === 0) {
    return `<section class="reveal"><h2>Cutoff split</h2><p class="note">No config's model was found in the cutoff registry, so no pre/post split can be drawn. Add cutoffs in <span class="mono">.guignet/config.json</span>.</p></section>`;
  }
  const f = splitFraming(model.repoVisibility);
  const blocks = scored
    .map(
      (c) => `<div class="split-row">
      <div class="split-label"><span class="mono">${esc(c.label)}</span>${c.watermarked ? ` <span class="watermark sm">n=1</span>` : ""}<div class="ci-note mono">cutoff ${esc(c.cutoffDate!)}</div></div>
      <div class="split-pair">${subsetCell(c.split.post, true, f)}${subsetCell(c.split.pre, false, f)}</div>
    </div>`,
    )
    .join("");
  return `<section class="reveal">
    <h2>${esc(f.title)} <span class="th-note">repo: ${esc(model.repoVisibility)}</span></h2>
    <p class="note">${f.note}</p>
    <div class="splits">${blocks}</div>
  </section>`;
}

function taxonomy(tax: ReportModel["taxonomy"]): string {
  if (tax.cells.length === 0 || tax.kinds.length === 0) return "";
  const lookup = new Map(tax.cells.map((c) => [`${c.kind}|${c.area}`, c]));
  const head = `<tr><th class="hm-corner">${esc(tax.forLabel ?? "")}</th>${tax.areas.map((a) => `<th class="hm-col">${esc(a)}</th>`).join("")}</tr>`;
  const body = tax.kinds
    .map((kind) => {
      const cells = tax.areas
        .map((area) => {
          const c = lookup.get(`${kind}|${area}`);
          if (!c) return `<td class="hm-cell hm-empty">·</td>`;
          return `<td class="hm-cell" style="background:${heatColor(c.solveRate)}" title="${esc(kind)} · ${esc(area)}: ${esc(pct(c.solveRate))} (${c.tasksSolved}/${c.tasksTotal})"><span class="hm-val mono">${esc(pct(c.solveRate))}</span><span class="hm-n mono">${c.tasksSolved}/${c.tasksTotal}</span></td>`;
        })
        .join("");
      return `<tr><th class="hm-row">${esc(kind)}</th>${cells}</tr>`;
    })
    .join("");
  const omitted = tax.areasOmitted > 0
    ? `<p class="note sm">Showing the ${tax.areas.length} busiest areas; ${tax.areasOmitted} rarer area${tax.areasOmitted === 1 ? "" : "s"} omitted for readability (still counted in the leaderboard totals).</p>`
    : "";
  return `<section class="reveal">
    <h2>Taxonomy heatmap <span class="th-note">solve rate by kind × area</span></h2>
    <div class="scroll"><table class="hm"><thead>${head}</thead><tbody>${body}</tbody></table></div>
    ${omitted}
  </section>`;
}

function flagsAndSoundness(model: ReportModel): string {
  // No suite ⇒ soundness is UNKNOWN, not 0% — show a dash, not a false 0.
  const hasSuite = model.suite.candidates > 0;
  const soundness = `<div class="tile">
    <div class="tile-label">suite soundness</div>
    <div class="tile-num mono">${hasSuite ? esc(pct(model.suite.soundnessRate)) : "—"}</div>
    <div class="tile-sub mono">${hasSuite ? `${model.suite.admitted}/${model.suite.candidates} candidates admitted` : "no suite on disk"}</div>
  </div>`;
  const flags = model.configs
    .filter((c) => c.flagRate !== null)
    .map(
      (c) => `<div class="tile">
      <div class="tile-label">regurgitation · <span class="mono">${esc(c.model)}</span></div>
      <div class="tile-num mono ${c.flagRate! > 0 ? "flag" : ""}">${esc(pct(c.flagRate))}</div>
      <div class="tile-sub mono">${c.flaggedCount}/${c.preCutoffAttempts} pre-cutoff attempts flagged</div>
    </div>`,
    )
    .join("");
  return `<section class="reveal">
    <h2>Integrity</h2>
    <div class="tiles">${soundness}${flags}</div>
  </section>`;
}

function methodology(model: ReportModel): string {
  const m = model.methodology;
  return `<footer class="reveal">
    <h2>Methodology</h2>
    <dl class="method">
      <div><dt>Suite</dt><dd class="mono">${model.suite.admitted} admitted / ${model.suite.candidates} candidates · mined ${esc(model.suite.minedAt.slice(0, 10) || "—")}</dd></div>
      <div><dt>Gate replays (k)</dt><dd class="mono">${m.gateReplays}× fail-at-base, ${m.gateReplays}× pass-at-fix</dd></div>
      <div><dt>Cutoff registry</dt><dd class="mono">${esc(m.cutoffRegistryVersion)}</dd></div>
      <div><dt>Adapters</dt><dd class="mono">${esc(m.adapters.join(", ") || "—")}</dd></div>
      <div><dt>Runs · attempts</dt><dd class="mono">${m.totalRuns} runs · ${grp(m.totalAttempts)} attempts</dd></div>
      <div><dt>Generated</dt><dd class="mono">${esc(model.generatedAt)}</dd></div>
    </dl>
    <div class="colophon">Guignet — the green that proved itself. <span class="colophon-sub">Named for Charles-Émile Guignet, whose 1859 process made viridian producible.</span></div>
  </footer>`;
}

// --- document --------------------------------------------------------------

export function renderReportHtml(model: ReportModel): string {
  const body = [
    `<header class="masthead reveal">
      <div class="brand">GUIGNET</div>
      <h1>The Referee's Report</h1>
      <div class="sub mono">${esc(model.repoName)} · benchmarked on your own code</div>
    </header>`,
    headlineStrip(model.configs),
    leaderboard(model.configs),
    cutoffSplit(model),
    taxonomy(model.taxonomy),
    flagsAndSoundness(model),
    methodology(model),
  ].join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Guignet — ${esc(model.repoName)}</title>
<style>${STYLE}</style>
</head>
<body>
<main class="page">
${body}
</main>
</body>
</html>`;
}

// All CSS inline (self-contained, offline). Design tokens per §8.
const STYLE = `
:root{
  --g-bg:#0B1512; --g-surface:#10201A; --g-line:#1E3A30;
  --g-viridian:#40826D; --g-viridian-deep:#1E4D3D;
  --g-ink:#E9F2ED; --g-ink-muted:#9DB8AD;
  --g-pass:#50C878; --g-fail:#D96A5B; --g-flag:#D9A441;
  --serif:Georgia,'Times New Roman',serif;
  --sans:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Helvetica,sans-serif;
  --mono:ui-monospace,'SF Mono','Cascadia Code','Roboto Mono',Menlo,monospace;
}
*{box-sizing:border-box}
html,body{margin:0}
body{
  background:
    radial-gradient(1100px 620px at 12% -6%, rgba(64,130,109,.16), transparent 60%),
    radial-gradient(900px 520px at 108% 4%, rgba(30,77,61,.20), transparent 55%),
    var(--g-bg);
  background-attachment:fixed;
  color:var(--g-ink); font-family:var(--sans); line-height:1.55;
  -webkit-font-smoothing:antialiased;
}
.page{max-width:1000px; margin:0 auto; padding:56px 32px 96px}
.mono{font-family:var(--mono); font-variant-numeric:tabular-nums}
h1,h2{font-family:var(--serif); font-weight:600; letter-spacing:.2px}
h2{font-size:20px; margin:0 0 6px; color:var(--g-ink);
   padding-bottom:8px; border-bottom:1px solid var(--g-line)}
section,footer{margin-top:56px}
.th-note{font-family:var(--sans); font-weight:400; font-size:12px; color:var(--g-ink-muted); letter-spacing:.3px; margin-left:8px}
.note{color:var(--g-ink-muted); font-size:14px; max-width:66ch; margin:12px 0 20px}
.note.sm{font-size:12px; margin:12px 0 0}

/* staggered reveal on load — content is VISIBLE by default and only hidden to be
   animated in when motion is welcome, so a renderer that drops CSS animations
   (or reduced-motion) always shows a filled page, never a blank one. */
@media (prefers-reduced-motion:no-preference){
  .reveal{opacity:0; transform:translateY(10px); animation:rise .7s cubic-bezier(.2,.7,.2,1) forwards}
  .reveal:nth-child(1){animation-delay:.02s}.reveal:nth-child(2){animation-delay:.10s}
  .reveal:nth-child(3){animation-delay:.18s}.reveal:nth-child(4){animation-delay:.26s}
  .reveal:nth-child(5){animation-delay:.34s}.reveal:nth-child(6){animation-delay:.42s}
  .reveal:nth-child(7){animation-delay:.50s}
}
@keyframes rise{to{opacity:1; transform:none}}
.hl-partial{display:inline-block; margin-left:8px; padding:2px 8px; border:1px solid var(--g-ink-muted);
  color:var(--g-ink-muted); border-radius:999px; font-size:11px; font-family:var(--mono)}

/* masthead */
.masthead{margin-top:0; border-bottom:1px solid var(--g-line); padding-bottom:24px}
.brand{font-family:var(--mono); font-size:12px; letter-spacing:.42em; color:var(--g-viridian); margin-bottom:14px}
.masthead h1{font-size:40px; margin:0; line-height:1.1}
.masthead .sub{color:var(--g-ink-muted); font-size:13px; margin-top:10px; letter-spacing:.2px}

/* headline strip — the executive number, largest thing on the page */
.headline{margin-top:40px; padding:34px 36px; border:1px solid var(--g-line);
  border-radius:10px; background:linear-gradient(180deg, rgba(30,77,61,.22), rgba(16,32,26,.5));
  position:relative; overflow:hidden}
.headline:before{content:""; position:absolute; inset:0;
  background:radial-gradient(420px 200px at 88% 120%, rgba(80,200,120,.10), transparent 70%)}
.hl-label{font-family:var(--mono); font-size:11px; letter-spacing:.26em; text-transform:uppercase; color:var(--g-ink-muted)}
.hl-number{font-family:var(--mono); font-variant-numeric:tabular-nums; font-size:76px; line-height:1;
  font-weight:600; color:var(--g-pass); margin:12px 0 10px; text-shadow:0 0 40px rgba(80,200,120,.18)}
.hl-sub{color:var(--g-ink-muted); font-size:14px}
.watermark{display:inline-block; margin-left:8px; padding:2px 8px; border:1px solid var(--g-flag);
  color:var(--g-flag); border-radius:999px; font-size:11px; font-family:var(--mono); letter-spacing:.04em}
.watermark.sm{font-size:10px; padding:1px 6px; margin-left:4px}

/* tables */
.scroll{overflow-x:auto}
table{border-collapse:collapse; width:100%; font-size:14px}
thead th{font-family:var(--mono); font-size:11px; text-transform:uppercase; letter-spacing:.12em;
  color:var(--g-ink-muted); text-align:left; font-weight:400; padding:0 14px 10px; border-bottom:1px solid var(--g-line); white-space:nowrap}
tbody td{padding:14px; border-bottom:1px solid rgba(30,58,48,.5); vertical-align:top}
.num{text-align:right; font-family:var(--mono); font-variant-numeric:tabular-nums; white-space:nowrap}
th.num{text-align:right}
.money{color:var(--g-ink)}
tbody tr:hover{background:rgba(64,130,109,.06)}
.lb-config .mono{font-size:13px}
.rate-cell{display:flex; align-items:center; gap:12px}
.rate-num{font-size:15px; min-width:52px; color:var(--g-pass)}
.ci-note{font-size:11px; color:var(--g-ink-muted); margin-top:5px}
.whisker .wk-track{stroke:var(--g-line); stroke-width:1}
.whisker .wk-fill{fill:var(--g-viridian)}
.whisker .wk-ci{stroke:var(--g-ink-muted); stroke-width:1.4}
.whisker .wk-dot{fill:var(--g-pass); stroke:var(--g-bg); stroke-width:1}

/* cutoff split */
.splits{display:flex; flex-direction:column; gap:14px}
.split-row{display:grid; grid-template-columns:220px 1fr; gap:20px; align-items:center;
  padding:16px; border:1px solid var(--g-line); border-radius:10px; background:rgba(16,32,26,.4)}
.split-label .mono{font-size:13px}
.split-pair{display:grid; grid-template-columns:1fr 1fr; gap:14px}
.split-box{padding:14px 16px; border-radius:8px}
.split-post{background:linear-gradient(180deg, rgba(80,200,120,.14), rgba(30,77,61,.12)); border:1px solid var(--g-viridian)}
.split-pre{background:rgba(20,28,25,.5); border:1px solid var(--g-line)}
.split-pre-gray{filter:grayscale(1) opacity(.72)}
.split-head{font-family:var(--mono); font-size:11px; text-transform:uppercase; letter-spacing:.14em; color:var(--g-ink-muted)}
.split-tag{font-size:9px; padding:1px 6px; border-radius:999px; border:1px solid var(--g-pass); color:var(--g-pass); letter-spacing:.06em}
.split-tag.muted{border-color:var(--g-ink-muted); color:var(--g-ink-muted)}
.split-num{display:block; font-size:34px; font-weight:600; margin:8px 0 4px; color:var(--g-ink)}
.split-post .split-num{color:var(--g-pass)}
.split-meta{font-size:12px; color:var(--g-ink-muted)}

/* heatmap */
.hm{border-collapse:separate; border-spacing:4px}
.hm th{font-family:var(--mono); font-size:11px; color:var(--g-ink-muted); font-weight:400; text-transform:none; border:0; letter-spacing:.02em}
.hm-corner{text-align:left; color:var(--g-viridian)!important}
.hm-col{text-align:center; padding:4px 8px}
.hm-row{text-align:right; padding-right:10px; white-space:nowrap}
.hm-cell{width:78px; height:52px; text-align:center; border-radius:6px; padding:0; vertical-align:middle}
.hm-cell .hm-val{display:block; font-size:13px; color:#07130E; font-weight:600}
.hm-cell .hm-n{display:block; font-size:10px; color:rgba(7,19,14,.62)}
.hm-empty{background:rgba(16,32,26,.5); color:var(--g-line)}

/* integrity tiles */
.tiles{display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:14px}
.tile{padding:20px; border:1px solid var(--g-line); border-radius:10px; background:rgba(16,32,26,.4)}
.tile-label{font-family:var(--mono); font-size:11px; text-transform:uppercase; letter-spacing:.12em; color:var(--g-ink-muted)}
.tile-num{font-size:38px; font-weight:600; margin:8px 0 4px; color:var(--g-viridian)}
.tile-num.flag{color:var(--g-flag)}
.tile-sub{font-size:12px; color:var(--g-ink-muted)}

/* methodology */
.method{display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:2px 28px; margin:18px 0 0}
.method div{display:flex; justify-content:space-between; gap:16px; padding:10px 0; border-bottom:1px solid rgba(30,58,48,.5)}
.method dt{color:var(--g-ink-muted); font-size:13px}
.method dd{margin:0; font-size:13px; text-align:right; color:var(--g-ink)}
.colophon{margin-top:28px; font-family:var(--serif); font-style:italic; color:var(--g-viridian); font-size:15px}
.colophon-sub{display:block; font-style:normal; font-family:var(--sans); font-size:12px; color:var(--g-ink-muted); margin-top:4px}

@media (max-width:640px){
  .page{padding:36px 18px 64px}
  .hl-number{font-size:52px}
  .split-row{grid-template-columns:1fr}
  .masthead h1{font-size:30px}
}

/* print — lands in exec decks; invert to paper */
@media print{
  body{background:#fff; color:#10201A}
  .page{max-width:none; padding:0}
  .reveal{opacity:1; transform:none; animation:none}
  .headline{background:#f3f7f4; border-color:#cfe0d7}
  .hl-number,.rate-num,.split-post .split-num,.tile-num{color:#1E4D3D; text-shadow:none}
  h2{border-color:#cfe0d7}
  .split-pre-gray{filter:none; opacity:.6}
  section,footer{break-inside:avoid}
}
`;
