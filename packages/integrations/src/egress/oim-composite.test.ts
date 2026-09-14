import { type OimManifest, oimManifestIssues, validateOimManifest } from "@tulipfarm/schema";
import type { ToolAdapterRequest } from "@tulipfarm/tool-broker";
import { describe, expect, it } from "vitest";
import type { IntegrationHttpResponse } from "../http";
import { OimCompositeToolAdapter } from "./oim-composite-adapter";
import { compileOimCompositeOperations } from "./oim-composite-compile";
import { OimHttpToolAdapter } from "./oim-http-adapter";
import { compileOimHttpOperations } from "./oim-http-compile";
import type { EgressHttpPort, EgressHttpRequest } from "./openapi-adapter";

class QueuedHttp implements EgressHttpPort {
  readonly requests: EgressHttpRequest[] = [];

  constructor(private readonly responses: readonly IntegrationHttpResponse[]) {}

  async send(request: EgressHttpRequest): Promise<IntegrationHttpResponse> {
    this.requests.push(request);
    const response = this.responses[this.requests.length - 1];
    if (response === undefined) throw new Error("missing response");
    return response;
  }
}

function manifest(): OimManifest {
  return validateOimManifest({
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "directory",
      name: "Directory",
      version: "1.0.0",
      description: "Looks up a person and their profile.",
      license: "Apache-2.0",
    },
    profiles: { core: "1.3" },
    operations: [
      {
        id: "lookup",
        name: "lookup_person",
        description: "Looks up a person.",
        effect: "read",
        identityMode: "shared_only",
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://directory.example",
          path: "/people",
          parameters: [{ name: "email", in: "query", required: true, schema: { type: "string" } }],
        },
        response: {
          schema: {
            type: "object",
            properties: { id: { type: "string" }, token: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
          },
          projection: ["/id"],
          maxBytes: 4096,
        },
      },
      {
        id: "profile",
        name: "read_profile",
        description: "Reads a person profile.",
        effect: "read",
        identityMode: "shared_only",
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://directory.example",
          path: "/people/{id}",
          parameters: [{ name: "id", in: "path", schema: { type: "string" } }],
        },
        response: {
          schema: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
            additionalProperties: false,
          },
          maxBytes: 4096,
        },
      },
      {
        id: "lookup-profile",
        name: "lookup_profile",
        description: "Looks up a person and reads their profile.",
        effect: "read",
        identityMode: "shared_only",
        requestSchema: {
          type: "object",
          properties: { email: { type: "string" } },
          required: ["email"],
          additionalProperties: false,
        },
        source: {
          type: "composite",
          steps: [
            {
              id: "lookup",
              operationId: "lookup",
              bindings: [{ target: "/email", source: { type: "input", pointer: "/email" } }],
            },
            {
              id: "profile",
              operationId: "profile",
              bindings: [
                {
                  target: "/id",
                  source: { type: "step", stepId: "lookup", pointer: "/id" },
                },
              ],
            },
          ],
        },
        response: {
          schema: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
            additionalProperties: false,
          },
          maxBytes: 4096,
        },
      },
    ],
  });
}

function request(): ToolAdapterRequest {
  return {
    intent: {
      intentId: "intent-1",
      businessId: "business-1",
      runId: "run-1",
      stateId: "state-1",
      toolId: "oim.directory.v1.lookup-profile",
      toolVersion: "1.0.0",
      action: "integration.directory.lookup_profile",
      targetRefs: [],
      arguments: { email: "muskan@example.com" },
      idempotencyKey: "effect-1",
    },
    idempotencyKey: "effect-1",
    attempt: 1,
  };
}

describe("OIM composite Tools", () => {
  it("runs declared steps in order and returns only the final output", async () => {
    const input = manifest();
    const http = new QueuedHttp([
      { status: 200, headers: {}, body: { id: "person-1", token: "must-not-leak" } },
      { status: 200, headers: {}, body: { name: "Muskan Vijayvargiya" } },
    ]);
    const leaves = new Map(
      compileOimHttpOperations(input).map((tool) => [
        tool.operation.id,
        { tool, adapter: new OimHttpToolAdapter({ binding: tool.binding, http, manifest: input }) },
      ])
    );
    const composite = compileOimCompositeOperations(input)[0];
    if (composite === undefined) throw new Error("composite was not compiled");
    expect(composite.contract.spec.requiredActions).toEqual([
      "integration.directory.lookup_person",
      "integration.directory.read_profile",
    ]);
    const adapter = new OimCompositeToolAdapter({
      steps: composite.steps.map((step) => {
        const component = leaves.get(step.tool.operation.id);
        if (component === undefined) throw new Error("component was not compiled");
        return { ...step, adapter: component.adapter, contract: component.tool.contract };
      }),
    });

    await expect(adapter.dispatch(request())).resolves.toEqual({ name: "Muskan Vijayvargiya" });
    expect(http.requests.map((item) => item.url)).toEqual([
      "https://directory.example/people?email=muskan%40example.com",
      "https://directory.example/people/person-1",
    ]);
  });

  it("rejects cycles and forward references", () => {
    const input = manifest();
    const composite = input.operations[2];
    if (composite?.source.type !== "composite") throw new Error("composite was not declared");
    composite.source.steps[1] = {
      ...composite.source.steps[1],
      operationId: "lookup-profile",
    };
    composite.source.steps[0] = {
      ...composite.source.steps[0],
      bindings: [
        {
          target: "/email",
          source: { type: "step", stepId: "profile", pointer: "/id" },
        },
      ],
    };
    expect(oimManifestIssues(input)).toEqual(
      expect.arrayContaining([
        "operations: lookup-profile composite step lookup binding references a later or unknown step profile",
        "operations: composite cycle includes lookup-profile",
      ])
    );
  });
});
