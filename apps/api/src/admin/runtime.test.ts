import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeOperationalApi } from "./runtime";

const principal = {
  id: "user-1",
  kind: "user" as const,
  businessId: "tulipfarm-local",
  credential: "session" as const,
  authMethods: ["password"] as const,
  authenticatedAt: new Date(),
  userId: "user-1",
  role: "admin" as const,
};

function request() {
  return { principal } as unknown as FastifyRequest;
}

function runtime() {
  const decide = vi.fn(async () => true);
  const enqueueWake = vi.fn(async () => undefined);
  const listPending = vi.fn(async () => [
    {
      approvalId: "approval-tool",
      toolCallId: "call-1",
      toolName: "send_email",
      args: { recipient: "customer@example.com", body: "private" },
      expiresAt: "2026-07-26T10:00:00.000Z",
      createdAt: "2026-07-26T09:00:00.000Z",
    },
  ]);
  const activity = {
    list: vi.fn(async () => ({
      items: [
        {
          _id: "activity-1",
          category: "integration",
          action: "sync.failed",
          actorType: "system" as const,
          actorId: null,
          targetType: "integration",
          targetId: "crm",
          summary: "CRM sync failed",
          status: "error" as const,
          metadata: { token: "must-not-leak" },
          createdAt: new Date("2026-07-26T08:00:00.000Z"),
        },
      ],
      nextCursor: null,
    })),
  };
  const approvals = {
    listPending: vi.fn(async () => []),
    findById: vi.fn(async () => null),
    settle: vi.fn(async () => undefined),
  };
  const api = createRuntimeOperationalApi({
    activity,
    approvals,
    approvalRegistry: { decide, listPending },
    enqueueWake,
    guardrailsConfig: () => ({ input: { enabled: true } }),
  });
  return { api, decide, enqueueWake };
}

describe("runtime operational API", () => {
  it("authorizes admin reads and Approval decisions without granting unavailable controls", async () => {
    const { api } = runtime();
    const grant = await api.authorize(request());

    expect(grant?.permissions).toContain("operations:read");
    expect(grant?.permissions).toContain("approvals:decide");
    expect(grant?.permissions).not.toContain("operations:control");
    expect(grant?.permissions).not.toContain("runs:control");
  });

  it("projects redacted Operations and Inbox models from live services", async () => {
    const { api } = runtime();
    const grant = await api.authorize(request());
    if (!grant) throw new Error("expected an admin grant");

    const operations = await api.getOperations(grant);
    expect(operations.health).toEqual([{ component: "api", status: "ok" }]);
    expect(operations.incidents).toEqual([
      expect.objectContaining({ id: "activity-1", summary: "CRM sync failed" }),
    ]);
    expect(JSON.stringify(operations)).not.toContain("must-not-leak");

    const inbox = await api.getInbox(grant);
    expect(inbox.items).toEqual([
      expect.objectContaining({
        id: "approval-tool",
        kind: "approval",
        target: "send_email",
        fields: ["body", "recipient"],
        canDecide: true,
      }),
    ]);
    expect(inbox.items[0]?.intentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(inbox)).not.toContain("customer@example.com");
    expect(JSON.stringify(inbox)).not.toContain("private");
  });

  it("settles a live Tool Approval through its owning registry", async () => {
    const { api, decide } = runtime();
    const grant = await api.authorize(request());
    if (!grant) throw new Error("expected an admin grant");

    await expect(
      api.decideApproval(grant, {
        approvalId: "approval-tool",
        decision: "approved",
        idempotencyKey: "decision-1",
      })
    ).resolves.toEqual({
      approvalId: "approval-tool",
      status: "approved",
      decisions: 1,
      requiredDecisions: 1,
    });
    expect(decide).toHaveBeenCalledWith("approval-tool", "approved");
  });
});
