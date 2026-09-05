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

function runtime(withOwnershipApproval = false) {
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
              requesterPrincipalId: null,
              guardrailEvidence: null,
              guardrailEvidenceDigest: null,
              approverPrincipalId: null,
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
    ...(withOwnershipApproval
      ? {
          ownershipApprovals: {
            listApprovals: vi.fn(async () => [
              {
                approvalId: "ownership-1",
                operationId: "ownership-1",
                assetType: "agent" as const,
                assetId: "support",
                action: "delete" as const,
                risk: "high" as const,
                preview: "delete agent support",
                riskSummary: "Changes shared asset ownership or lifecycle",
                status: "pending" as const,
                requiredTeamIds: ["team-1"],
                decisions: 0,
                requiredDecisions: 1,
                readyToComplete: false,
                representedTeamId: "team-1",
                canDecide: true,
                expiresAt: "2026-09-06T10:00:00.000Z",
                createdAt: "2026-09-05T10:00:00.000Z",
              },
            ]),
            decide: vi.fn(),
          },
        }
      : {}),
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
    teamMigrationReport: vi.fn(async () => ({
      items: [
        {
          legacyGroupId: "Support Ops",
          teamId: "team-1",
          teamSlug: "support-ops",
          displayName: "Support Ops",
          slugConflict: false,
          siblingNameConflict: false,
          migratedAt: "2026-09-05T10:00:00.000Z",
        },
        {
          legacyGroupId: "Support/Ops",
          teamId: "team-2",
          teamSlug: "support-ops-a1b2c3d4",
          displayName: "Support/Ops",
          slugConflict: true,
          siblingNameConflict: false,
          migratedAt: "2026-09-05T10:00:00.000Z",
        },
        {
          legacyGroupId: "support ops",
          teamId: "team-3",
          teamSlug: "support-ops-2",
          displayName: "Support Ops [a1b2c3d4]",
          slugConflict: false,
          siblingNameConflict: true,
          migratedAt: "2026-09-05T10:00:00.000Z",
        },
      ],
    })),
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

  it("omits Team migrations without slug or sibling-name conflicts", async () => {
    const { api } = runtime();
    const grant = await api.authorize(request());
    if (!grant) throw new Error("expected an admin grant");

    await expect(api.getTeamMigrationReport(grant)).resolves.toEqual({
      items: [
        expect.objectContaining({ legacyGroupId: "Support/Ops", slugConflict: true }),
        expect.objectContaining({ legacyGroupId: "support ops", siblingNameConflict: true }),
      ],
    });
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
    expect(roles.items.map((role) => role.id)).toEqual(["owner", "admin", "member"]);
    expect(roles.revision).toMatch(/^[a-f0-9]{64}$/);
    // Secret actions are absent from the member allow-list rather than spelled as an explicit
    // deny, because a deny would veto any exact secret grants configured on top of member.
    const member = roles.items.find((role) => role.id === "member");
    expect(member?.grants).toContain("allow network.read on network in any domain");
    expect(member?.grants).not.toContain("allow secret.read on secret");
    expect(member?.grants).not.toContain("allow secret.write on secret");
    expect(member?.grants).not.toContain("allow secret.delete on secret");
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

  it("includes ownership Approvals in the company inbox", async () => {
    const { api } = runtime(true);
    const grant = await api.authorize(request());
    if (!grant) throw new Error("expected an admin grant");

    await expect(api.getInbox(grant)).resolves.toEqual({
      items: expect.arrayContaining([
        expect.objectContaining({
          id: "ownership-1",
          target: "agent:support",
          representedTeamId: "team-1",
          canDecide: true,
        }),
      ]),
    });
  });
});
