import { expect, test } from "vitest";
import type { McpIntegrationDefinition } from "./mcp";
import { describeMcpAccess } from "./mcp-access";

const definition: McpIntegrationDefinition = {
  server: {
    id: "test",
    label: "Test",
    transport: { type: "streamable-http", url: "https://example.com/" },
  },
  enabled: true,
  reviewed: { tools: [], resources: [], prompts: [] },
};

test.each([
  [undefined, "preserved_empty"],
  ["custom", "preserved_empty"],
  ["initial", "initial_empty"],
  ["uninitialized", "uninitialized"],
] as const)(
  "describes %s policy without inventing discovery or account evidence",
  (reviewPolicy, state) => {
    expect(describeMcpAccess({ ...definition, ...(reviewPolicy ? { reviewPolicy } : {}) })).toEqual(
      {
        enabled: true,
        state,
        tools: 0,
        resources: 0,
        prompts: 0,
      }
    );
  }
);

test("keeps disabled settings separate from allowed content and does not invent Tools", () => {
  expect(
    describeMcpAccess({
      ...definition,
      enabled: false,
      reviewed: { ...definition.reviewed, prompts: [{ name: "review", digest: "a".repeat(64) }] },
    })
  ).toEqual({ enabled: false, state: "allowed", tools: 0, resources: 0, prompts: 1 });
});
