import { describe, expect, it, vi } from "vitest";
import { importOpenApiAsProposal } from "./openapi";

const DOCUMENT = {
  openapi: "3.1.0",
  info: { title: "Billing API", version: "1.0.0" },
  servers: [{ url: "https://billing.example.com" }],
  paths: {
    "/invoices/{id}": {
      get: {
        operationId: "getInvoice",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            content: {
              "application/json": { schema: { type: "object" } },
            },
          },
        },
      },
    },
  },
};

function dependencies() {
  return {
    proposals: {
      propose: vi.fn(async () => ({ proposalId: "proposal-openapi" })),
    },
    definitionId: () => "018f47a0-12ab-7def-8123-123456789abc",
  };
}

describe("OpenAPI governed import", () => {
  it("turns selected operations into draft pinned ToolContract proposals only", async () => {
    const deps = dependencies();

    const result = await importOpenApiAsProposal(
      {
        changesetId: "changeset-1",
        businessId: "business-1",
        principalId: "user-1",
        expectedBaseCommit: "base-1",
        integrationSlug: "billing",
        document: DOCUMENT,
        selectedOperations: ["getInvoice"],
        allowedDestinations: ["https://billing.example.com"],
      },
      deps
    );

    expect(deps.proposals.propose).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "import",
        activation: "proposal_only",
        requiresApproval: true,
        definitions: [
          expect.objectContaining({
            kind: "ToolContract",
            metadata: expect.objectContaining({ lifecycle: "draft" }),
            spec: expect.objectContaining({
              toolId: "openapi.billing.get-invoice",
              action: "getInvoice",
              allowedDestinations: ["https://billing.example.com"],
              adapter: expect.objectContaining({ kind: "openapi" }),
            }),
          }),
        ],
      })
    );
    expect(result).toEqual({
      proposalId: "proposal-openapi",
      discoveryDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      proposedTools: ["openapi.billing.get-invoice"],
    });
  });

  it("changes the approval-bound digest for a new operation or expanded destination", async () => {
    const deps = dependencies();
    const input = {
      changesetId: "changeset-1",
      businessId: "business-1",
      principalId: "user-1",
      expectedBaseCommit: "base-1",
      integrationSlug: "billing",
      document: DOCUMENT,
      selectedOperations: ["getInvoice"],
      allowedDestinations: ["https://billing.example.com"],
    };
    const first = await importOpenApiAsProposal(input, deps);
    const expandedDocument = {
      ...DOCUMENT,
      paths: {
        ...DOCUMENT.paths,
        "/refunds": {
          post: {
            operationId: "createRefund",
            responses: { "200": { content: { "application/json": { schema: {} } } } },
          },
        },
      },
    };
    const operationDrift = await importOpenApiAsProposal(
      { ...input, changesetId: "changeset-2", document: expandedDocument },
      deps
    );
    const destinationDrift = await importOpenApiAsProposal(
      {
        ...input,
        changesetId: "changeset-3",
        allowedDestinations: ["https://billing.example.com", "https://archive.example.com"],
      },
      deps
    );

    expect(operationDrift.discoveryDigest).not.toBe(first.discoveryDigest);
    expect(destinationDrift.discoveryDigest).not.toBe(first.discoveryDigest);
    expect(deps.proposals.propose).toHaveBeenCalledTimes(3);
  });
});
