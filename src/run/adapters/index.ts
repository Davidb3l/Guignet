/**
 * Adapter selection. v0 ships exactly two (§6); a run's config names one.
 */
import type { RunConfig } from "../../core/index.ts";
import { claudeCodeAdapter } from "./claude-code.ts";
import { makeGenericCliAdapter } from "./generic-cli.ts";
import type { Adapter } from "./types.ts";

/** Resolve the adapter a run config asks for, or throw a usage-level error. */
export function selectAdapter(runConfig: RunConfig): Adapter {
  switch (runConfig.adapter) {
    case "claude-code":
      return claudeCodeAdapter;
    case "generic-cli":
      if (!runConfig.genericCli?.cmd) {
        throw new Error('the "generic-cli" adapter requires config.genericCli.cmd (a command template with {prompt}/{worktree})');
      }
      return makeGenericCliAdapter(runConfig.genericCli.cmd);
  }
}

export type { Adapter } from "./types.ts";
