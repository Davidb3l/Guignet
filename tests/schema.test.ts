/**
 * Store-format characterization for the zod schemas. These pin the parse /
 * serialize semantics the on-disk `.guignet/` format depends on (defaults
 * applied on read, unknown keys stripped, stable key order, read-old-file
 * compatibility) so a zod major cannot silently change stored-data behavior —
 * the zod 3 -> 4 migration (`.default({})` -> `.prefault({})`) is the case
 * these were written for.
 */
import { describe, expect, test } from "bun:test";
import {
  ConfigSchema,
  RunConfigSchema,
  RunIdSchema,
  TokenUsageSchema,
  VerdictSchema,
} from "../src/core/schema.ts";

describe("ConfigSchema defaults and serialization", () => {
  test("minimal config fills every default, including the nested host defaults", () => {
    const c = ConfigSchema.parse({ testCmd: "bun test" });
    expect(c.host).toEqual({ priority: "low", maxLoadPerCore: 1.5 });
    expect(JSON.stringify(c)).toBe(
      '{"testCmd":"bun test","testCwd":"subdir","host":{"priority":"low","maxLoadPerCore":1.5},' +
        '"spine":"auto","repoVisibility":"unknown","preservePaths":[],"gateReplays":2,"verifierTimeoutMs":600000}',
    );
  });

  test("an explicit empty host object still gets its inner defaults", () => {
    expect(ConfigSchema.parse({ testCmd: "x", host: {} }).host).toEqual({ priority: "low", maxLoadPerCore: 1.5 });
  });

  test("a partial host keeps what was set and defaults the rest", () => {
    expect(ConfigSchema.parse({ testCmd: "x", host: { priority: "normal" } }).host).toEqual({
      priority: "normal",
      maxLoadPerCore: 1.5,
    });
  });

  test("host: null is rejected (not silently defaulted)", () => {
    expect(ConfigSchema.safeParse({ testCmd: "x", host: null }).success).toBe(false);
  });

  test("unknown keys are stripped, at the top level and inside host", () => {
    const c = ConfigSchema.parse({ testCmd: "x", bogus: 1, host: { zzz: 1 } });
    expect("bogus" in c).toBe(false);
    expect("zzz" in c.host).toBe(false);
  });

  test("explicit undefined optionals are treated as absent", () => {
    const c = ConfigSchema.parse({ testCmd: "x", subdir: undefined, discovery: undefined });
    expect("subdir" in JSON.parse(JSON.stringify(c))).toBe(false);
    expect("discovery" in JSON.parse(JSON.stringify(c))).toBe(false);
  });

  test("a full config round-trips unchanged through parse -> stringify -> parse", () => {
    const full = {
      testCmd: "x",
      testCwd: "repo",
      budgets: { maxDollars: 2 },
      host: { priority: "normal", maxLoadPerCore: 2 },
      spine: "on",
      cutoffs: { m: "2025-01-01" },
      repoVisibility: "private",
      preservePaths: [".venv"],
      gateReplays: 3,
      verifierTimeoutMs: 5,
      discovery: { limit: 3, loosePrefix: "a" },
    };
    const once = ConfigSchema.parse(full);
    expect(once).toEqual(full as never);
    expect(ConfigSchema.parse(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  test("invalid values are rejected with the offending paths", () => {
    const r = ConfigSchema.safeParse({
      testCmd: "",
      gateReplays: 1.5,
      preservePaths: ["../x", ".", "ok"],
      host: { maxLoadPerCore: 0 },
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    const paths = r.error.issues.map((i) => i.path.join(".")).sort();
    expect(paths).toEqual(["gateReplays", "host.maxLoadPerCore", "preservePaths.0", "preservePaths.1", "testCmd"]);
  });
});

describe("other store schemas", () => {
  test("a verdict written before testEditsFiltered existed still parses, defaulted false", () => {
    const v = VerdictSchema.parse({
      taskId: "a",
      attempt: 1,
      passed: true,
      bloatRatio: null,
      similarity: 0.5,
      regurgitationFlag: false,
      cutoffEra: "pre",
    });
    expect(v.testEditsFiltered).toBe(false);
  });

  test("token cache fields default to 0 when absent but null is rejected", () => {
    expect(TokenUsageSchema.parse({ input: 1, output: 2 })).toEqual({
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheCreation: 0,
    });
    expect(TokenUsageSchema.safeParse({ input: 1, output: 2, cacheRead: null }).success).toBe(false);
  });

  test("run config defaults nAttempts to 3", () => {
    expect(RunConfigSchema.parse({ runId: "r1", adapter: "claude-code" }).nAttempts).toBe(3);
  });

  test("run ids: only safe path-segment slugs pass", () => {
    for (const ok of ["r1", "ok-1.2_x", "a.b"]) expect(RunIdSchema.safeParse(ok).success).toBe(true);
    for (const bad of ["", ".x", "a/b", "a..b", "a\b", "x".repeat(129)]) {
      expect(RunIdSchema.safeParse(bad).success).toBe(false);
    }
  });
});
