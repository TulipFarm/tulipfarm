import { describe, expect, it } from "vitest";
import { KNOWLEDGE_TOOLS } from "../knowledge/tools";
import { MEMORY_TOOLS } from "../memory/tools";
import { PLATFORM_TOOLS } from "../platform/tools";
import { RESOURCE_TOOLS } from "../resources/tools";
import { AGENT_TOOLS } from "../soul/agents/tools";
import { RESOURCE_TYPE_TOOLS } from "../soul/resource-types/tools";
import { SKILL_TOOLS } from "../soul/skills/tools";

/**
 * Every tool's inputSchema is sent verbatim to the LLM as a function-call parameter schema. The
 * OpenAI/Azure function-calling API REJECTS a top-level `anyOf`/`oneOf`/`allOf`/`enum`/`not` (and a
 * non-`object` root) and 400s the WHOLE request — so one bad schema disables every tool in the turn.
 * This guard fails loudly if any registered tool reintroduces a top-level combinator. Enforce the
 * "at least one of X/Y" style constraint in the handler instead (see agent_update / skill_update).
 */
const ALL_TOOLS = [
  ...MEMORY_TOOLS,
  ...KNOWLEDGE_TOOLS,
  ...RESOURCE_TOOLS,
  ...RESOURCE_TYPE_TOOLS,
  ...AGENT_TOOLS,
  ...SKILL_TOOLS,
  ...PLATFORM_TOOLS,
] as Array<{ name: string; inputSchema: Record<string, unknown> }>;

const FORBIDDEN_TOP_LEVEL_KEYS = ["anyOf", "oneOf", "allOf", "enum", "not"] as const;

describe("OpenAI tool-schema compatibility", () => {
  for (const tool of ALL_TOOLS) {
    it(`${tool.name}: root is an object with no forbidden top-level combinator`, () => {
      expect(tool.inputSchema.type).toBe("object");
      for (const key of FORBIDDEN_TOP_LEVEL_KEYS) {
        expect(tool.inputSchema).not.toHaveProperty(key);
      }
    });
  }
});
