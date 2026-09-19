import { McpIntegrationError, mcpServerRevision } from "@tulipfarm/integrations";
import type { McpIntegrationDefinition } from "@tulipfarm/schema";
import { makeSoulWriterDouble, type RuntimeBundle, SoulPublicationError } from "@tulipfarm/soul";
import { describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { createMcpIntegrationFeature } from "./mcp-compose";

const actor = {
  principalId: "operator",
  name: "Muskan Vijayvargiya",
  email: "operator@example.com",
};
const definition: McpIntegrationDefinition = {
  server: {
    id: "github-mcp",
    label: "GitHub",
    transport: { type: "streamable-http", url: "https://api.githubcopilot.com/mcp/" },
  },
  enabled: false,
  reviewed: { tools: [], resources: [], prompts: [] },
};

async function fixture() {
  const double = makeSoulWriterDouble();
  double.putCompanion("Integration", "github-mcp", "mcp.yaml", stringify(definition));
  const bundle: RuntimeBundle = {
    digest: "active",
    businessId: "business",
    changesetId: "changeset",
    commitSha: "0".repeat(40),
    definitions: [],
    assets: [
      {
        ownerDefinitionId: "Integration:github-mcp",
        path: "mcp.yaml",
        digest: "definition",
        content: stringify(definition),
      },
    ],
    get: () => undefined,
    getById: () => undefined,
    asset: () => undefined,
  };
  const activeBundle = vi.fn(async () => bundle);
  const afterDefinitionChange = vi.fn(async () => {});
  const feature = await createMcpIntegrationFeature({
    businessId: "business",
    soulWriter: double.writer,
    activeBundle,
    accounts: {
      bind: async () => {
        throw new Error("No account access expected");
      },
      revalidate: async () => {},
      use: async () => {
        throw new Error("No provider access expected");
      },
    },
    audit: { record: async () => {} },
    callerForRequest: async () => ({ principal: { kind: "user", id: "operator" } }),
    callerForRun: async () => ({ principal: { kind: "user", id: "operator" } }),
    afterDefinitionChange,
  });
  return { ...double, ...feature, activeBundle, afterDefinitionChange };
}

describe("MCP publication boundary", () => {
  it("refreshes the active view and dependent accounts after a published write", async () => {
    const f = await fixture();
    await f.service.configure("github-mcp", definition, actor);
    expect(f.activeBundle).toHaveBeenCalledTimes(2);
    expect(f.afterDefinitionChange).toHaveBeenCalledOnce();
  });

  it.each(["configure", "publishSetup", "remove"] as const)(
    "classifies committed but unpublished %s without claiming success",
    async (operation) => {
      const f = await fixture();
      vi.spyOn(f.writer, "apply").mockResolvedValue({
        commitSha: "1".repeat(40),
        filesChanged: 1,
        paths: ["integrations/github-mcp/mcp.yaml"],
        pushed: true,
        published: false,
        publicationError: "private-agent secret://private",
      });
      const change =
        operation === "remove"
          ? f.service.remove("github-mcp", actor)
          : operation === "publishSetup"
            ? f.service.publishSetup(definition, mcpServerRevision(definition), actor)
            : f.service.configure("github-mcp", definition, actor);
      await expect(change).rejects.toMatchObject({
        name: "McpIntegrationError",
        code: "publication_failed",
        message:
          "TulipFarm could not activate the integration settings. An admin must check Operations and Activity before retrying setup.",
      });
      expect(f.activeBundle).toHaveBeenCalledTimes(1);
      expect(f.afterDefinitionChange).not.toHaveBeenCalled();
      expect(f.service.get("github-mcp")).toEqual(definition);
    }
  );

  it("never exposes publication diagnostics or the cause", async () => {
    const f = await fixture();
    f.failNextWith(
      new SoulPublicationError("PROJECTION_FAILED", "private-agent secret://private", {
        cause: new Error("synthetic-credential"),
      })
    );
    const error = await f.service
      .configure("github-mcp", definition, actor)
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(McpIntegrationError);
    expect(error).not.toHaveProperty("cause");
    expect(String(error)).not.toMatch(/private-agent|secret:|synthetic-credential/);
  });

  it("does not misclassify an unrelated write failure as publication failure", async () => {
    const f = await fixture();
    const failure = new Error("Unrelated write failure");
    f.failNextWith(failure);
    await expect(f.service.configure("github-mcp", definition, actor)).rejects.toBe(failure);
    expect(f.afterDefinitionChange).not.toHaveBeenCalled();
  });
});
