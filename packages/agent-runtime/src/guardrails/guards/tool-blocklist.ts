import type { ToolBlocklistConfig } from "@tulipfarm/schema";
import type { Guard } from "../pipeline";

/**
 * Input to the tool-call guard stage. The {@link GuardrailsService} imports this
 * type from here when wiring the tool-call hook.
 */
export interface ToolCallInput {
  toolName: string;
  tier: string;
  args: unknown;
}

const BLOCK_MESSAGE = "This tool call was blocked by a guardrail.";

/**
 * Translate a blocklist entry (an exact name or a wildcard glob like `fs_*`) into
 * an anchored RegExp. Regex metacharacters are escaped first so a literal `.` in a
 * tool name is not treated as "any char"; only `*` becomes the `.*` wildcard.
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * Tool-call guard. Blocks a call when its `toolName` matches any
 * `block` entry (exact name or wildcard glob) or its `tier` is in `category`.
 * Both fields are optional and treated as empty when absent.
 */
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
