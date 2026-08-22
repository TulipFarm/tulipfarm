import { FILE_TOOLS } from "@tulipfarm/files";
import {
  GITHUB_REPOSITORY_LIST_DECLARATION,
  GITHUB_TOOL_DECLARATIONS,
  SLACK_TOOL_DECLARATIONS,
} from "@tulipfarm/integrations";
import { NETWORK_TOOL_DECLARATIONS, SKILL_MARKETPLACE_TOOL_DECLARATIONS } from "@tulipfarm/schema";
import { SKILL_REFERENCE_TOOL_DECLARATIONS } from "@tulipfarm/soul";
import { describe, expect, it } from "vitest";
import { platformToolNames, resolvePlatformTool } from "./platform-tools.ts";

describe("platform Tools a Case may name", () => {
  it("exposes every shipped declaration exactly as the product declares it", () => {
    const shippedDeclarations = [
      ...FILE_TOOLS,
      ...SKILL_MARKETPLACE_TOOL_DECLARATIONS,
      ...SKILL_REFERENCE_TOOL_DECLARATIONS,
      GITHUB_REPOSITORY_LIST_DECLARATION,
      ...GITHUB_TOOL_DECLARATIONS,
      ...SLACK_TOOL_DECLARATIONS,
      ...NETWORK_TOOL_DECLARATIONS,
    ];

    expect(platformToolNames()).toEqual(shippedDeclarations.map((tool) => tool.name).sort());
    for (const tool of shippedDeclarations) {
      const resolved = resolvePlatformTool(tool.name);
      expect(resolved?.description).toBe(tool.description);
      expect(resolved?.inputSchema).toEqual(tool.inputSchema);
    }
  });

  it("answers with nothing for a name no Tool holds, so the loader can refuse it", () => {
    expect(resolvePlatformTool("file_invent")).toBeUndefined();
  });
});
