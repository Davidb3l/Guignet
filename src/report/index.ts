/**
 * `report` — regenerate the self-contained HTML report + its `--json` twin from
 * the store (ARCHITECTURE.md §5, §8). PURE: reads stored runs/verdicts, never
 * re-executes anything. The `--json` output IS the ReportModel — every number in
 * the HTML, verbatim — so the report is programmatically consumable and the two
 * can never drift.
 */
import {
  EXIT,
  writeReport,
  type ExitCode,
  type StageRun,
} from "../core/index.ts";
import { aggregate } from "./aggregate.ts";
import { renderReportHtml } from "./template.ts";

/** A filesystem-safe timestamp for the report dir, from an ISO instant. */
function stampFor(iso: string): string {
  return iso.replace(/[:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

export async function runReport(opts: { repoRoot: string; json: boolean }): Promise<StageRun> {
  const { repoRoot, json } = opts;
  const generatedAt = new Date().toISOString();

  let model;
  try {
    model = await aggregate(repoRoot, generatedAt);
  } catch (err) {
    return { stdout: "", stderr: `guignet report: cannot read store: ${(err as Error).message}\n`, code: EXIT.FAILURE };
  }

  const jsonTwin = JSON.stringify(model, null, 2);
  const html = renderReportHtml(model);
  const dir = await writeReport(repoRoot, stampFor(generatedAt), html, jsonTwin);

  // Nothing to show yet is a soft block, not an error — but we still wrote the
  // (empty) report + twin so the paths exist.
  const code: ExitCode = model.configs.length === 0 ? EXIT.SOFT_BLOCKED : EXIT.OK;

  if (json) return { stdout: jsonTwin + "\n", stderr: "", code };
  const note = model.configs.length === 0 ? " (no scored runs yet — run mine → gate → run → score first)" : "";
  return { stdout: `guignet report: wrote ${dir}/guignet-report.html${note}\n`, stderr: "", code };
}
