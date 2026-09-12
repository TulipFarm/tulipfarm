import type { OimManifest, OimOperation } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { describeOimCapabilities } from "./review";

function operation(source: OimOperation["source"]): OimOperation {
  return {
    id: "list-items",
    name: "list_items",
    description: "List items.",
    effect: "read",
    identityMode: "shared_only",
    source,
    response: { maxBytes: 1024, schema: { type: "object" } },
  } as OimOperation;
}

function manifest(operation_: OimOperation): OimManifest {
  return {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "items",
      name: "Items",
      version: "1.0.0",
      description: "Items.",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0" },
    operations: [operation_],
  } as OimManifest;
}

describe("describeOimCapabilities GraphQL destinations", () => {
  it("reports a fixed GraphQL source URL as a destination host", () => {
    const review = describeOimCapabilities(
      manifest(
        operation({
          type: "graphql",
          url: "https://api.items.example/graphql",
          operation: "ListItems",
          documentFile: "list-items.graphql",
        })
      )
    );

    expect(review.destinations).toEqual(["api.items.example"]);
    expect(review.operations[0]?.destination).toBe("api.items.example");
  });

  it("shows both a templated GraphQL destination and its bounded host allowlist", () => {
    const input = manifest(
      operation({
        type: "graphql",
        url: "https://{tenant}/graphql",
        operation: "ListItems",
        documentFile: "list-items.graphql",
      })
    );
    input.auth = {
      credentialSlots: [],
      configurationFields: [{ id: "tenant", label: "Tenant", type: "string" }],
      allowedOriginHosts: ["*.items.example"],
      steps: [],
    };

    const review = describeOimCapabilities(input);
    expect(review.destinations).toEqual(["https://{tenant}/graphql"]);
    expect(review.allowedOriginHosts).toEqual(["*.items.example"]);
  });

  it("reports the OpenAPI operation-level server selected ahead of path and document servers", () => {
    const input = manifest(
      operation({
        type: "openapi",
        file: "items.yaml",
        operationId: "listItems",
      })
    );
    const document = {
      openapi: "3.1.0",
      servers: [{ url: "https://document.items.example/v1" }],
      paths: {
        "/items": {
          servers: [{ url: "https://path.items.example/v1" }],
          get: {
            operationId: "listItems",
            servers: [{ url: "https://operation.items.example/v1" }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };

    const review = describeOimCapabilities(input, new Map([["items.yaml", document]]));

    expect(review.destinations).toEqual(["operation.items.example"]);
  });
});
