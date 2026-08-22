import { FILE_TOOLS } from "@tulipfarm/files";
import { SKILL_MARKETPLACE_TOOL_DECLARATIONS } from "@tulipfarm/schema";
import { SKILL_REFERENCE_TOOL_DECLARATIONS } from "@tulipfarm/soul";
import { describe, expect, it } from "vitest";
import { platformToolNames, resolvePlatformTool } from "./platform-tools.ts";

describe("platform Tools a Case may name", () => {
  it("exposes the File family exactly as the product declares it", () => {
    expect(platformToolNames()).toEqual(
      [...FILE_TOOLS, ...SKILL_MARKETPLACE_TOOL_DECLARATIONS, ...SKILL_REFERENCE_TOOL_DECLARATIONS]
        .map((tool) => tool.name)
        .sort()
    );
    for (const tool of FILE_TOOLS) {
      const resolved = resolvePlatformTool(tool.name);
      expect(resolved?.description).toBe(tool.description);
      expect(resolved?.inputSchema).toEqual(tool.inputSchema);
    }
    for (const tool of SKILL_REFERENCE_TOOL_DECLARATIONS) {
      const resolved = resolvePlatformTool(tool.name);
      expect(resolved?.description).toBe(tool.description);
      expect(resolved?.inputSchema).toEqual(tool.inputSchema);
    }
  });

  it("answers with nothing for a name no Tool holds, so the loader can refuse it", () => {
    expect(resolvePlatformTool("file_invent")).toBeUndefined();
  });
});
