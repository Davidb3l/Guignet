import { describe, expect, test } from "bun:test";

import { runId, slugify, taskId } from "../src/core/ids.ts";

describe("taskId", () => {
  test("is a 16-char lowercase hex string", async () => {
    const id = await taskId({ baseSha: "abc123", verifierPaths: ["a.test.ts"] });
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  test("is stable for the same inputs", async () => {
    const a = await taskId({ baseSha: "deadbeef", verifierPaths: ["x.ts", "y.ts"] });
    const b = await taskId({ baseSha: "deadbeef", verifierPaths: ["x.ts", "y.ts"] });
    expect(a).toBe(b);
  });

  test("is order-independent in the verifier path set", async () => {
    const a = await taskId({ baseSha: "deadbeef", verifierPaths: ["x.ts", "y.ts"] });
    const b = await taskId({ baseSha: "deadbeef", verifierPaths: ["y.ts", "x.ts"] });
    expect(a).toBe(b);
  });

  test("changes when baseSha changes", async () => {
    const a = await taskId({ baseSha: "aaa", verifierPaths: ["x.ts"] });
    const b = await taskId({ baseSha: "bbb", verifierPaths: ["x.ts"] });
    expect(a).not.toBe(b);
  });

  test("changes when the verifier set changes", async () => {
    const a = await taskId({ baseSha: "aaa", verifierPaths: ["x.ts"] });
    const b = await taskId({ baseSha: "aaa", verifierPaths: ["x.ts", "z.ts"] });
    expect(a).not.toBe(b);
  });

  test("does not collide when a path boundary is ambiguous", async () => {
    // "a" + "b/c" vs "a/b" + "c" must differ — the NUL/space join is injective.
    const a = await taskId({ baseSha: "s", verifierPaths: ["a", "b/c"] });
    const b = await taskId({ baseSha: "s", verifierPaths: ["a/b", "c"] });
    expect(a).not.toBe(b);
  });
});

describe("runId / slugify", () => {
  test("runId combines date and a path-safe slug", () => {
    expect(runId("2026-07-11", "Opus Baseline")).toBe("2026-07-11-opus-baseline");
  });

  test("runId falls back to 'run' for an empty slug", () => {
    expect(runId("2026-07-11", "!!!")).toBe("2026-07-11-run");
  });

  test("slugify reduces to [a-z0-9-] with trimmed edges", () => {
    expect(slugify("  Claude Opus 4.8!  ")).toBe("claude-opus-4-8");
  });
});
