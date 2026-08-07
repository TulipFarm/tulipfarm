import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../broker/tool-adapter";
import type { ToolDef } from "../tools/types";
import { allowedToolNamesFor, availableToolsFor, parseLastEventId } from "./turn-helpers";

describe("parseLastEventId", () => {
  it("prefers the SSE header cursor", () => {
    expect(parseLastEventId("12", 4)).toBe(12);
    expect(parseLastEventId(undefined, 4)).toBe(4);
  });

  it("reads from the start when neither cursor is usable", () => {
    expect(parseLastEventId("", undefined)).toBe(0);
    expect(parseLastEventId("not-a-number", undefined)).toBe(0);
    expect(parseLastEventId(undefined, -1)).toBe(0);
  });
});

function stubTool(name: string): ToolDef {
  return {
    name,
    tier: "platform",
    mutating: false,
    description: `desc ${name}`,
    inputSchema: { type: "object" },
    execute: async () => ({ success: true, data: {} }),
  };
}

describe("allowedToolNamesFor / availableToolsFor excluded param", () => {
  it("drops excluded tool names from the allowlist and the prompt index", () => {
    const registry = new ToolRegistry();
    registry.register(stubTool("github_issue_read"));
    registry.register(stubTool("record_create"));

    const excluded = new Set(["github_issue_read"]);
    const allowed = allowedToolNamesFor(registry, undefined, undefined, excluded);
    expect(allowed?.has("github_issue_read")).toBe(false);
    expect(allowed?.has("record_create")).toBe(true);

    const available = availableToolsFor(registry, undefined, undefined, excluded);
    expect(available.map((t) => t.name)).toEqual(["record_create"]);
  });

  it("keeps all tools visible when excluded is empty/undefined", () => {
    const registry = new ToolRegistry();
    registry.register(stubTool("github_issue_read"));

    expect(availableToolsFor(registry, undefined, undefined, new Set()).map((t) => t.name)).toEqual(
      ["github_issue_read"]
    );
    expect(availableToolsFor(registry, undefined, undefined, undefined).map((t) => t.name)).toEqual(
      ["github_issue_read"]
    );
  });
});
