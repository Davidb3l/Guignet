/**
 * File classification for diff-splitting (ARCHITECTURE.md §5). Every changed
 * file in a candidate commit is either a TEST (→ verifier.diff, the held-out
 * check) or SOURCE (→ fix.diff, what the agent must produce) — or neither
 * (docs, lockfiles, images), in which case it's excluded from both. Getting a
 * source file misclassified as a test would leak the fix into the verifier, so
 * the test test is deliberately conservative: a file is a test only if its name
 * or path says so unambiguously.
 *
 * Lives in `core/` (not `mine/`) because BOTH sides of the held-out split need
 * the same rule: `mine/` uses it to divide a commit into fix vs verifier, and
 * `score/` uses it to judge an agent on the same source-side projection the
 * gate validated (score/verdict.ts — the verifier-authoritative overlay). The
 * two stages may not import each other (§4), so the shared classifier lives in
 * the leaf they both may depend on. Pure path logic; no diff content.
 */

/** Extensions we treat as executable source code (a "fix" touches these). */
const CODE_EXT = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs",
  "py", "go", "rs", "java", "rb", "php", "c", "h", "cc", "cpp", "hpp",
  "cs", "swift", "kt", "kts", "scala", "vue", "svelte", "sql", "sh",
]);

/** Directory segments that mark a test tree. */
const TEST_DIRS = new Set(["test", "tests", "__tests__", "__test__", "spec", "specs", "e2e"]);

function ext(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
}

/**
 * Is this a test file? True when the filename carries a `.test.`/`.spec.`
 * infix, or any path segment is a conventional test directory. Both are strong,
 * unambiguous signals — we would rather miss an oddly-named test (the task then
 * has no verifier and is discarded) than misfile a source file as a test.
 */
export function isTestFile(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(base)) return true;
  if (/_test\.(py|go|rb)$/i.test(base)) return true; // foo_test.py, foo_test.go
  if (/^test_.*\.py$/i.test(base)) return true; // test_foo.py (pytest)
  const segments = path.split("/");
  return segments.some((s) => TEST_DIRS.has(s.toLowerCase()));
}

/** Is this an executable source file (not a test)? */
export function isSourceFile(path: string): boolean {
  return !isTestFile(path) && CODE_EXT.has(ext(path));
}

/** Split a set of changed paths into test paths and source paths (others dropped). */
export function classifyPaths(paths: readonly string[]): { testPaths: string[]; sourcePaths: string[] } {
  const testPaths: string[] = [];
  const sourcePaths: string[] = [];
  for (const p of paths) {
    if (isTestFile(p)) testPaths.push(p);
    else if (isSourceFile(p)) sourcePaths.push(p);
  }
  return { testPaths, sourcePaths };
}
