import type { ToolBlocklistConfig } from "@tulipfarm/schema";
import type { Guard } from "../pipeline";

export interface ToolCallInput {
  toolName: string;
  tier: string;
  args: unknown;
}

const BLOCK_MESSAGE = "This tool call was blocked by a guardrail.";

/** Exact names and `*` globs become anchored regexes. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** Blocks matching tool names or tiers; absent fields are empty. */
export function makeToolBlocklistGuard(cfg: ToolBlocklistConfig): Guard<ToolCallInput> {
  const matchers = (cfg.block ?? []).map(globToRegExp);
  const categories = new Set<string>(cfg.category ?? []);

  return {
    name: "tool_blocklist",
    run(input) {
      const blocked = matchers.some((re) => re.test(input.toolName)) || categories.has(input.tier);
      if (blocked) {
        return {
          action: "block",
          reason: `tool_blocklist:${input.toolName}`,
          message: BLOCK_MESSAGE,
        };
      }
      return { action: "pass" };
    },
  };
}
