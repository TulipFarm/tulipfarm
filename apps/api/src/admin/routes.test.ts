import { AssetOwnershipError } from "@tulipfarm/authz";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { RequestPrincipal } from "../identity/principal";
import type { RateLimiter } from "../rate-limit";
import {
  type OperationalApiDeps,
  OperationalNotImplementedError,
  type OperationalPermission,
  registerOperationalRoutes,
} from "./routes";

const run = {
  id: "run-1",
  routineId: "routine-1",
  routineVersion: "3",
  status: "attention_required" as const,
  version: 7,
  createdAt: "2026-07-26T00:00:00.000Z",
  startedAt: "2026-07-26T00:00:01.000Z",
  finishedAt: null,
  states: [],
  effects: [],
  waits: [],
  guardrailDecisions: [],
  lineage: [],
  costs: { amountUsd: 0.12, modelTokens: 900 },
};

const adminPrincipal: RequestPrincipal = {
  id: "user-1",
  kind: "user",
  businessId: "business-1",
  credential: "session",
  authMethods: ["password"],
  authenticatedAt: new Date("2026-09-05T00:00:00.000Z"),
  userId: "user-1",
  role: "admin",
};

function deps(overrides: Partial<OperationalApiDeps> = {}): OperationalApiDeps {
  const permissions: OperationalPermission[] = [
    "runs:read",
    "runs:control",
    "operations:read",
    "guardrails:read",
    "guardrails:write",
    "agents:write",
    "approvals:read",
    "approvals:decide",
    "roles:read",
    "roles:write",
    "operations:control",
  ];
  return {
    authorize: async () => ({
      businessId: "business-1",
      principalId: "user-1",
      permissions,
    }),
    listRuns: async () => ({ items: [run], nextCursor: null }),
    getRun: async () => run,
    getRunBudgets: async () => [
      {
        key: "usd_micros",
        limit: 1_000_000,
        consumed: 250_000,
        exhaustionPolicy: "failure_path" as const,
      },
    ],
    commandRun: async (_grant, input) => ({
      commandId: `command-${input.action}`,
      runId: input.runId,
      status: "accepted" as const,
    }),
    getOperations: async () => ({
      health: [],
      incidents: [],
      quarantine: [],
      killSwitches: [],
      activity: [],
      recovery: { supportBundleAvailable: true, lastBackupAt: null },
    }),
    getTeamMigrationReport: async () => ({
      items: [
        {
          legacyGroupId: "Customer Success",
          teamId: "team-1",
          teamSlug: "customer-success",
          displayName: "Customer Success",
          slugConflict: true,
          siblingNameConflict: false,
          migratedAt: "2026-09-05T00:00:00.000Z",
        },
      ],
    }),
    getGuardrails: async () => ({ revision: "guardrail-7", items: [] }),
    proposeGuardrailChangeset: async () => ({
      changesetId: "changeset-1",
      status: "validated" as const,
    }),
    proposeAgentChangeset: async () => ({
      changesetId: "changeset-agent-1",
      candidateVersion: "4",
      status: "awaiting_approval" as const,
    }),
    getInbox: async () => ({ items: [] }),
    decideApproval: async () => ({
      approvalId: "approval-1",
      status: "pending" as const,
      decisions: 1,
      requiredDecisions: 2,
    }),
    getRoles: async () => ({ revision: "roles-1", items: [] }),
    proposeRoleChangeset: async () => ({
      changesetId: "changeset-role-1",
      status: "awaiting_approval" as const,
    }),
    commandOperation: async () => ({
      commandId: "operation-1",
      status: "accepted" as const,
    }),
    ...overrides,
  };
}

async function harness(
  overrides: Partial<OperationalApiDeps> = {},
  rateLimiter?: RateLimiter,
  authenticatedPrincipal: RequestPrincipal = adminPrincipal
) {
  const app = Fastify();
  registerOperationalRoutes(
    app,
    deps(overrides),
    async (request) => {
      request.principal = authenticatedPrincipal;
    },
    rateLimiter
  );
  await app.ready();
  return app;
}

