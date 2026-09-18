import type { McpIntegrationDefinition } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { accountDefinitionForIntegration } from "./definition";

function definition(): McpIntegrationDefinition {
  return {
    server: {
      id: "github",
      label: "GitHub",
      transport: { type: "streamable-http", url: "https://api.githubcopilot.com/mcp/" },
      authentication: { type: "token", sharedAllowed: true },
    },
    enabled: true,
    reviewed: { tools: [], resources: [], prompts: [] },
  };
}

describe("MCP account definition", () => {
  it("keeps account credentials valid when capability reviews or enablement change", () => {
    const input = definition();
    const expected = accountDefinitionForIntegration(input);
    input.enabled = false;
    input.server.label = "Renamed GitHub";
    input.reviewed.prompts.push({ name: "summarize", digest: "a".repeat(64) });
    expect(accountDefinitionForIntegration(input)).toEqual(expected);
    expect(expected.requiredSlots).toEqual(["accessToken"]);
  });

  it("invalidates account configuration when destination or authentication changes", () => {
    const input = definition();
    const original = accountDefinitionForIntegration(input).definitionDigest;
    input.server.transport = { type: "streamable-http", url: "https://other.example/mcp" };
    expect(accountDefinitionForIntegration(input).definitionDigest).not.toBe(original);
    input.server.authentication = { type: "oauth" };
    expect(accountDefinitionForIntegration(input)).toMatchObject({
      authentication: "oauth",
      requiredSlots: [],
    });
  });

  it("never permits shared Slack OAuth credentials", () => {
    const input = definition();
    input.server.transport = { type: "streamable-http", url: "https://mcp.slack.com/mcp" };
    input.server.authentication = { type: "oauth", sharedAllowed: true };
    expect(accountDefinitionForIntegration(input).sharedAllowed).toBe(false);
  });

  it("uses declared environment slots for isolated local servers", () => {
    const input = definition();
    input.server.transport = {
      type: "stdio",
      image: `ghcr.io/github/github-mcp-server@sha256:${"a".repeat(64)}`,
      command: "/server",
      args: ["stdio"],
      allowedEgress: ["api.github.com"],
    };
    input.server.authentication = {
      type: "token",
      environment: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    };
    expect(accountDefinitionForIntegration(input).requiredSlots).toEqual([
      "GITHUB_PERSONAL_ACCESS_TOKEN",
    ]);
  });
});
