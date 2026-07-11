/**
 * The `core` public surface. Everything may import `core`; `core` imports
 * nothing internal (ARCHITECTURE.md §4). Note this barrel deliberately does NOT
 * re-export core/truth.ts — ground truth stays behind the firewall and is
 * imported directly, and only by the stages allowed to (§5).
 */
export * from "./exit.ts";
export * from "./stage.ts";
export * from "./ids.ts";
export * from "./schema.ts";
export * from "./store.ts";
export * from "./events.ts";
export * from "./git.ts";
export * from "./proc.ts";
