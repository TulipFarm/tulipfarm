import {
  GITHUB_KNOWLEDGE_IMAGE,
  GITHUB_KNOWLEDGE_PRESET,
  validateMcpIntegrationDefinition,
} from "@tulipfarm/schema";
import { expect, test } from "vitest";
import { MCP_CATALOG } from "./catalog";

test("GitHub keeps its remote option and exposes the exact personal local Knowledge profile", () => {
  const github = MCP_CATALOG.find((entry) => entry.id === "github");
  expect(github?.url).toBe("https://api.githubcopilot.com/mcp/");
  expect(github?.localPreset).toBe(GITHUB_KNOWLEDGE_PRESET);
  expect(github?.localPreset).toEqual({
    id: "github-knowledge",
    label: "GitHub Knowledge (local)",
    transport: {
      type: "stdio",
      image: GITHUB_KNOWLEDGE_IMAGE,
      command: "/server/github-mcp-server",
      args: ["stdio"],
      allowedEgress: ["api.github.com"],
    },
    authentication: {
      type: "token",
      environment: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
      sharedAllowed: false,
    },
  });
  expect(() =>
    validateMcpIntegrationDefinition({
      server: GITHUB_KNOWLEDGE_PRESET,
      enabled: false,
      reviewed: { tools: [], resources: [], prompts: [] },
    })
  ).not.toThrow();
  expect(github?.setup.join(" ")).toContain(
    "Shared accounts and the remote GitHub server are not eligible"
  );
});
