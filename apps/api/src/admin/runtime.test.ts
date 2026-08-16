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
  const signal = vi.fn(async () => "resumed" as const);
  const enqueueWake = vi.fn(async () => undefined);
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
  // Both kinds are read from the one authoritative table; nothing in this process holds them.
  const approvals = {
    listPending: vi.fn(async (kind?: string) =>
      kind === "tool_call"
        ? [
            {
              id: "approval-tool",
              kind: "tool_call" as const,
              status: "pending" as const,
              payload: {
                toolCallId: "call-1",
                toolName: "send_email",
                args: { recipient: "customer@example.com", body: "private" },
              },
              expiresAt: new Date("2026-07-26T10:00:00.000Z"),
              createdAt: new Date("2026-07-26T09:00:00.000Z"),
              resolvedAt: null,
              consumedAt: null,
              consumedByCallId: null,
            },
          ]
        : []
    ),
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
    budgets: vi.fn(async (_businessId: string, runId: string) =>
      runId === "run-1"
        ? [
            {
              key: "usd_micros",
              limit: 1_000_000,
              consumed: 250_000,
              exhaustionPolicy: "failure_path" as const,
            },
          ]
        : null
    ),
  };
  const api = createRuntimeOperationalApi({
    activity,
    approvals,
    toolApprovals: { signal },
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
  return { api, signal, enqueueWake, runs };
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
    // Per-action, not a blanket `deny any action on secret`. `GET /api/v1/secrets/status` is
    // guarded by `requireAuth` alone (only PUT and DELETE check `role !== "admin"`), so a member
    // really can list secret metadata. The old blanket deny made this view claim otherwise — the
    // exact way the Roles page "starts lying about who can do what" that `identity/roles.ts` warns
    // about.
    expect(roles.items[1]?.grants).toContain("allow secret.read on secret");
    expect(roles.items[1]?.grants).toContain("deny secret.write on secret");
    expect(roles.items[1]?.grants).toContain("deny secret.delete on secret");
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

  it("settles a Tool Approval by signalling the wait its Run parked on", async () => {
    const { api, signal } = runtime();
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
    // The deciding administrator is named to the kernel, which checks it again under the wait's
    // lock — the operational API never decides on someone else's behalf.
    expect(signal).toHaveBeenCalledWith({
      businessId: "tulipfarm-local",
      approvalId: "approval-tool",
      decision: "approved",
      principal: "user:user-1",
    });
  });
});
