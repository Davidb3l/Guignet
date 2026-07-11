import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { scanTree } from "../scripts/check-boundaries.ts";

const dirs: string[] = [];
/** Build a synthetic src/ tree from {relpath: contents}; returns its abs path with trailing slash. */
async function tree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "guignet-bound-"));
  dirs.push(root);
  const src = join(root, "src");
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(src, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content, "utf-8");
  }
  return src + "/";
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe("the real source tree", () => {
  test("has no boundary violations", async () => {
    const violations = await scanTree(fileURLToPath(new URL("../src/", import.meta.url)));
    expect(violations).toEqual([]);
  });
});

describe("firewall enforcement (synthetic trees)", () => {
  test("catches run/ importing core/truth.ts", async () => {
    const src = await tree({
      "core/truth.ts": "export function readTruth(){}",
      "run/index.ts": `import { readTruth } from "../core/truth.ts";`,
    });
    const v = await scanTree(src);
    expect(v.some((x) => x.file.startsWith("run/") && x.rule.includes("core/truth"))).toBe(true);
  });

  test("catches report/ importing readTruth", async () => {
    const src = await tree({
      "core/truth.ts": "export function readTruth(){}",
      "report/index.ts": `import { readTruth } from "../core/truth.ts";`,
    });
    const v = await scanTree(src);
    expect(v.some((x) => x.rule.includes("core/truth"))).toBe(true);
  });

  test("permits gate/ and score/ importing readTruth", async () => {
    const src = await tree({
      "core/truth.ts": "export function readTruth(){}",
      "gate/index.ts": `import { readTruth } from "../core/truth.ts";`,
      "score/index.ts": `import { readTruth } from "../core/truth.ts";`,
    });
    expect(await scanTree(src)).toEqual([]);
  });

  test("catches gate/ importing writeTruth (only mine may write)", async () => {
    const src = await tree({
      "core/truth.ts": "export function writeTruth(){}",
      "gate/index.ts": `import { writeTruth } from "../core/truth.ts";`,
    });
    const v = await scanTree(src);
    expect(v.some((x) => x.rule.includes("writeTruth"))).toBe(true);
  });

  test("catches a stage importing a sibling stage", async () => {
    const src = await tree({
      "mine/index.ts": "export const x = 1;",
      "gate/index.ts": `import { x } from "../mine/index.ts";`,
    });
    const v = await scanTree(src);
    expect(v.some((x) => x.rule.includes("sibling stage"))).toBe(true);
  });

  test("catches core/ importing a stage", async () => {
    const src = await tree({
      "mine/index.ts": "export const x = 1;",
      "core/leak.ts": `import { x } from "../mine/index.ts";`,
    });
    const v = await scanTree(src);
    expect(v.some((x) => x.file === "core/leak.ts")).toBe(true);
  });

  test("catches a stage importing cli/", async () => {
    const src = await tree({
      "cli/index.ts": "export const x = 1;",
      "run/index.ts": `import { x } from "../cli/index.ts";`,
    });
    const v = await scanTree(src);
    expect(v.some((x) => x.rule.includes("imports cli/"))).toBe(true);
  });

  test("catches a re-export laundering truth (export … from)", async () => {
    const src = await tree({
      "core/truth.ts": "export function readTruth(){}",
      "run/leak.ts": `export { readTruth } from "../core/truth.ts";`,
    });
    const v = await scanTree(src);
    expect(v.some((x) => x.rule.includes("core/truth"))).toBe(true);
  });

  test("catches a star re-export of truth from the core barrel", async () => {
    const src = await tree({
      "core/truth.ts": "export function readTruth(){}",
      "score/index.ts": `export * from "../core/truth.ts";`,
    });
    const v = await scanTree(src);
    // Allowed area, but a star binding hides the read/write split → forbidden.
    expect(v.some((x) => x.rule.includes("namespace"))).toBe(true);
  });

  test("catches a namespace import of truth (import * as)", async () => {
    const src = await tree({
      "core/truth.ts": "export function writeTruth(){}",
      "gate/index.ts": `import * as truthMod from "../core/truth.ts";`,
    });
    const v = await scanTree(src);
    expect(v.some((x) => x.rule.includes("namespace"))).toBe(true);
  });

  test("catches a template-literal dynamic import of truth", async () => {
    const src = await tree({
      "core/truth.ts": "export function readTruth(){}",
      "report/index.ts": "const m = await import(`../core/truth.ts`);",
    });
    const v = await scanTree(src);
    expect(v.some((x) => x.rule.includes("core/truth"))).toBe(true);
  });

  test("catches the raw-fs vector: naming the truth path segment outside core/truth.ts", async () => {
    const src = await tree({
      "core/store.ts": `export const taskDir = (r,i) => r + "/tasks/" + i;`,
      "report/leak.ts": `import { taskDir } from "../core/store.ts";
        import { readFile } from "node:fs/promises";
        export const steal = (r,i) => readFile(taskDir(r,i) + "/" + "truth" + "/fix.diff");`,
    });
    const v = await scanTree(src);
    expect(v.some((x) => x.file === "report/leak.ts" && x.rule.includes("truth"))).toBe(true);
  });

  test("does not false-positive on comments that mention truth", async () => {
    const src = await tree({
      "run/index.ts": `// run/ must never read the truth/ directory or call readTruth
        /* the "truth" firewall is enforced elsewhere */
        export const x = 1;`,
    });
    expect(await scanTree(src)).toEqual([]);
  });
});