describe("operational API", () => {
  it("returns an authorized Run read model and documents the browser endpoints", async () => {
    const app = await harness();
    const response = await app.inject({ method: "GET", url: "/api/v1/runs/run-1" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ run });
    await app.close();
  });

  it("returns the Run budget ledger from the enforced run_budgets store", async () => {
    const app = await harness();
    const response = await app.inject({ method: "GET", url: "/api/v1/runs/run-1/budgets" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      runId: "run-1",
      budgets: [
        {
          key: "usd_micros",
          limit: 1_000_000,
          consumed: 250_000,
          exhaustionPolicy: "failure_path",
        },
      ],
    });
    await app.close();
  });

  it("returns an empty ledger for a Run that recorded no budgets (unbounded)", async () => {
    const app = await harness({ getRunBudgets: async () => [] });
    const response = await app.inject({ method: "GET", url: "/api/v1/runs/run-1/budgets" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ runId: "run-1", budgets: [] });
    await app.close();
  });

  it("hides another business's Run behind the same 404 as an unknown one", async () => {
    // `getRunBudgets` returns `null` when the Run does not exist for the caller's business, so a
    // guessed `runId` from another tenant is indistinguishable from one that never existed.
    const app = await harness({ getRunBudgets: async () => null });
    const response = await app.inject({ method: "GET", url: "/api/v1/runs/run-other/budgets" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "run_not_found" } });
    await app.close();
  });

  it("rejects an unauthenticated budget read at the auth preHandler", async () => {
    const app = Fastify();
    registerOperationalRoutes(app, deps(), async (_request, reply) => {
      await reply.code(401).send({ error: "authentication required" });
    });
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/api/v1/runs/run-1/budgets" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "authentication required" });
    await app.close();
  });

  it("denies a budget read to a caller without runs:read", async () => {
    const app = await harness({
      authorize: async () => ({
        businessId: "business-1",
        principalId: "user-1",
        permissions: ["operations:read"],
      }),
    });
    const response = await app.inject({ method: "GET", url: "/api/v1/runs/run-1/budgets" });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "forbidden" } });
    await app.close();
  });

  it("fails closed with a safe versioned envelope", async () => {
    const app = await harness({ authorize: vi.fn(async () => null) });
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/operations" });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: {
        version: "1",
        code: "forbidden",
        retryable: false,
      },
    });
    expect(JSON.stringify(response.json())).not.toContain("business-1");
    await app.close();
  });

  it("shows the admin-visible Team migration report", async () => {
    const app = await harness();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/team-migration-report",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        {
          legacyGroupId: "Customer Success",
          teamId: "team-1",
          teamSlug: "customer-success",
          displayName: "Customer Success",
          slugConflict: true,
          siblingNameConflict: false,
          migratedAt: "2026-09-05T00:00:00.000Z",
        },
      ],
    });
    await app.close();
  });

  it("denies the Team migration report to a member with delegated operations.read", async () => {
    const getTeamMigrationReport = vi.fn(deps().getTeamMigrationReport);
    const app = await harness(
      {
        authorize: async () => ({
          businessId: "business-1",
          principalId: "user-2",
          permissions: ["operations:read"],
        }),
        getTeamMigrationReport,
      },
      undefined,
      { ...adminPrincipal, id: "user-2", userId: "user-2", role: "member" }
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/team-migration-report",
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "forbidden" } });
    expect(getTeamMigrationReport).not.toHaveBeenCalled();
    await app.close();
  });

  it("rate-limits operational reads before authorization", async () => {
    const authorize = vi.fn(async () => ({
      businessId: "business-1",
      principalId: "user-1",
      permissions: ["operations:read"] as OperationalPermission[],
    }));
    const rateLimiter: RateLimiter = {
      check: vi.fn(async () => ({
        allowed: false,
        limit: 120,
        remaining: 0,
        resetAt: Date.now() + 60_000,
      })),
    };
    const app = await harness({ authorize }, rateLimiter);

    const response = await app.inject({ method: "GET", url: "/api/v1/admin/operations" });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({ error: "rate_limit_exceeded" });
    expect(authorize).not.toHaveBeenCalled();
    await app.close();
  });

  it("requires an idempotency key and delegates Run commands without changing intent", async () => {
    const commandRun = vi.fn(async (_grant, input) => ({
      commandId: "command-1",
      runId: input.runId,
      status: "accepted" as const,
    }));
    const app = await harness({ commandRun });

    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/runs/run-1/cancel",
      payload: { expectedVersion: 7, reason: "operator request" },
    });
    expect(missing.statusCode).toBe(400);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/runs/run-1/cancel",
      headers: { "idempotency-key": "cancel-run-1-v7" },
      payload: { expectedVersion: 7, reason: "operator request" },
    });
    expect(accepted.statusCode).toBe(202);
    expect(commandRun).toHaveBeenCalledWith(expect.objectContaining({ principalId: "user-1" }), {
      action: "cancel",
      expectedVersion: 7,
      idempotencyKey: "cancel-run-1-v7",
      reason: "operator request",
      runId: "run-1",
    });
    await app.close();
  });

  it("answers 501 for an authorized command this deployment cannot carry out", async () => {
    const app = await harness({
      commandRun: async () => {
        throw new OperationalNotImplementedError("no durable worker is running.");
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/runs/run-1/cancel",
      headers: { "idempotency-key": "cancel-run-1-v7" },
      payload: { expectedVersion: 7, reason: "operator request" },
    });

    expect(response.statusCode).toBe(501);
    expect(response.json().error).toMatchObject({
      version: "1",
      code: "not_implemented",
      message: "no durable worker is running.",
      retryable: false,
    });
    await app.close();
  });

  it("lets a preHandler rejection keep the API-wide error shape", async () => {
    // The shared auth/CSRF preHandlers reject before the handler with `{ error: "reason" }`. If the
    // response schema only allowed the versioned envelope, serialization would fail and an ordinary
    // 403 would reach the operator as a 500.
    const app = Fastify();
    registerOperationalRoutes(app, deps(), async (_request, reply) => {
      await reply.code(403).send({ error: "invalid csrf token" });
    });
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/runs/run-1/cancel",
      headers: { "idempotency-key": "cancel-run-1-v7" },
      payload: { expectedVersion: 7, reason: "operator request" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "invalid csrf token" });
    await app.close();
  });

  it("sends Guardrail edits only through the Soul changeset authority", async () => {
    const proposeGuardrailChangeset = vi.fn(async () => ({
      changesetId: "changeset-1",
      status: "awaiting_approval" as const,
    }));
    const app = await harness({ proposeGuardrailChangeset });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/guardrails/changesets",
      headers: { "idempotency-key": "guardrail-change-1" },
      payload: {
        baseRevision: "guardrail-7",
        changes: [{ op: "replace", path: "/items/0/enabled", value: false }],
      },
    });

    expect(response.statusCode).toBe(202);
    expect(proposeGuardrailChangeset).toHaveBeenCalledWith(
      expect.objectContaining({ principalId: "user-1" }),
      expect.objectContaining({
        baseRevision: "guardrail-7",
        idempotencyKey: "guardrail-change-1",
      })
    );
    await app.close();
  });

  it("sends exact Agent candidates through the Soul publication authority", async () => {
    const proposeAgentChangeset = vi.fn(async () => ({
      changesetId: "changeset-agent-1",
      candidateVersion: "4",
      status: "awaiting_approval" as const,
    }));
    const app = await harness({ proposeAgentChangeset });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agents/support/changesets",
      headers: { "idempotency-key": "publish-support-v4" },
      payload: {
        baseVersion: "3",
        candidateVersion: "4",
        patch: { description: "Updated support Agent" },
      },
    });

    expect(response.statusCode).toBe(202);
    expect(proposeAgentChangeset).toHaveBeenCalledWith(
      expect.objectContaining({ principalId: "user-1" }),
      expect.objectContaining({
        agentId: "support",
        candidateVersion: "4",
        idempotencyKey: "publish-support-v4",
      })
    );
    await app.close();
  });

  it("records a decision for the exact Approval without accepting changed intent", async () => {
    const decideApproval = vi.fn(async () => ({
      approvalId: "approval-1",
      status: "pending" as const,
      decisions: 1,
      requiredDecisions: 2,
    }));
    const app = await harness({ decideApproval });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/approvals/approval-1/decisions",
      headers: { "idempotency-key": "approval-1-user-1-approve" },
      payload: { decision: "approved", comment: "Reviewed exact target" },
    });

    expect(response.statusCode).toBe(200);
    expect(decideApproval).toHaveBeenCalledWith(
      expect.objectContaining({ principalId: "user-1" }),
      {
        approvalId: "approval-1",
        comment: "Reviewed exact target",
        decision: "approved",
        idempotencyKey: "approval-1-user-1-approve",
      }
    );
    expect(response.json()).toMatchObject({ status: "pending", requiredDecisions: 2 });
    await app.close();
  });

  /*
   * Four-eyes refusals reach this route as `AssetOwnershipError`, and an unhandled one is a 500:
   * the browser sees a server fault with no message, so the Approve button reads as broken rather
   * than as refused. The response schema has always declared 403/404/409 for exactly this.
   */
  it.each([
    ["forbidden", 403],
    ["not_found", 404],
    ["already_completed", 409],
  ])("answers a %s ownership refusal with %i and its message", async (reason, status) => {
    const decideApproval = vi.fn(async () => {
      throw new AssetOwnershipError(
        reason as ConstructorParameters<typeof AssetOwnershipError>[0],
        "The proposer cannot approve this operation"
      );
    });
    const app = await harness({ decideApproval });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/approvals/approval-1/decisions",
      headers: { "idempotency-key": "approval-1-user-1-approve" },
      payload: { decision: "approved" },
    });

    expect(response.statusCode).toBe(status);
    expect(response.json().error.message).toBe("The proposer cannot approve this operation");
    await app.close();
  });
});
