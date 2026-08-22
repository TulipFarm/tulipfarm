import { FILE_TOOLS } from "@tulipfarm/files";
import { NETWORK_TOOL_DECLARATIONS, SKILL_MARKETPLACE_TOOL_DECLARATIONS } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { platformToolNames, resolvePlatformTool } from "./platform-tools.ts";

describe("platform Tools a Case may name", () => {
  it("exposes shipped Tool families exactly as the product declares them", () => {
    expect(platformToolNames()).toEqual(
      [...FILE_TOOLS, ...SKILL_MARKETPLACE_TOOL_DECLARATIONS, ...NETWORK_TOOL_DECLARATIONS]
        .map((tool) => tool.name)
        .sort()
    );
    for (const tool of [...FILE_TOOLS, ...NETWORK_TOOL_DECLARATIONS]) {
      const resolved = resolvePlatformTool(tool.name);
      expect(resolved?.description).toBe(tool.description);
      expect(resolved?.inputSchema).toEqual(tool.inputSchema);
    }
  });

  it("answers with nothing for a name no Tool holds, so the loader can refuse it", () => {
    expect(resolvePlatformTool("file_invent")).toBeUndefined();
  });
});
