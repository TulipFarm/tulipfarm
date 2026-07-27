import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { OperationalNotImplementedError } from "./routes";
import type { RunReader } from "./run-reader";
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
  const run = {
    id: "run-1",
    routineId: "chat",
    routineVersion: "published:chat:1",
    status: "queued",
    version: 0,
    createdAt: "2026-07-26T09:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    states: [],
    effects: [],
    waits: [],
    guardrailDecisions: [],
    lineage: [],
    costs: { amountUsd: 0, modelTokens: 0 },
  };
  const runs: RunReader = {
    list: vi.fn(async () => ({ items: [run], nextCursor: null })),
    get: vi.fn(async (_businessId: string, runId: string) => (runId === "run-1" ? run : null)),
  };
  const api = createRuntimeOperationalApi({
    activity,
    approvals,
    approvalRegistry: { decide, listPending },
    runs,
    healthProbes: [
      { component: "postgres", check: async () => ({ status: "ok" as const }) },
      {
        component: "soul",
        check: async () => {
          throw new Error("soul unreachable");
        },
      },
    ],
    enqueueWake,
    guardrailsConfig: () => ({ input: { enabled: true } }),
  });
  return { api, decide, enqueueWake, runs };
}

describe("runtime operational API", () => {
  it("grants an admin every operational authority, including control", async () => {
    const { api } = runtime();
    const grant = await api.authorize(request());

    expect(grant?.permissions).toContain("operations:read");
    expect(grant?.permissions).toContain("approvals:decide");
    // Absent capabilities are reported as 501, not as a missing permission — an administrator
    // told "forbidden" would go looking for a permission that does not exist.
    expect(grant?.permissions).toContain("operations:control");
    expect(grant?.permissions).toContain("runs:control");
  });

  it("denies a non-admin principal outright", async () => {
    const { api } = runtime();
    const member = { ...principal, role: "member" as const };
    expect(await api.authorize({ principal: member } as unknown as FastifyRequest)).toBeNull();
  });

  it("reads Runs and the deployment role catalog from live authorities", async () => {
    const { api, runs } = runtime();
    const grant = await api.authorize(request());
    if (!grant) throw new Error("expected an admin grant");

    expect(await api.listRuns(grant, { limit: 50 })).toEqual({
      items: [expect.objectContaining({ id: "run-1", routineId: "chat" })],
      nextCursor: null,
    });
    expect(runs.list).toHaveBeenCalledWith("tulipfarm-local", { limit: 50 });
    expect(await api.getRun(grant, "missing")).toBeNull();

    const roles = await api.getRoles(grant);
    expect(roles.items.map((role) => role.id)).toEqual(["admin", "member"]);
    expect(roles.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(roles.items[1]?.grants).toContain("deny any action on secret");
  });

  it("reports an absent capability as not implemented rather than as a failure", async () => {
    const { api } = runtime();
    const grant = await api.authorize(request());
    if (!grant) throw new Error("expected an admin grant");

    await expect(
      api.commandRun(grant, {
        action: "cancel",
        runId: "run-1",
        expectedVersion: 0,
        reason: "operator request",
        idempotencyKey: "command-1",
      })
    ).rejects.toBeInstanceOf(OperationalNotImplementedError);
  });

  it("projects redacted Operations and Inbox models from live services", async () => {
    const { api } = runtime();
    const grant = await api.authorize(request());
    if (!grant) throw new Error("expected an admin grant");

    const operations = await api.getOperations(grant);
    expect(operations.health).toEqual([
      expect.objectContaining({ component: "postgres", status: "ok" }),
      // A probe that throws reports its component down; it never fails the whole page.
      expect.objectContaining({ component: "soul", status: "down", detail: "soul unreachable" }),
    ]);
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
