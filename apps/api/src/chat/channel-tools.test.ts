import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../broker/tool-adapter";
import { allowedToolNamesFor, availableToolsFor } from "./turn-helpers";

function registry(): ToolRegistry {
  const value = new ToolRegistry();
  for (const name of ["record_list", "present", "request_input", "get_client_context"]) {
    value.register({
      name,
      tier: "platform",
      mutating: false,
      description: `${name} description`,
      inputSchema: { type: "object" },
      execute: async () => ({ success: true, data: {} }),
    });
  }
  return value;
}

describe("target-aware Tool projection", () => {
  it("keeps presentation and frontend Tools for browser Chat Turns", () => {
    expect([
      ...(allowedToolNamesFor(registry(), undefined, {
        target: { channel: "web", surface: "chat" },
        destination: "conversation:1",
        rendererCapabilities: [],
      }) ?? []),
    ]).toEqual(expect.arrayContaining(["present", "request_input", "get_client_context"]));
  });

  it("removes presentation and browser Tools when no target was resolved", () => {
    const value = registry();
    expect([...(allowedToolNamesFor(value, undefined) ?? [])]).toEqual(["record_list"]);
    expect(availableToolsFor(value, undefined)).toEqual([
      { name: "record_list", description: "record_list description" },
    ]);
  });

  it("keeps presentation Tools but excludes browser vocabulary for Telegram", () => {
    const allowed = allowedToolNamesFor(registry(), undefined, {
      target: { channel: "telegram", surface: "message" },
      destination: "chat:1",
      rendererCapabilities: [],
    });
    expect([...(allowed ?? [])]).toEqual(
      expect.arrayContaining(["record_list", "present", "request_input"])
    );
    expect(allowed?.has("get_client_context")).toBe(false);
  });
});
