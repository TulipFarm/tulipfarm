import { validateMcpIntegrationDefinition } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";

const definition = {
  server: {
    id: "fixture",
    label: "Fixture",
    transport: { type: "streamable-http", url: "https://fixture.test/mcp" },
  },
  enabled: true,
  reviewed: { tools: [], resources: [], prompts: [] },
};

describe("MCP persisted definition boundary", () => {
  it("accepts an approved definition without credentials", () => {
    expect(validateMcpIntegrationDefinition(definition)).toEqual(definition);
  });

  it.each(["Display Name", "Uppercase", "contains_underscore", "trailing-", "a".repeat(129)])(
    "rejects a server id outside the canonical Integration slug: %s",
    (id) => {
      expect(() =>
        validateMcpIntegrationDefinition({
          ...definition,
          server: { ...definition.server, id },
        })
      ).toThrow();
    }
  );

  it.each([
    "http://fixture.test/mcp",
    "https://user:secret@fixture.test/mcp",
    "https://fixture.test/mcp#secret",
    "https://fixture.test/mcp?api_key=secret",
    "https://fixture.test:invalid/mcp",
  ])("rejects unsafe endpoint %s without exposing its value", (url) => {
    expect(() =>
      validateMcpIntegrationDefinition({
        ...definition,
        server: { ...definition.server, transport: { type: "streamable-http", url } },
      })
    ).toThrow();
  });

  it("rejects extra credential fields and duplicate reviewed identities", () => {
    expect(() =>
      validateMcpIntegrationDefinition({
        ...definition,
        server: { ...definition.server, token: "secret" },
      })
    ).toThrow();
    expect(() =>
      validateMcpIntegrationDefinition({
        ...definition,
        reviewed: {
          ...definition.reviewed,
          prompts: [
            { name: "same", digest: "a" },
            { name: "same", digest: "b" },
          ],
        },
      })
    ).toThrow("must be unique");
  });
});
