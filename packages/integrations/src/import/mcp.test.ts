import { describe, expect, it, vi } from "vitest";
import { GovernedImportError, importMcpAsProposal } from "./mcp";

const SOURCE = {
  serverId: "billing",
  protocolVersion: "2025-03-26",
  transport: { kind: "stdio" as const, command: "billing-mcp", args: ["--safe"] },
};

function dependencies() {
  return {
    discovery: {
      discover: vi.fn(async () => ({
        tools: [
          {
            name: "invoice_get",
            description: "Read an invoice",
            inputSchema: { type: "object", properties: { id: { type: "string" } } },
            outputSchema: { type: "object" },
            readOnlyHint: true,
          },
          {
            name: "invoice_refund",
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
          },
        ],
      })),
    },
    proposals: {
      propose: vi.fn(async () => ({ proposalId: "proposal-1" })),
    },
    definitionId: () => "018f47a0-12ab-7def-8123-123456789abc",
  };
}

describe("MCP governed import", () => {
  it("discovers with an empty environment and proposes only explicitly selected pinned Tools", async () => {
    const deps = dependencies();

    const result = await importMcpAsProposal(
      {
        changesetId: "changeset-1",
        businessId: "business-1",
        principalId: "user-1",
        expectedBaseCommit: "base-1",
        source: SOURCE,
        selectedTools: ["invoice_get"],
        allowedDestinations: ["billing"],
      },
      deps
    );

    expect(deps.discovery.discover).toHaveBeenCalledWith({
      source: SOURCE,
      environment: {},
    });
    expect(deps.proposals.propose).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "changeset-1",
        source: "discovery",
        activation: "proposal_only",
        requiresApproval: true,
        definitions: [
          expect.objectContaining({
            kind: "ToolContract",
            metadata: expect.objectContaining({ lifecycle: "draft" }),
            spec: expect.objectContaining({
              toolId: "mcp.billing.invoice_get",
              adapter: expect.objectContaining({ kind: "mcp" }),
            }),
          }),
        ],
      })
    );
    expect(result).toEqual({
      proposalId: "proposal-1",
      discoveryDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      proposedTools: ["mcp.billing.invoice_get"],
    });
    expect(JSON.stringify(deps.proposals.propose.mock.calls)).not.toMatch(
      /"enabled"|"connect"|"register"/
    );
  });

  it("makes all-tools autoenable impossible", async () => {
    const deps = dependencies();

    await expect(
      importMcpAsProposal(
        {
          changesetId: "changeset-1",
          businessId: "business-1",
          principalId: "user-1",
          expectedBaseCommit: "base-1",
          source: SOURCE,
          selectedTools: [],
          allowedDestinations: ["billing"],
        },
        deps
      )
    ).rejects.toEqual(new GovernedImportError("explicit_selection_required"));
    expect(deps.discovery.discover).not.toHaveBeenCalled();
    expect(deps.proposals.propose).not.toHaveBeenCalled();
  });

  it("emits a new approval-bound digest when the discovered schema drifts", async () => {
    const deps = dependencies();
    const input = {
      changesetId: "changeset-1",
      businessId: "business-1",
      principalId: "user-1",
      expectedBaseCommit: "base-1",
      source: SOURCE,
      selectedTools: ["invoice_get"],
      allowedDestinations: ["billing"],
    };
    const first = await importMcpAsProposal(input, deps);
    vi.mocked(deps.discovery.discover).mockResolvedValue({
      tools: [
        {
          name: "invoice_get",
          description: "Read an invoice",
          inputSchema: { type: "object", properties: { id: { type: "number" } } },
          outputSchema: { type: "object" },
          readOnlyHint: true,
        },
      ],
    });

    const drifted = await importMcpAsProposal({ ...input, changesetId: "changeset-2" }, deps);

    expect(drifted.discoveryDigest).not.toBe(first.discoveryDigest);
    expect(deps.proposals.propose).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "changeset-2", requiresApproval: true })
    );
  });
});
