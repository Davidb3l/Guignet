import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configPath,
  isInitialized,
  readConfig,
  StoreError,
  writeConfig,
  writeSuite,
  readSuite,
} from "../src/core/store.ts";
import { ConfigSchema, type Config } from "../src/core/schema.ts";

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "guignet-store-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe("preservePaths validation", () => {
  const cfg = (paths: string[]) => ConfigSchema.parse({ testCmd: "bun test", preservePaths: paths });
  test("accepts the flagship hidden-dir cases (a leading-dot regex bug once rejected .venv)", () => {
    expect(cfg([".venv", ".cache", ".gradle", "vendor", "target/debug"]).preservePaths).toEqual([
      ".venv", ".cache", ".gradle", "vendor", "target/debug",
    ]);
  });
  test("rejects entries that could become a git flag, escape, or disable the reset", () => {
    for (const bad of ["-x", "/abs", ".", "a/../b", ".."]) {
      expect(() => cfg([bad])).toThrow();
    }
  });
});

describe("config store", () => {
  test("isInitialized reflects config presence", async () => {
    const repo = await tmp();
    expect(isInitialized(repo)).toBe(false);
    await writeConfig(repo, ConfigSchema.parse({ testCmd: "bun test" }));
    expect(isInitialized(repo)).toBe(true);
  });

  test("write then read round-trips and applies defaults", async () => {
    const repo = await tmp();
    const cfg: Config = ConfigSchema.parse({ testCmd: "bun test", subdir: "bun-backend" });
    await writeConfig(repo, cfg);
    const back = await readConfig(repo);
    expect(back.testCmd).toBe("bun test");
    expect(back.subdir).toBe("bun-backend");
    expect(back.spine).toBe("auto"); // schema default
    expect(back.gateReplays).toBe(2); // schema default
  });

  test("reading a malformed config throws StoreError", async () => {
    const repo = await tmp();
    await writeFile(configPath(repo), "{ not json", "utf-8").catch(async () => {
      // parent dir may not exist yet; create via a valid write then clobber
    });
    // Ensure the dir exists, then write invalid JSON.
    await writeConfig(repo, ConfigSchema.parse({ testCmd: "bun test" }));
    await writeFile(configPath(repo), "{ not json ", "utf-8");
    await expect(readConfig(repo)).rejects.toBeInstanceOf(StoreError);
  });

  test("reading a schema-invalid config throws StoreError", async () => {
    const repo = await tmp();
    await writeConfig(repo, ConfigSchema.parse({ testCmd: "bun test" }));
    await writeFile(configPath(repo), JSON.stringify({ subdir: "x" }), "utf-8"); // missing testCmd
    await expect(readConfig(repo)).rejects.toBeInstanceOf(StoreError);
  });

  test("writing an invalid value is refused before it hits disk", async () => {
    const repo = await tmp();
    // @ts-expect-error — deliberately invalid to prove the write boundary validates.
    await expect(writeConfig(repo, { testCmd: "" })).rejects.toBeInstanceOf(StoreError);
    expect(isInitialized(repo)).toBe(false);
  });
});

describe("suite store", () => {
  test("round-trips a suite manifest", async () => {
    const repo = await tmp();
    await writeSuite(repo, {
      taskIds: ["a1", "b2"],
      soundnessRate: { admitted: 2, candidates: 5 },
      minedAt: "2026-07-11T00:00:00Z",
    });
    const back = await readSuite(repo);
    expect(back.taskIds).toEqual(["a1", "b2"]);
    expect(back.soundnessRate.candidates).toBe(5);
  });
});
