import { describe, expect, it } from "vitest";
import { KNOWLEDGE_TOOLS } from "../knowledge/tools";
import { MEMORY_TOOLS } from "../memory/tools";
import { PLATFORM_TOOLS } from "../platform/tools";
import { RESOURCE_TOOLS } from "../resources/tools";
import { AGENT_TOOLS } from "../soul/agents/tools";
import { RESOURCE_TYPE_TOOLS } from "../soul/resource-types/tools";
import { SKILL_TOOLS } from "../soul/skills/tools";

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
