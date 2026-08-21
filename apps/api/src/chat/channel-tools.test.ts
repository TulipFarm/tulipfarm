import type { ToolAvailability } from "@tulipfarm/tool-broker";
import type { ToolDef } from "@tulipfarm/tool-host";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../broker/tool-adapter";
import { allowedToolNamesFor, availableToolsFor } from "./turn-helpers";

// Availability is read from each Tool's own `availableTo`, so the fixture has to carry the
// declarations a real registration carries — a bare Tool declares nothing and is offered anywhere.
const AVAILABILITY: Record<string, ToolAvailability | undefined> = {
  record_list: undefined,
  present: { requiresPresentation: true },
  request_input: { requiresPresentation: true },
  get_client_context: { requiresWebChat: true },
};

function registry(): ToolRegistry {
  const value = new ToolRegistry();
  for (const [name, availableTo] of Object.entries(AVAILABILITY)) {
    value.register({
      name,
      tier: "platform",
      mutating: false,
      description: `${name} description`,
      inputSchema: { type: "object" },
      execute: async () => ({ success: true, data: {} }),
      ...(availableTo === undefined
        ? {}
        : { definition: { availableTo } as ToolDef["definition"] }),
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

  it("keeps presentation Tools but excludes browser vocabulary for Slack", () => {
    const allowed = allowedToolNamesFor(registry(), undefined, {
      target: { channel: "slack", surface: "message" },
      destination: "channel:C1",
      rendererCapabilities: [],
    });
    expect([...(allowed ?? [])]).toEqual(
      expect.arrayContaining(["record_list", "present", "request_input"])
    );
    expect(allowed?.has("get_client_context")).toBe(false);
  });
});
