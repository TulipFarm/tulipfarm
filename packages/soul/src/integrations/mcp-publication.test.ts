import {
  ajv,
  canonicalHash,
  type McpIntegrationDefinition,
  mcpToolContract,
  ToolContractDefinitionSchema,
} from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { BundleError, computeBundleDigest, createRuntimeBundle } from "../bundle";
import { type BundleCompileRequest, compileExecutionBundle } from "../compiler";
import { mcpIntegrationsFromBundle } from "./mcp-definition";

function definition(): McpIntegrationDefinition {
  return {
    server: {
      id: "weather",
      label: "Weather",
      transport: { type: "streamable-http", url: "https://weather.example.com/mcp" },
    },
    enabled: true,
    reviewed: {
      tools: [
        {
          name: "read-weather",
          description: "Read weather",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          digest: "a".repeat(64),
          mutating: false,
          requiresApproval: false,
        },
      ],
      resources: [],
      prompts: [],
    },
  };
}

function request(value: McpIntegrationDefinition): BundleCompileRequest {
  return {
    businessId: "business-1",
    changesetId: "changeset-1",
    commitSha: "a".repeat(40),
    documents: [],
    files: [{ path: "integrations/weather/mcp.yaml", content: stringify(value) }],
  };
}

function expectedContract(value: McpIntegrationDefinition) {
  const tool = value.reviewed.tools[0];
  if (!tool) throw new Error("reviewed Tool fixture missing");
  return mcpToolContract(value.server.id, canonicalHash(value), tool);
}

describe("published MCP Tool contracts", () => {
  it("publishes the same stable identity and exact version used by live registration", () => {
    const value = definition();
    const expected = expectedContract(value);
    const bundle = compileExecutionBundle(request(value));
    const runtime = createRuntimeBundle(bundle, computeBundleDigest(bundle));
    const published = runtime.getById(expected.metadata.id);

    expect(published?.document).toEqual(expected);
    expect(ajv.compile(ToolContractDefinitionSchema)(published?.document)).toBe(true);
    expect(mcpIntegrationsFromBundle(runtime).get("weather")?.mcp).toEqual(value);
    expect(runtime.get("ToolContract", expected.metadata.slug)).toBe(published);
  });

  it.each(["disabled", "unreviewed"] as const)("omits %s server Tools", (state) => {
    const value = definition();
    if (state === "disabled") value.enabled = false;
    else value.reviewed.tools = [];

    const bundle = compileExecutionBundle(request(value));
    expect(bundle.definitions).toEqual([]);
    expect(bundle.assets).toHaveLength(1);
  });

  it("does not turn reviewed resources or prompts into Tools", () => {
    const value = definition();
    value.reviewed.tools = [];
    value.reviewed.resources = [
      {
        name: "Forecast",
        uri: "weather://forecast",
        digest: "b".repeat(64),
      },
    ];
    value.reviewed.prompts = [{ name: "forecast", digest: "c".repeat(64) }];
    expect(compileExecutionBundle(request(value)).definitions).toEqual([]);
  });

  it("derives contracts only from the exact committed snapshot and retains stable IDs", () => {
    const value = definition();
    const committed = request(value);
    const previous = expectedContract(value);
    value.server.label = "Changed after the commit was read";
    value.reviewed.tools = value.reviewed.tools.map((tool) => ({
      ...tool,
      mutating: true,
      requiresApproval: true,
    }));

    const first = compileExecutionBundle(committed);
    const second = compileExecutionBundle({ ...request(value), commitSha: "b".repeat(40) });
    const current = expectedContract(value);
    expect(first.definitions[0]?.document).toEqual(previous);
    expect(second.definitions[0]?.document).toEqual(current);
    expect(current.metadata.id).toBe(previous.metadata.id);
    expect(current.spec.toolVersion).not.toBe(previous.spec.toolVersion);
    expect(Object.isFrozen(first.definitions[0]?.document)).toBe(true);
  });

  it("resolves Routine Tool references against the generated published contracts", () => {
    const value = definition();
    const tool = expectedContract(value);
    const bundle = compileExecutionBundle({
      ...request(value),
      documents: [
        {
          apiVersion: "tulipfarm.ai/v1",
          kind: "Routine",
          metadata: {
            id: "routine-1",
            slug: "daily-weather",
            schemaVersion: 1,
            authoredVersion: 1,
            lifecycle: "published",
          },
          spec: {
            start: "weather",
            states: [
              {
                name: "weather",
                type: "tool",
                toolRef: { name: tool.metadata.slug, version: "latest" },
              },
            ],
          },
        },
      ],
    });
    expect(bundle.definitions.find((item) => item.kind === "Routine")?.references).toEqual([
      {
        field: "/spec/states/0/toolRef",
        kind: "ToolContract",
        id: tool.metadata.id,
        slug: tool.metadata.slug,
        authoredVersion: tool.metadata.authoredVersion,
      },
    ]);
  });

  it("refuses an authored or contributed contract that shadows a generated Tool", () => {
    const value = definition();
    const tool = expectedContract(value);
    expect(() => compileExecutionBundle({ ...request(value), documents: [tool] })).toThrow(
      "collides with an existing ToolContract identity"
    );
    expect(() =>
      compileExecutionBundle({
        ...request(value),
        contributions: [{ source: "another contributor", documents: [tool], files: [] }],
      })
    ).toThrow("collides with an existing ToolContract identity");
  });

  it("fails publication for malformed or duplicate MCP definitions", () => {
    const input = request(definition());
    expect(() =>
      compileExecutionBundle({
        ...input,
        files: [{ path: "integrations/weather/mcp.yaml", content: "server: {}\n" }],
      })
    ).toThrow(BundleError);
    expect(() =>
      compileExecutionBundle({
        ...input,
        files: [...(input.files ?? []), ...(input.files ?? [])],
      })
    ).toThrow("Duplicate MCP definition");
  });
});
