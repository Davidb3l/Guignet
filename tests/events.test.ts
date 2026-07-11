import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildEvent, bucketFor, emitEvent, eventsDir, shouldEmit, suiteDir, uri } from "../src/core/events.ts";

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "guignet-events-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe("uri helpers", () => {
  test("build guignet: scheme URIs", () => {
    expect(uri.task("3f9c")).toBe("guignet:task/3f9c");
    expect(uri.run("2026-07-11-opus")).toBe("guignet:run/2026-07-11-opus");
    expect(uri.report("t1")).toBe("guignet:report/t1");
  });
});

describe("bucketFor", () => {
  test("buckets by UTC day", () => {
    expect(bucketFor("2026-07-11T22:41:00Z")).toBe("2026-07-11.jsonl");
  });
});

describe("shouldEmit — the §13 config gate", () => {
  test("'off' never emits", async () => {
    const repo = await tmp();
    await mkdir(suiteDir(repo), { recursive: true });
    expect(shouldEmit("off", repo)).toBe(false);
  });

  test("'on' always emits", async () => {
    const repo = await tmp();
    expect(shouldEmit("on", repo)).toBe(true);
  });

  test("'auto' emits only when .suite/ already exists", async () => {
    const repo = await tmp();
    expect(shouldEmit("auto", repo)).toBe(false); // never introduces .suite/ into a client repo
    await mkdir(suiteDir(repo), { recursive: true });
    expect(shouldEmit("auto", repo)).toBe(true);
  });
});

describe("buildEvent", () => {
  test("builds a conformant envelope shape", () => {
    const e = buildEvent("task.admitted", ["guignet:task/x"], { task: "x", kind: "bugfix" }, "id-1", "2026-07-11T00:00:00Z");
    expect(e.v).toBe(1);
    expect(e.source).toBe("guignet");
    expect(e.type).toBe("task.admitted");
    expect(e.refs).toEqual(["guignet:task/x"]);
  });
});

describe("emitEvent", () => {
  test("writes a conformant line to today's bucket when permitted", async () => {
    const repo = await tmp();
    const wrote = await emitEvent("on", repo, "suite.mined", [], { candidates: 42 });
    expect(wrote).toBe(true);

    const files = await readdir(eventsDir(repo));
    expect(files.length).toBe(1);
    const raw = await readFile(join(eventsDir(repo), files[0]!), "utf-8");
    // Exactly one line, ending in \n, < 4096 bytes, parses as a guignet event.
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.trimEnd().includes("\n")).toBe(false);
    expect(new TextEncoder().encode(raw).length).toBeLessThan(4096);
    const obj = JSON.parse(raw);
    expect(obj.source).toBe("guignet");
    expect(obj.type).toBe("suite.mined");
    expect(obj.data.candidates).toBe(42);
    expect(obj.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(obj.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  test("'auto' against a repo with no .suite/ writes nothing", async () => {
    const repo = await tmp();
    const wrote = await emitEvent("auto", repo, "suite.mined", [], { candidates: 1 });
    expect(wrote).toBe(false);
    await expect(readdir(suiteDir(repo))).rejects.toBeTruthy(); // .suite/ was never created
  });
});
