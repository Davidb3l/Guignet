#!/usr/bin/env bun
/**
 * Import-boundary check (ARCHITECTURE.md §4, CLAUDE.md hard invariant). A cheap
 * static analysis that makes the module architecture — and the leak firewall —
 * non-optional. Run in CI (`bun run check:boundaries`) and locally via `check`.
 *
 * Rules enforced:
 *   1. `core/` imports nothing internal outside `core/` — core is the leaf
 *      every stage may depend on; it depends on no stage.
 *   2. Stages (`mine|gate|run|score|report`) never import each other. Cross-
 *      stage data flows through the store (§2). `cli/` is the composition root
 *      and MAY import stages; stages MUST NOT import `cli/`.
 *   3. The leak firewall (§5): `core/truth.ts` is importable ONLY by `mine/`,
 *      `gate/`, and `score/`. `run/`, `report/`, `cli/`, `bin/`, and other
 *      `core/` files MUST NOT import it. Finer still: `writeTruth` only in
 *      `mine/`; `readTruth` only in `gate/` and `score/`; and truth must be
 *      imported BY NAME (no `import *` / `export *`) so that split stays
 *      checkable. Import extraction covers static imports, `export … from`
 *      re-exports (a laundering route), and dynamic `import()` — quotes or
 *      backticks.
 *   3b. The second door: ground truth lives at `<taskDir>/truth/…`, so a stage
 *      could skip `core/truth.ts` and read it with raw `fs` off a `taskDir`
 *      path. Only `core/truth.ts` may name the `truth` path segment in a string
 *      literal; anywhere else is flagged. A leaked ground truth silently
 *      invalidates every downstream score — this is the one place the spec says
 *      paranoia IS the design.
 *
 * Extraction is regex-based — sufficient for this hand-written codebase. If it
 * ever needs to understand deeper re-export gymnastics (aliased star chains,
 * computed specifiers), promote it to the TS compiler API; today it does not.
 */
import { fileURLToPath } from "node:url";

const DEFAULT_SRC = fileURLToPath(new URL("../src/", import.meta.url));

type Area = "core" | "cli" | "bin" | "mine" | "gate" | "run" | "score" | "report" | "other";
const STAGES = new Set(["mine", "gate", "run", "score", "report"]);

interface ImportRef {
  /** Imported names (`{ a, b }`, default). Empty for side-effect/namespace imports. */
  names: string[];
  /** The raw module specifier. */
  source: string;
  /** True for `import * as x` / `export * from` — a whole-module binding whose
   * individual names can't be checked, so truth access via it is forbidden. */
  namespace: boolean;
}

export interface Violation {
  file: string;
  rule: string;
}

/** Which top-level src area a file belongs to (relative to `src`). */
function areaOf(absPath: string, src: string): Area {
  const rel = absPath.slice(src.length);
  const top = rel.split("/")[0] ?? "";
  if (top === "core" || top === "cli" || top === "bin") return top;
  if (STAGES.has(top)) return top as Area;
  return "other";
}

