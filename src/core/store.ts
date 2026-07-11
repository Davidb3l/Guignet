/**
 * The store — read/write `.guignet/` (ARCHITECTURE.md §3). The filesystem IS
 * the database: inspectable, diffable, resumable. Every read and write crosses
 * a zod boundary (core/schema.ts), so a malformed file fails loudly here rather
 * than corrupting a stage downstream.
 *
 * This module owns everything under `.guignet/` EXCEPT the held-out `truth/`
 * directories, which live behind the leak firewall in core/truth.ts (§5). No
 * path helper here constructs a `truth/` path. `taskDir` IS technically a
 * prefix of the truth path, so the firewall does not rest on this module alone:
 * scripts/check-boundaries.ts also forbids any file except core/truth.ts from
 * naming the `truth` path segment, closing the raw-fs-under-taskDir route.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { z } from "zod";

import {
  ConfigSchema,
  GateSchema,
  SuiteSchema,
  TaskSchema,
  type Config,
  type Gate,
  type Suite,
  type Task,
} from "./schema.ts";

/** The store root inside a target repo. */
export function storeRoot(repoRoot: string): string {
  return join(repoRoot, ".guignet");
}

export function configPath(repoRoot: string): string {
  return join(storeRoot(repoRoot), "config.json");
}

export function suitePath(repoRoot: string): string {
  return join(storeRoot(repoRoot), "suite.json");
}

export function taskDir(repoRoot: string, taskId: string): string {
  return join(storeRoot(repoRoot), "tasks", taskId);
}

/** Read a JSON file and validate it against a schema. Throws on either failure. */
async function readJson<T extends z.ZodTypeAny>(path: string, schema: T): Promise<z.infer<T>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    throw new StoreError(`cannot read ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new StoreError(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new StoreError(`${path} failed schema validation: ${result.error.message}`);
  }
  return result.data;
}

/** Validate then write a JSON file (pretty-printed), creating parent dirs. */
async function writeJson<T extends z.ZodTypeAny>(
  path: string,
  schema: T,
  value: z.infer<T>,
): Promise<void> {
  // Validate on the way out too: a write is a boundary just like a read.
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new StoreError(`refusing to write invalid ${path}: ${result.error.message}`);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(result.data, null, 2) + "\n", "utf-8");
}

/** A store-layer error — a bad file, not a program bug. */
export class StoreError extends Error {
  override name = "StoreError";
}

/** Is a `.guignet/config.json` present in this repo? (Doctor's "initialized" probe.) */
export function isInitialized(repoRoot: string): boolean {
  return existsSync(configPath(repoRoot));
}

export function readConfig(repoRoot: string): Promise<Config> {
  return readJson(configPath(repoRoot), ConfigSchema);
}

export function writeConfig(repoRoot: string, config: Config): Promise<void> {
  return writeJson(configPath(repoRoot), ConfigSchema, config);
}

export function readSuite(repoRoot: string): Promise<Suite> {
  return readJson(suitePath(repoRoot), SuiteSchema);
}

export function writeSuite(repoRoot: string, suite: Suite): Promise<void> {
  return writeJson(suitePath(repoRoot), SuiteSchema, suite);
}

export function readTask(repoRoot: string, taskId: string): Promise<Task> {
  return readJson(join(taskDir(repoRoot, taskId), "task.json"), TaskSchema);
}

export function writeTask(repoRoot: string, task: Task): Promise<void> {
  return writeJson(join(taskDir(repoRoot, task.id), "task.json"), TaskSchema, task);
}

export function readGate(repoRoot: string, taskId: string): Promise<Gate> {
  return readJson(join(taskDir(repoRoot, taskId), "gate.json"), GateSchema);
}

export function writeGate(repoRoot: string, gate: Gate): Promise<void> {
  return writeJson(join(taskDir(repoRoot, gate.taskId), "gate.json"), GateSchema, gate);
}
