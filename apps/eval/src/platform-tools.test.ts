import { FILE_TOOLS } from "@tulipfarm/files";
import { describe, expect, it } from "vitest";
import { platformToolNames, resolvePlatformTool } from "./platform-tools.ts";

describe("platform Tools a Case may name", () => {
  it("exposes the File family exactly as the product declares it", () => {
    expect(platformToolNames()).toEqual(FILE_TOOLS.map((tool) => tool.name).sort());
    for (const tool of FILE_TOOLS) {
      const resolved = resolvePlatformTool(tool.name);
      expect(resolved?.description).toBe(tool.description);
      expect(resolved?.inputSchema).toEqual(tool.inputSchema);
    }
  });

  it("answers with nothing for a name no Tool holds, so the loader can refuse it", () => {
    expect(resolvePlatformTool("file_invent")).toBeUndefined();
  });
});