/** Parse the import/re-export specifiers and source strings out of a file's text. */
function parseImports(text: string): ImportRef[] {
  const refs: ImportRef[] = [];
  // Static: `import ... from "src"` and `import "src"` (side-effect).
  const staticRe = /import\s+(?:(type\s+)?([\s\S]*?)\s+from\s*)?["']([^"']+)["']/g;
  for (let m = staticRe.exec(text); m; m = staticRe.exec(text)) {
    const clause = m[2] ?? "";
    refs.push({ names: extractNames(clause), source: m[3]!, namespace: /\*\s+as\s+|^\s*\*\s*$/.test(clause) });
  }
  // Re-export: `export { a } from "src"`, `export * from "src"`, `export * as ns from "src"`.
  // A re-export is a dependency AND a laundering route for truth access — check it too.
  const exportRe = /export\s+(?:type\s+)?(\*(?:\s+as\s+\w+)?|\{[\s\S]*?\})\s+from\s*["']([^"']+)["']/g;
  for (let m = exportRe.exec(text); m; m = exportRe.exec(text)) {
    const clause = m[1]!;
    refs.push({ names: extractNames(clause), source: m[2]!, namespace: clause.trimStart().startsWith("*") });
  }
  // Dynamic: `import("src")` / `import(`src`)` (quotes or backticks, no interpolation).
  const dynRe = /import\(\s*[`"']([^`"']+)[`"']\s*\)/g;
  for (let m = dynRe.exec(text); m; m = dynRe.exec(text)) {
    refs.push({ names: [], source: m[1]!, namespace: false });
  }
  return refs;
}

/** Pull identifier names out of an import clause (best-effort, names only). */
function extractNames(clause: string): string[] {
  const names: string[] = [];
  const braced = clause.match(/\{([\s\S]*?)\}/);
  if (braced) {
    for (const part of braced[1]!.split(",")) {
      const id = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim();
      if (id) names.push(id);
    }
  }
  // Default / namespace bindings (the bit before any `{`).
  const head = clause.split("{")[0]!.replace(/,\s*$/, "").trim();
  if (head && head !== "type") {
    const id = head.replace(/^type\s+/, "").replace(/^\*\s+as\s+/, "").trim();
    if (id && !id.includes("{")) names.push(id);
  }
  return names;
}

/** Resolve a relative import to an absolute path; null for bare/external specifiers. */
function resolveSource(fromFile: string, source: string): string | null {
  if (!source.startsWith(".")) return null;
  const fromDir = fromFile.slice(0, fromFile.lastIndexOf("/"));
  const parts = (fromDir + "/" + source).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return "/" + out.join("/");
}

function isTruthModule(absTarget: string, src: string): boolean {
  return absTarget === src + "core/truth.ts" || absTarget === src + "core/truth";
}

/**
 * Strip line and block comments so a comment mentioning `truth` (this codebase
 * is full of them — the firewall is heavily documented) can't trip the
 * path-literal scan. Not string-aware, which is fine here: a real leak is
 * executable code, never a comment, so removing comment text can only drop
 * false positives, never a genuine violation.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/**
 * Does the CODE (comments stripped) name the `truth` path segment inside a
 * string/template literal? Matches a bare `"truth"`/`'truth'`/`` `truth` ``
 * join segment or a quoted path containing `truth/` or `/truth`. Scoped to
 * quoted literals so only code that could open the directory trips it.
 */
function mentionsTruthPath(text: string): boolean {
  const code = stripComments(text).replace(/\n/g, " ");
  return /["'`]truth["'`]/.test(code) || /["'`][^"'`]*(?:^|\/)truth(?:\/[^"'`]*)?["'`]/.test(code);
}

/**
 * Scan a `src/` tree and return every boundary violation. Exported so tests can
 * point it at a synthetic tree and prove the firewall actually catches leaks —
 * not merely that the real tree happens to be clean today.
 */
export async function scanTree(src: string): Promise<Violation[]> {
  const glob = new Bun.Glob("**/*.ts");
  const violations: Violation[] = [];

  for await (const rel of glob.scan({ cwd: src })) {
    const abs = src + rel;
    const area = areaOf(abs, src);
    const text = await Bun.file(abs).text();

    for (const ref of parseImports(text)) {
      const target = resolveSource(abs, ref.source);
      if (!target) continue; // external/bare import — nothing to enforce
      const targetArea = areaOf(target, src);

      // Rule 1: core imports nothing internal outside core.
      if (area === "core" && targetArea !== "core") {
        violations.push({ file: rel, rule: `core/ imports ${targetArea}/ (${ref.source})` });
      }

      // Rule 2: stages never import each other; stages never import cli.
      if (STAGES.has(area)) {
        if (STAGES.has(targetArea) && targetArea !== area) {
          violations.push({ file: rel, rule: `stage ${area}/ imports sibling stage ${targetArea}/ (${ref.source})` });
        }
        if (targetArea === "cli") {
          violations.push({ file: rel, rule: `stage ${area}/ imports cli/ (${ref.source})` });
        }
      }

      // Rule 3: the leak firewall (module-level access to core/truth.ts).
      if (isTruthModule(target, src)) {
        const allowed = new Set(["mine", "gate", "score"]);
        if (!allowed.has(area)) {
          violations.push({ file: rel, rule: `${area}/ imports core/truth.ts — only mine/gate/score may (§5)` });
        }
        // A namespace/star binding hides which of read/writeTruth is used, so the
        // finer split below can't be checked — require named imports of truth.
        if (ref.namespace) {
          violations.push({ file: rel, rule: `${rel} imports core/truth.ts as a namespace — import readTruth/writeTruth by name so the split is checkable (§5)` });
        }
        if (ref.names.includes("readTruth") && area !== "gate" && area !== "score") {
          violations.push({ file: rel, rule: `${area}/ imports readTruth — only gate/score may (§5)` });
        }
        if (ref.names.includes("writeTruth") && area !== "mine") {
          violations.push({ file: rel, rule: `${area}/ imports writeTruth — only mine may (§5)` });
        }
      }
    }

    // Rule 3b: the firewall's second door. Ground truth lives at
    // `<taskDir>/truth/...`, so a stage could bypass core/truth.ts entirely by
    // joining that path itself and reading it with raw fs. The ONLY file that
    // may name the `truth` path segment is core/truth.ts; anywhere else — most
    // dangerously run/ and report/ — naming it in a string literal is a leak
    // route, flagged regardless of how the bytes are then read.
    if (abs !== src + "core/truth.ts" && mentionsTruthPath(text)) {
      violations.push({ file: rel, rule: `${rel} references a "truth" path segment — only core/truth.ts may name the truth dir (§5)` });
    }
  }

  return violations;
}

async function main(): Promise<number> {
  const violations = await scanTree(DEFAULT_SRC);
  if (violations.length > 0) {
    process.stderr.write("Import-boundary check FAILED:\n");
    for (const v of violations) process.stderr.write(`  ${v.file}: ${v.rule}\n`);
    return 1;
  }
  process.stdout.write("Import-boundary check OK\n");
  return 0;
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}
