/**
 * The model training-cutoff registry (ARCHITECTURE.md §7 — the credibility
 * moat). A model may have trained on your public history, which inflates
 * pre-cutoff scores; splitting every score by the model's cutoff makes the
 * post-cutoff (clean) number the headline. The registry ships illustrative
 * defaults (cutoffs.json), is user-overridable in config.json, and every report
 * prints the version it used — so the exact dates behind a split are never
 * hidden.
 */
import registry from "./cutoffs.json";
import type { CutoffEra } from "./schema.ts";

export interface CutoffRegistry {
  version: string;
  cutoffs: Record<string, string>;
}

/** The shipped registry, with any per-model overrides from config layered on top.
 * An override bumps the effective version so the report shows it was customized. */
export function loadCutoffRegistry(overrides?: Record<string, string>): CutoffRegistry {
  const base = registry as { version: string; cutoffs: Record<string, string> };
  if (!overrides || Object.keys(overrides).length === 0) {
    return { version: base.version, cutoffs: { ...base.cutoffs } };
  }
  return { version: `${base.version}+overrides`, cutoffs: { ...base.cutoffs, ...overrides } };
}

/** The cutoff date (ISO) for a model id, or null if it isn't in the registry. */
export function resolveCutoff(model: string | undefined, reg: CutoffRegistry): string | null {
  if (!model) return null;
  return reg.cutoffs[model] ?? null;
}

/**
 * Classify a task's date against a model cutoff. A task dated on/before the
 * cutoff is PRE (the model may have seen it); strictly after is POST (clean).
 * Unknown when there's no cutoff for the model. Compares ISO dates lexically —
 * valid because both are `YYYY-MM-DD…Z` and sort chronologically.
 */
export function classifyEra(taskDateIso: string, cutoffIso: string | null): CutoffEra {
  if (!cutoffIso) return "unknown";
  return taskDateIso.slice(0, 10) <= cutoffIso.slice(0, 10) ? "pre" : "post";
}
