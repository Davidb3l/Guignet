/**
 * Host-citizenship tests (core/host.ts + the pool admission seam). Everything
 * host-dependent goes through an injected HostProbe, so these simulate any
 * machine — saturated, idle, non-mac — without loading the real one.
 */
import { describe, expect, test } from "bun:test";

import {
  buildPriorityArgv,
  defaultConcurrency,
  waitForHeadroom,
  type HostProbe,
} from "../src/core/host.ts";
import { runShell } from "../src/core/proc.ts";
import { mapLimit } from "../src/run/pool.ts";

function probe(over: Partial<Record<keyof HostProbe, unknown>>): HostProbe {
  return {
    load1: () => 0,
    cores: () => 8,
    platform: () => "darwin" as NodeJS.Platform,
    hasTaskpolicy: () => true,
    ...(over as Partial<HostProbe>),
  };
}

describe("buildPriorityArgv", () => {
  test("macOS with taskpolicy → QoS clamp; the target argv is preserved intact", () => {
    expect(buildPriorityArgv(["sh", "-c", "bun test"], "low", probe({}))).toEqual([
      "taskpolicy", "-c", "utility", "sh", "-c", "bun test",
    ]);
  });
  test("macOS without taskpolicy, and linux, fall back to nice", () => {
    expect(buildPriorityArgv(["x"], "low", probe({ hasTaskpolicy: () => false }))).toEqual(["nice", "-n", "10", "x"]);
    expect(buildPriorityArgv(["x"], "low", probe({ platform: () => "linux" }))).toEqual(["nice", "-n", "10", "x"]);
  });
  test("'normal' and unknown platforms leave the argv untouched", () => {
    expect(buildPriorityArgv(["x"], "normal", probe({}))).toEqual(["x"]);
    expect(buildPriorityArgv(["x"], "low", probe({ platform: () => "win32" }))).toEqual(["x"]);
  });
});

describe("waitForHeadroom", () => {
  test("admits immediately when nothing else is in flight, however loaded (progress guarantee)", async () => {
    const start = Date.now();
    await waitForHeadroom({ maxLoadPerCore: 1.5, active: () => 0, probe: probe({ load1: () => 999 }), sleepMs: 5 });
    expect(Date.now() - start).toBeLessThan(100);
  });
  test("holds while saturated, admits when load drops", async () => {
    let load = 100;
    setTimeout(() => (load = 1), 30);
    await waitForHeadroom({ maxLoadPerCore: 1.5, active: () => 1, probe: probe({ load1: () => load }), sleepMs: 5 });
    expect(load).toBe(1); // resolved only after the drop
  });
  test("a parked unit is released when its peers finish (live count), not only on load drop", async () => {
    let others = 1;
    setTimeout(() => (others = 0), 30);
    await waitForHeadroom({ maxLoadPerCore: 1.5, active: () => others, probe: probe({ load1: () => 999 }), sleepMs: 5 });
    expect(others).toBe(0);
  });
});

describe("defaultConcurrency (load-aware)", () => {
  test("idle machine keeps the historical default min(4, cores/2)", () => {
    expect(defaultConcurrency(probe({ cores: () => 10 }))).toBe(4);
    expect(defaultConcurrency(probe({ cores: () => 4 }))).toBe(2);
  });
  test("a busy machine gets a smaller pool, floored at 1", () => {
    expect(defaultConcurrency(probe({ cores: () => 10, load1: () => 4 }))).toBe(2); // 4 - floor(4/2)
    expect(defaultConcurrency(probe({ cores: () => 10, load1: () => 22 }))).toBe(1); // never 0
  });
});

describe("pool admission seam", () => {
  test("admit is awaited per unit with a LIVE others-in-flight count", async () => {
    const seen: number[] = [];
    await mapLimit(
      [1, 2, 3, 4],
      2,
      async (n) => {
        await new Promise((r) => setTimeout(r, 5));
        return n;
      },
      async (others) => {
        seen.push(others());
      },
    );
    expect(seen.length).toBe(4);
    // With width 2, a unit admitted alongside a running peer must see 1.
    expect(Math.max(...seen)).toBe(1);
    expect(Math.min(...seen)).toBe(0);
  });
  test("a unit parked in admission proceeds once its peer finishes", async () => {
    const order: string[] = [];
    await mapLimit(
      ["a", "b"],
      2,
      async (id) => {
        order.push(`run:${id}`);
        return id;
      },
      // Park anything with a peer running until that peer completes.
      async (running) => {
        while (running() > 0) await new Promise((r) => setTimeout(r, 2));
      },
    );
    expect(order).toEqual(["run:a", "run:b"]); // sequentialized, both ran
  });

  test("REGRESSION: a permanently saturated host completes ALL items sequentially — never stalls", async () => {
    // An earlier draft counted PARKED units as in-flight: once every puller
    // parked, the count could never fall to zero and the pool stalled with
    // work remaining after finishing exactly one item (caught in review, with
    // this exact repro: items > width, width > 1, load pinned above any
    // threshold). Running-only counting must complete the whole batch.
    const saturated = probe({ load1: () => 999, cores: () => 8 });
    let running = 0;
    let maxRunning = 0;
    const done: number[] = [];
    await mapLimit(
      [1, 2, 3, 4, 5, 6],
      4,
      async (n) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        done.push(n);
        return n;
      },
      (others) =>
        waitForHeadroom({ maxLoadPerCore: 1.5, active: others, probe: saturated, sleepMs: 2 }),
    );
    expect(done.length).toBe(6); // every item finished — no stall
    expect(maxRunning).toBe(1); // degraded to sequential under saturation
  });
});

describe("runShell under low priority", () => {
  test("still executes and captures output (wrapper execs the target in place)", async () => {
    const r = await runShell("echo hostcitizen", { cwd: process.cwd(), priority: "low" });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("hostcitizen");
  });
});
