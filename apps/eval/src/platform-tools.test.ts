import { FILE_TOOLS } from "@tulipfarm/files";
import { PLATFORM_RUNTIME_TOOLS } from "@tulipfarm/platform-tools";
import {
  MCP_SETUP_TOOL_DECLARATIONS,
  NETWORK_TOOL_DECLARATIONS,
  PACK_READ_TOOL_DECLARATION,
  RECORD_DELETE_TOOL_DECLARATIONS,
  SKILL_MARKETPLACE_TOOL_DECLARATIONS,
  SOUL_REPO_PUSH_TOOL_DECLARATION,
} from "@tulipfarm/schema";
import { SKILL_TOOL_DECLARATION } from "@tulipfarm/soul";
import { describe, expect, it } from "vitest";
import { platformToolNames, resolvePlatformTool } from "./platform-tools.ts";

describe("platform Tools a Case may name", () => {
  it("exposes every shipped declaration exactly as the product declares it", () => {
    const shippedDeclarations = [
      ...PLATFORM_RUNTIME_TOOLS,
      ...FILE_TOOLS,
      ...MCP_SETUP_TOOL_DECLARATIONS,
      ...SKILL_MARKETPLACE_TOOL_DECLARATIONS,
      SKILL_TOOL_DECLARATION,
      SOUL_REPO_PUSH_TOOL_DECLARATION,
      ...NETWORK_TOOL_DECLARATIONS,
      PACK_READ_TOOL_DECLARATION,
      ...RECORD_DELETE_TOOL_DECLARATIONS,
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

  it("exposes MCP definition setup under the live Integration Tool names", () => {
    expect(resolvePlatformTool("integration_get")?.inputSchema).toMatchObject({
      required: ["slug"],
      properties: { slug: { type: "string" } },
    });
    expect(resolvePlatformTool("integration_configure")?.inputSchema).toMatchObject({
      required: ["slug", "configuration"],
    });
    expect(resolvePlatformTool("mcp_server_get")).toBeUndefined();
    expect(resolvePlatformTool("mcp_server_configure")).toBeUndefined();
  });
});
