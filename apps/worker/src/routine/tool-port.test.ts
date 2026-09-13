import { PGlite } from "@electric-sql/pglite";
import type { AuthorityLayer } from "@tulipfarm/authz";
import type { ToolDispatchPlan } from "@tulipfarm/run-kernel";
import {
  canonicalHash,
  type GuardrailDefinition,
  type ToolContractDefinition,
} from "@tulipfarm/schema";
import type { BundleDefinition, RuntimeBundle } from "@tulipfarm/soul";
import type { TransactionPort } from "@tulipfarm/storage";
import {
  AdapterDispatchError,
  EFFECT_STORAGE_STATEMENTS,
  intentDigest,
  MemoryEffectStore,
  normalizeToolIntent,
  PgEffectStore,
  type ToolAdapter,
  type ToolAdapterRequest,
} from "@tulipfarm/tool-broker";
import type { ToolApprovalPort } from "@tulipfarm/tool-host";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { GITHUB_INSTALLATION_SECRET_REF, githubInstallationSecretRef } from "./github-credentials";
import { BrokerRoutineToolPort, type RoutineToolRequest } from "./tool-port";

const BUSINESS_ID = "biz-1";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const STATE_KEY = "CommentIssue";
const REQUESTER_PRINCIPAL_ID = "user:33333333-3333-4333-8333-333333333333";

const PLAN: ToolDispatchPlan = {
  toolRef: { name: "github.issue.comment", version: "1.0.0" },
  action: "issue.comment",
  destination: "github",
  arguments: { body: "hello" },
  idempotencyKey: `routine:${RUN_ID}:${STATE_KEY}`,
  effectId: "22222222-2222-4222-8222-222222222222",
  logicalEffectOrdinal: 3,
};

/** The Routine's authority: it may act on the Tools it declares, and nothing here widens that. */
const AUTHORITY: readonly AuthorityLayer[] = [
  { name: "routine", grants: [{ action: "*", resourceType: "*", effect: "allow" }] },
];

function contract(overrides: Partial<ToolContractDefinition["spec"]> = {}): ToolContractDefinition {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "ToolContract",
    metadata: {
      id: "01J0000000000000000000TOOL",
      slug: "github-issue-comment",
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "published",
      publishedDigest: "a".repeat(64),
    },
    spec: {
      toolId: "github.issue.comment",
      toolVersion: "1.0.0",
      action: "issue.comment",
      inputSchema: { type: "object", properties: { body: { type: "string" } } },
      outputSchema: { type: "object", properties: { commentId: { type: "number" } } },
      riskClass: "medium",
      mutating: true,
      dataClasses: ["source-content"],
      allowedDestinations: ["github"],
      idempotency: { strategy: "provider_key" },
      dryRun: false,
      adapter: { kind: "integration", ref: "github" },
      ...overrides,
    },
  } as ToolContractDefinition;
}

function guardrail(rules: unknown[]): GuardrailDefinition {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "Guardrail",
    metadata: {
      id: "01J0000000000000000000GUAR",
      slug: "triage",
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "published",
    },
    spec: { defaultDecision: "deny", rules },
  } as GuardrailDefinition;
}

const ALLOW_COMMENT = {
  id: "allow-comment",
  type: "allow",
  actions: ["issue.comment"],
  dataClasses: ["source-content"],
  destinations: ["github"],
};

function bundle(documents: readonly { kind: string; document: unknown }[]): RuntimeBundle {
  const definitions = documents.map((entry, index) => ({
    kind: entry.kind,
    id: `def-${index}`,
    slug: `def-${index}`,
    authoredVersion: 1,
    hash: "b".repeat(64),
    document: entry.document,
    references: [],
  })) as unknown as readonly BundleDefinition[];

  return {
    digest: "c".repeat(64),
    businessId: BUSINESS_ID,
    changesetId: "changeset-1",
    commitSha: "d".repeat(40),
    definitions,
    assets: [],
    get: (kind, slug) => definitions.find((d) => d.kind === kind && d.slug === slug),
    getById: (id) => definitions.find((d) => d.id === id),
    asset: () => undefined,
  };
}

function request(overrides: Partial<RoutineToolRequest> = {}): RoutineToolRequest {
  return {
    businessId: BUSINESS_ID,
    runId: RUN_ID,
    stateKey: STATE_KEY,
    claim: { leaseOwner: "worker-1", leaseGeneration: 1 },
    plan: PLAN,
    requesterPrincipalId: REQUESTER_PRINCIPAL_ID,
    bundle: bundle([
      { kind: "ToolContract", document: contract() },
      { kind: "Guardrail", document: guardrail([ALLOW_COMMENT]) },
    ]),
    authorityLayers: AUTHORITY,
    ...overrides,
  };
}

let effects: MemoryEffectStore;
let dispatch: Mock<ToolAdapter["dispatch"]>;
let adapters: Map<string, ToolAdapter>;
let decide: Mock<ToolApprovalPort["decide"]>;
let consume: Mock<ToolApprovalPort["consume"]>;
let findIntent: Mock<NonNullable<ToolApprovalPort["findIntent"]>>;

beforeEach(() => {
  effects = new MemoryEffectStore();
  dispatch = vi.fn<ToolAdapter["dispatch"]>(async (_request: ToolAdapterRequest) => ({
    commentId: 12,
  }));
  adapters = new Map<string, ToolAdapter>([["github", { kind: "integration" as const, dispatch }]]);
  decide = vi.fn<ToolApprovalPort["decide"]>();
  consume = vi.fn<ToolApprovalPort["consume"]>();
  findIntent = vi.fn(async () => (await effects.get(BUSINESS_ID, PLAN.effectId))?.intent);
});

function port(): BrokerRoutineToolPort {
  return new BrokerRoutineToolPort({
    effects,
    adapters,
    approvals: { decide, consume, findIntent },
  });
}

describe("BrokerRoutineToolPort", () => {
  it("authorizes against the Run's pinned policy, reserves the effect, then dispatches", async () => {
    expect(await port().execute(request())).toEqual({
      kind: "succeeded",
      output: { commentId: 12 },
    });

    const effect = await effects.get(BUSINESS_ID, PLAN.effectId);
    expect(effect?.state).toBe("confirmed");
    expect(effect?.runId).toBe(RUN_ID);
    expect(effect?.stateId).toBe(STATE_KEY);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("resolves bundle-scoped adapters from the exact Routine request", async () => {
    const adaptersFor = vi.fn(
      (_input: RoutineToolRequest): ReadonlyMap<string, ToolAdapter> =>
        new Map([["github", { kind: "integration" as const, dispatch }]])
    );
    const dynamic = new BrokerRoutineToolPort({
      effects,
      adapters: new Map(),
      adaptersFor,
      approvals: { decide, consume },
    });

    const input = request();
    expect(await dynamic.execute(input)).toEqual({
      kind: "succeeded",
      output: { commentId: 12 },
    });
    expect(adaptersFor).toHaveBeenCalledWith(input);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("records the pinned bundle digest as the guardrail revision the effect was decided under", async () => {
    const input = request();
    await port().execute(input);

    const effect = await effects.get(BUSINESS_ID, PLAN.effectId);
    expect(effect?.guardrailRevision).toBe(input.bundle.digest);
  });

  it("never reaches an adapter when policy denies the intent", async () => {
    const denied = request({
      bundle: bundle([
        { kind: "ToolContract", document: contract() },
        { kind: "Guardrail", document: guardrail([{ ...ALLOW_COMMENT, type: "deny" }]) },
      ]),
    });

    expect(await port().execute(denied)).toEqual({ kind: "failed", reason: "guardrail_denied" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(await effects.get(BUSINESS_ID, PLAN.effectId)).toBeUndefined();
  });

  it("authorizes from the bundle's own ToolContract alone, even with no external authority layers", async () => {
    expect(await port().execute(request({ authorityLayers: [] }))).toEqual({
      kind: "succeeded",
      output: { commentId: 12 },
    });
  });

  // Contracts that declare no target keep the coarser Tool-granular decision; that is the one
  // legitimate empty target list, and it is not the same as a target we could not work out.
  it("decides at Tool granularity when the contract declares no target of its own", async () => {
    expect(await port().execute(request())).toEqual({
      kind: "succeeded",
      output: { commentId: 12 },
    });

    const dispatched = dispatch.mock.calls[0]?.[0];
    expect(dispatched?.intent.arguments).not.toEqual({});
    expect(dispatched?.intent.targetRefs).toEqual([]);
  });

  it("still denies when an external layer explicitly denies, even though the bundle's own contract allows", async () => {
    const denied = request({
      authorityLayers: [
        {
          name: "external",
          grants: [
            {
              action: "issue.comment",
              resourceType: "Tool",
              recordSelector: "github.issue.comment",
              effect: "deny",
            },
          ],
        },
      ],
    });

    expect(await port().execute(denied)).toEqual({
      kind: "failed",
      reason: "authorization_denied",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("creates an ordinary Tool approval bound to the pinned Guardrail decision", async () => {
    decide.mockResolvedValue({ status: "pending", approvalId: "approval-1" });
    const gated = request({
      bundle: bundle([
        { kind: "ToolContract", document: contract() },
        {
          kind: "Guardrail",
          document: guardrail([
            ALLOW_COMMENT,
            {
              id: "approve-comment",
              type: "approval",
              actions: ["issue.comment"],
              category: "highRiskAction",
              minimumApprovers: 1,
              separationOfDuties: false,
            },
          ]),
        },
      ]),
    });

    expect(await port().execute(gated)).toEqual({
      kind: "awaiting_approval",
      reason: "approval_required",
      approvalId: "approval-1",
    });
    expect(decide).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      toolCallId: PLAN.effectId,
      toolName: PLAN.toolRef.name,
      args: PLAN.arguments,
      requesterPrincipalId: REQUESTER_PRINCIPAL_ID,
      demand: {
        demandedBy: "guardrail_rule",
        guardrailRevision: gated.bundle.digest,
        reason: "approval_required",
        ruleId: "approve-comment",
      },
      intent: expect.objectContaining({
        businessId: BUSINESS_ID,
        runId: RUN_ID,
        stateId: STATE_KEY,
      }),
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("consumes the approval and executes a replayed State effect exactly once", async () => {
    decide.mockResolvedValue({ status: "approved", approvalId: "approval-1" });
    consume.mockResolvedValueOnce(true);
    const gated = request({
      bundle: bundle([
        { kind: "ToolContract", document: contract() },
        {
          kind: "Guardrail",
          document: guardrail([
            ALLOW_COMMENT,
            {
              id: "approve-comment",
              type: "approval",
              actions: ["issue.comment"],
              category: "highRiskAction",
              minimumApprovers: 1,
              separationOfDuties: false,
            },
          ]),
        },
      ]),
    });
    const subject = port();

    expect(await subject.execute(gated)).toEqual({
      kind: "succeeded",
      output: { commentId: 12 },
    });
    expect(await subject.execute(gated)).toEqual({
      kind: "succeeded",
      output: { commentId: 12 },
    });

    expect(consume).toHaveBeenCalledWith({
      approvalId: "approval-1",
      toolCallId: PLAN.effectId,
    });
    expect(consume).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]?.[0]).toMatchObject({
      intent: {
        businessId: BUSINESS_ID,
        runId: RUN_ID,
        stateId: STATE_KEY,
        idempotencyKey: PLAN.idempotencyKey,
      },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await effects.get(BUSINESS_ID, PLAN.effectId)).toMatchObject({
      state: "confirmed",
      approvalId: "approval-1",
    });
  });

  it("fails closed when the exact approval cannot be consumed", async () => {
    decide.mockResolvedValue({ status: "approved", approvalId: "approval-1" });
    consume.mockResolvedValue(false);
    findIntent.mockImplementation(async () => decide.mock.calls[0]?.[0].intent);
    const gated = request({
      bundle: bundle([
        { kind: "ToolContract", document: contract() },
        {
          kind: "Guardrail",
          document: guardrail([
            ALLOW_COMMENT,
            {
              id: "approve-comment",
              type: "approval",
              actions: ["issue.comment"],
              category: "highRiskAction",
              minimumApprovers: 1,
              separationOfDuties: false,
            },
          ]),
        },
      ]),
    });

    await expect(port().execute(gated)).resolves.toEqual({
      kind: "failed",
      reason: "approval_not_consumable",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("binds the prepared OIM Connection, destination, and Files before approval", async () => {
    decide.mockResolvedValue({ status: "pending", approvalId: "approval-oim" });
    const remoteDispatch = vi.fn(async () => ({ messageId: "msg-1" }));
    const oim = {
      prepare: vi.fn(async () => ({
        kind: "ready" as const,
        arguments: { body: { upload: "file-1" } },
        adapterRef: "oim-acme",
        adapter: { kind: "native" as const, dispatch: remoteDispatch },
        hostCredentials: true as const,
        filePrincipalId: REQUESTER_PRINCIPAL_ID.slice("user:".length),
        fileIds: ["file-1"],
        integrationId: "acme",
        integrationMajorVersion: 2,
        operationId: "send_message",
        manifestDigest: "m".repeat(64),
        configurationDigest: "f".repeat(64),
        destination: "https://api.acme.test",
        credentialRef: "secret://connections/connection-1/token",
        connection: {
          connectionId: "connection-1",
          integrationId: "acme",
          integrationMajorVersion: 2,
          operationId: "send_message",
          credentialSlot: "token",
          credentialRevision: "revision-1",
          identityMode: "shared_only" as const,
          principalKind: "user",
          principalId: REQUESTER_PRINCIPAL_ID.slice("user:".length),
          manifestDigest: "m".repeat(64),
          configurationDigest: "f".repeat(64),
        },
      })),
    };
    const oimPlan = {
      ...PLAN,
      toolRef: { name: "oim.acme.v2.send_message", version: "2.0.0" },
      action: "message.send",
      destination: undefined,
      arguments: {
        connection_id: "connection-1",
        body: { upload: "file-1" },
      },
    };
    const gated = request({
      plan: oimPlan,
      bundle: bundle([
        {
          kind: "ToolContract",
          document: contract({
            toolId: oimPlan.toolRef.name,
            toolVersion: oimPlan.toolRef.version,
            action: oimPlan.action,
            adapter: { kind: "native", ref: "oim-acme" },
            allowedDestinations: ["https://api.acme.test"],
            inputSchema: { type: "object" },
          }),
        },
        {
          kind: "Guardrail",
          document: guardrail([
            {
              ...ALLOW_COMMENT,
              actions: [oimPlan.action],
              destinations: ["https://api.acme.test"],
            },
            {
              id: "approve-message",
              type: "approval",
              actions: [oimPlan.action],
              category: "highRiskAction",
              minimumApprovers: 1,
              separationOfDuties: false,
            },
          ]),
        },
      ]),
    });

    await expect(
      new BrokerRoutineToolPort({
        effects,
        adapters: new Map(),
        approvals: { decide, consume, findIntent },
        oim,
      }).execute(gated)
    ).resolves.toMatchObject({ kind: "awaiting_approval", approvalId: "approval-oim" });

    expect(decide.mock.calls[0]?.[0].intent).toMatchObject({
      arguments: { body: { upload: "file-1" } },
      fileIds: ["file-1"],
      destination: "https://api.acme.test",
      integrationId: "acme",
      operationId: "send_message",
      connection: {
        connectionId: "connection-1",
        credentialRevision: "revision-1",
      },
    });
    expect(await effects.get(BUSINESS_ID, PLAN.effectId)).toBeUndefined();
    expect(remoteDispatch).not.toHaveBeenCalled();
  });

  it("parks provider retries durably and resumes the same effect only after the wait", async () => {
    const retryingDispatch = vi
      .fn<ToolAdapter["dispatch"]>()
      .mockRejectedValueOnce(
        new AdapterDispatchError("before_dispatch", "rate_limited", true, undefined, 30_000)
      )
      .mockResolvedValueOnce({ commentId: 12 });
    let waitStatus: "pending" | "ready" = "pending";
    const parkRetry = vi.fn(async () => ({ waitId: "retry-wait-1" }));
    const subject = new BrokerRoutineToolPort({
      effects,
      adapters: new Map([["github", { kind: "integration" as const, dispatch: retryingDispatch }]]),
      approvals: { decide, consume, findIntent },
      parkRetry,
      retryWaitStatus: async () => ({
        status: waitStatus,
        waitId: "retry-wait-1",
        notBefore: "2026-09-07T06:30:30.000Z",
      }),
      now: () => new Date("2026-09-07T06:30:00.000Z"),
    });
    const retrying = request({
      bundle: bundle([
        {
          kind: "ToolContract",
          document: contract({ retry: { maxAttempts: 2, safeToRetry: true } }),
        },
        { kind: "Guardrail", document: guardrail([ALLOW_COMMENT]) },
      ]),
    });

    await expect(subject.execute(retrying)).resolves.toMatchObject({
      kind: "waiting",
      waitId: "retry-wait-1",
      attempt: 1,
    });
    await expect(subject.execute(retrying)).resolves.toMatchObject({
      kind: "waiting",
      waitId: "retry-wait-1",
      attempt: 1,
    });
    expect(retryingDispatch).toHaveBeenCalledTimes(1);

    waitStatus = "ready";
    await expect(subject.execute(retrying)).resolves.toEqual({
      kind: "succeeded",
      output: { commentId: 12 },
    });
    expect(retryingDispatch).toHaveBeenCalledTimes(2);
    expect(parkRetry).toHaveBeenCalledTimes(1);
  });

  it("fails closed after a denied or expired approval without reserving an effect", async () => {
    decide.mockResolvedValue({ status: "denied", reason: "approval request timed out" });
    const gated = request({
      bundle: bundle([
        { kind: "ToolContract", document: contract() },
        {
          kind: "Guardrail",
          document: guardrail([
            ALLOW_COMMENT,
            {
              id: "approve-comment",
              type: "approval",
              actions: ["issue.comment"],
              category: "highRiskAction",
              minimumApprovers: 1,
              separationOfDuties: false,
            },
          ]),
        },
      ]),
    });

    expect(await port().execute(gated)).toEqual({
      kind: "failed",
      reason: "approval request timed out",
    });
    expect(consume).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await effects.get(BUSINESS_ID, PLAN.effectId)).toBeUndefined();
  });

  it("replays a confirmed effect instead of dispatching it a second time", async () => {
    const subject = port();
    await subject.execute(request());

    expect(await subject.execute(request())).toEqual({
      kind: "succeeded",
      output: { commentId: 12 },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("replays the exact stored output after a database-backed port restart", async () => {
    const database = new PGlite();
    try {
      for (const statement of EFFECT_STORAGE_STATEMENTS) await database.query(statement);
      const transactions: TransactionPort = {
        withTransaction: (operation) => database.transaction(operation),
      };
      const first = new BrokerRoutineToolPort({
        effects: new PgEffectStore(transactions),
        adapters,
        approvals: { decide, consume },
      });

      await expect(first.execute(request())).resolves.toEqual({
        kind: "succeeded",
        output: { commentId: 12 },
      });
      const restarted = new BrokerRoutineToolPort({
        effects: new PgEffectStore(transactions),
        adapters,
        approvals: { decide, consume },
      });
      await expect(restarted.execute(request())).resolves.toEqual({
        kind: "succeeded",
        output: { commentId: 12 },
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      await database.close();
    }
  });

  it("validates a settled Tool against the confirmed effect without dispatching", async () => {
    const largeOutput = { payload: "x".repeat(129 * 1024) };
    dispatch.mockResolvedValueOnce(largeOutput);
    const first = port();
    await expect(first.execute(request())).resolves.toEqual({
      kind: "succeeded",
      output: largeOutput,
    });

    await expect(port().replaySettled(request())).resolves.toEqual({
      kind: "succeeded",
      output: largeOutput,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not reserve or dispatch when settled effect evidence is absent", async () => {
    await expect(port().replaySettled(request())).resolves.toEqual({
      kind: "unavailable",
      reason: "effect_not_found",
    });
    expect(await effects.list(BUSINESS_ID)).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("quarantines an unconfirmed effect found behind a settled Tool State", async () => {
    await effects.reserve({
      effectId: PLAN.effectId,
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      stateId: STATE_KEY,
      logicalEffectOrdinal: PLAN.logicalEffectOrdinal,
      idempotencyKey: PLAN.idempotencyKey,
      intentDigest: intentDigest(
        normalizeToolIntent({
          intentId: PLAN.effectId,
          businessId: BUSINESS_ID,
          runId: RUN_ID,
          stateId: STATE_KEY,
          toolId: PLAN.toolRef.name,
          toolVersion: PLAN.toolRef.version,
          action: PLAN.action,
          targetRefs: [],
          arguments: PLAN.arguments,
          principalKind: "user",
          principalId: REQUESTER_PRINCIPAL_ID.slice("user:".length),
          destination: PLAN.destination,
          idempotencyKey: PLAN.idempotencyKey,
        })
      ),
      intent: normalizeToolIntent({
        intentId: PLAN.effectId,
        businessId: BUSINESS_ID,
        runId: RUN_ID,
        stateId: STATE_KEY,
        toolId: PLAN.toolRef.name,
        toolVersion: PLAN.toolRef.version,
        action: PLAN.action,
        targetRefs: [],
        arguments: PLAN.arguments,
        principalKind: "user",
        principalId: REQUESTER_PRINCIPAL_ID.slice("user:".length),
        destination: PLAN.destination,
        idempotencyKey: PLAN.idempotencyKey,
      }),
      guardrailRevision: request().bundle.digest,
      createdAt: "2026-09-13T00:00:00.000Z",
    });

    await expect(port().replaySettled(request())).resolves.toEqual({
      kind: "unavailable",
      reason: "effect_not_confirmed",
    });
    expect(await effects.get(BUSINESS_ID, PLAN.effectId)).toMatchObject({
      state: "reconciliation_required",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("replays an explicit null output after a database-backed port restart", async () => {
    const database = new PGlite();
    try {
      for (const statement of EFFECT_STORAGE_STATEMENTS) await database.query(statement);
      const transactions: TransactionPort = {
        withTransaction: (operation) => database.transaction(operation),
      };
      dispatch.mockResolvedValue(null);
      const nullRequest = request({
        bundle: bundle([
          {
            kind: "ToolContract",
            document: contract({ outputSchema: { type: "null" } }),
          },
          { kind: "Guardrail", document: guardrail([ALLOW_COMMENT]) },
        ]),
      });

      await expect(
        new BrokerRoutineToolPort({
          effects: new PgEffectStore(transactions),
          adapters,
          approvals: { decide, consume },
        }).execute(nullRequest)
      ).resolves.toEqual({ kind: "succeeded", output: null });
      await expect(
        new BrokerRoutineToolPort({
          effects: new PgEffectStore(transactions),
          adapters,
          approvals: { decide, consume },
        }).execute(nullRequest)
      ).resolves.toEqual({ kind: "succeeded", output: null });
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      await database.close();
    }
  });

  it("parks a confirmed legacy effect when no output evidence exists", async () => {
    const database = new PGlite();
    try {
      for (const statement of EFFECT_STORAGE_STATEMENTS) await database.query(statement);
      const transactions: TransactionPort = {
        withTransaction: (operation) => database.transaction(operation),
      };
      await new BrokerRoutineToolPort({
        effects: new PgEffectStore(transactions),
        adapters,
        approvals: { decide, consume },
      }).execute(request());
      await database.query(
        "UPDATE effect_records SET output_stored = false, output = NULL WHERE effect_id = $1",
        [PLAN.effectId]
      );

      await expect(
        new BrokerRoutineToolPort({
          effects: new PgEffectStore(transactions),
          adapters,
          approvals: { decide, consume },
        }).execute(request())
      ).resolves.toEqual({
        kind: "unavailable",
        reason: "confirmed_effect_output_unavailable",
      });
      expect(await new PgEffectStore(transactions).get(BUSINESS_ID, PLAN.effectId)).toMatchObject({
        state: "reconciliation_required",
        outputStored: false,
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      await database.close();
    }
  });

  it.each([
    {
      name: "stored output no longer matches the confirmed attempt digest",
      corrupt: async (database: PGlite) => {
        await database.query(
          `UPDATE effect_records
              SET output = '{"commentId":13}'::jsonb
            WHERE effect_id = $1`,
          [PLAN.effectId]
        );
      },
    },
    {
      name: "the confirmed attempt is missing",
      corrupt: async (database: PGlite) => {
        await database.query("DELETE FROM effect_attempts WHERE effect_id = $1", [PLAN.effectId]);
      },
    },
    {
      name: "the confirmed attempt digest is missing",
      corrupt: async (database: PGlite) => {
        await database.query(
          "UPDATE effect_attempts SET output_digest = NULL WHERE effect_id = $1",
          [PLAN.effectId]
        );
      },
    },
    {
      name: "the stored output violates the pinned contract schema",
      corrupt: async (database: PGlite) => {
        const output = "not-a-comment";
        await database.query("UPDATE effect_records SET output = $2::jsonb WHERE effect_id = $1", [
          PLAN.effectId,
          JSON.stringify(output),
        ]);
        await database.query("UPDATE effect_attempts SET output_digest = $2 WHERE effect_id = $1", [
          PLAN.effectId,
          canonicalHash(output),
        ]);
      },
    },
  ])("quarantines confirmed evidence when $name", async ({ corrupt }) => {
    const database = new PGlite();
    try {
      for (const statement of EFFECT_STORAGE_STATEMENTS) await database.query(statement);
      const transactions: TransactionPort = {
        withTransaction: (operation) => database.transaction(operation),
      };
      const effects = new PgEffectStore(transactions);
      const subject = new BrokerRoutineToolPort({
        effects,
        adapters,
        approvals: { decide, consume },
      });
      await subject.execute(request());
      await corrupt(database);

      await expect(subject.replaySettled(request())).resolves.toEqual({
        kind: "unavailable",
        reason: "effect_evidence_invalid",
      });
      expect(await effects.get(BUSINESS_ID, PLAN.effectId)).toMatchObject({
        state: "reconciliation_required",
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      await database.close();
    }
  });

  it("queues corrupt confirmed effect evidence for reconciliation without redispatching", async () => {
    const database = new PGlite();
    try {
      for (const statement of EFFECT_STORAGE_STATEMENTS) await database.query(statement);
      const transactions: TransactionPort = {
        withTransaction: (operation) => database.transaction(operation),
      };
      const stored = new BrokerRoutineToolPort({
        effects: new PgEffectStore(transactions),
        adapters,
        approvals: { decide, consume },
      });
      await stored.execute(request());
      await database.query(
        "UPDATE tool_intents SET normalized_intent = normalized_intent - 'toolId' WHERE intent_id = $1",
        [PLAN.effectId]
      );

      await expect(stored.execute(request())).resolves.toEqual({
        kind: "unavailable",
        reason: "effect_evidence_invalid",
      });
      expect(await new PgEffectStore(transactions).get(BUSINESS_ID, PLAN.effectId)).toMatchObject({
        state: "reconciliation_required",
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      await database.close();
    }
  });

  it("does not quarantine a valid confirmed effect when another call changes arguments", async () => {
    const subject = port();
    await subject.execute(request());

    await expect(
      subject.execute(
        request({
          plan: {
            ...PLAN,
            arguments: { body: "different" },
          },
        })
      )
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "effect_binding_mismatch",
    });
    expect(await effects.get(BUSINESS_ID, PLAN.effectId)).toMatchObject({
      state: "confirmed",
      output: { commentId: 12 },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("parks an ambiguous effect, which only reconciliation may resolve", async () => {
    dispatch.mockRejectedValue(
      new AdapterDispatchError("after_dispatch", "provider_timeout", false)
    );

    expect(await port().execute(request())).toEqual({
      kind: "unavailable",
      reason: "effect_ambiguous",
    });
    expect((await effects.get(BUSINESS_ID, PLAN.effectId))?.state).toBe("ambiguous");
  });

  it("parks when no adapter is registered for the contract's provider", async () => {
    adapters = new Map();

    expect(await port().execute(request())).toEqual({
      kind: "unavailable",
      reason: "adapter_not_found",
    });
  });

  it("parks when the pinned bundle names no contract for the Tool the State references", async () => {
    const missing = request({
      bundle: bundle([{ kind: "Guardrail", document: guardrail([ALLOW_COMMENT]) }]),
    });

    expect(await port().execute(missing)).toEqual({
      kind: "failed",
      reason: "unknown_contract",
    });
  });

  it("parks a Guardrail this deployment cannot express exactly, rather than dropping the rule", async () => {
    const unsupported = request({
      bundle: bundle([
        { kind: "ToolContract", document: contract() },
        {
          kind: "Guardrail",
          document: guardrail([{ ...ALLOW_COMMENT, constraints: { maxBytes: 1024 } }]),
        },
      ]),
    });

    expect(await port().execute(unsupported)).toEqual({
      kind: "unavailable",
      reason: "guardrail_unsupported_constraint",
    });
  });

  it("refuses a destination the contract does not allow", async () => {
    const elsewhere = request({ plan: { ...PLAN, destination: "slack" } });

    expect(await port().execute(elsewhere)).toEqual({
      kind: "failed",
      reason: "destination_denied",
    });
  });

  it("refuses arguments the contract's input schema rejects", async () => {
    const malformed = request({ plan: { ...PLAN, arguments: { body: 12 } } });

    expect(await port().execute(malformed)).toEqual({
      kind: "failed",
      reason: "invalid_arguments",
    });
  });
});

/**
 * L3-3: the port used to hardcode `targetRefs: []`, so a grant that authorized one Ticket had to
 * authorize every Ticket. Targets now come from the pinned ToolContract's own declaration.
 */
describe("BrokerRoutineToolPort contract-declared targets", () => {
  const TARGETED: Partial<ToolContractDefinition["spec"]> = {
    requiredResources: ["github.issue"],
    targets: [{ type: "github.issue", id: "{repository}#{issueNumber}" }],
  };

  const ISSUE_ARGUMENTS = { repository: "tulip/farm", issueNumber: 42, body: "hello" };

  function targetedRequest(overrides: Partial<RoutineToolRequest> = {}): RoutineToolRequest {
    return request({
      plan: { ...PLAN, arguments: ISSUE_ARGUMENTS },
      bundle: bundle([
        { kind: "ToolContract", document: contract(TARGETED) },
        { kind: "Guardrail", document: guardrail([ALLOW_COMMENT]) },
      ]),
      ...overrides,
    });
  }

  function operatorLayer(recordSelector: string): readonly AuthorityLayer[] {
    return [
      {
        name: "operator",
        grants: [
          {
            action: "issue.comment",
            resourceType: "github.issue",
            recordSelector,
            effect: "allow",
          },
        ],
      },
    ];
  }

  it("carries the object the arguments name into the intent the gate and ledger see", async () => {
    expect(await port().execute(targetedRequest())).toEqual({
      kind: "succeeded",
      output: { commentId: 12 },
    });

    const expected = [{ type: "github.issue", id: "tulip/farm#42" }];
    expect(dispatch.mock.calls[0]?.[0].intent.targetRefs).toEqual(expected);
    expect((await effects.get(BUSINESS_ID, PLAN.effectId))?.intent.targetRefs).toEqual(expected);
  });

  it("lets a grant scoped to exactly that object authorize the call", async () => {
    const scoped = targetedRequest({ authorityLayers: operatorLayer("tulip/farm#42") });

    expect(await port().execute(scoped)).toEqual({
      kind: "succeeded",
      output: { commentId: 12 },
    });
  });

  it("refuses the same call under a grant scoped to a different object", async () => {
    const elsewhere = targetedRequest({ authorityLayers: operatorLayer("tulip/farm#7") });

    expect(await port().execute(elsewhere)).toEqual({
      kind: "failed",
      reason: "authorization_denied",
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(await effects.get(BUSINESS_ID, PLAN.effectId)).toBeUndefined();
  });

  it("refuses rather than falls back to an empty target when an argument names nothing", async () => {
    const missing = targetedRequest({
      plan: { ...PLAN, arguments: { repository: "tulip/farm", body: "hello" } },
    });

    expect(await port().execute(missing)).toEqual({
      kind: "failed",
      reason: "target_unresolved",
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(await effects.get(BUSINESS_ID, PLAN.effectId)).toBeUndefined();
  });

  it("refuses a declared target no required resource covers, so no grant floor governs it", async () => {
    const undeclared = targetedRequest({
      bundle: bundle([
        {
          kind: "ToolContract",
          document: contract({ ...TARGETED, requiredResources: ["github.repository"] }),
        },
        { kind: "Guardrail", document: guardrail([ALLOW_COMMENT]) },
      ]),
    });

    expect(await port().execute(undeclared)).toEqual({
      kind: "failed",
      reason: "target_type_undeclared",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("refuses when deriving would drop a required resource from the decision", async () => {
    const dropped = targetedRequest({
      bundle: bundle([
        {
          kind: "ToolContract",
          document: contract({
            ...TARGETED,
            requiredResources: ["github.issue", "github.repository"],
          }),
        },
        { kind: "Guardrail", document: guardrail([ALLOW_COMMENT]) },
      ]),
    });

    expect(await port().execute(dropped)).toEqual({
      kind: "failed",
      reason: "target_drops_resource",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("refuses a derived id that would read as a grant wildcard", async () => {
    const wildcard = targetedRequest({
      bundle: bundle([
        {
          kind: "ToolContract",
          document: contract({ ...TARGETED, targets: [{ type: "github.issue", id: "{scope}" }] }),
        },
        { kind: "Guardrail", document: guardrail([ALLOW_COMMENT]) },
      ]),
      plan: { ...PLAN, arguments: { ...ISSUE_ARGUMENTS, scope: "*" } },
    });

    expect(await port().execute(wildcard)).toEqual({ kind: "failed", reason: "target_invalid" });
    expect(dispatch).not.toHaveBeenCalled();
  });
});

/** Bare GitHub refs must be narrowed before reservation, so effect and credential agree. */
describe("BrokerRoutineToolPort GitHub credential scoping", () => {
  async function reservedIntent(plan: ToolDispatchPlan) {
    const port = new BrokerRoutineToolPort({
      effects,
      adapters,
      approvals: { decide, consume },
    });
    await port.execute(request({ plan }));
    const effect = await effects.get(BUSINESS_ID, plan.effectId);
    if (effect === undefined) throw new Error("effect not reserved");
    return effect.intent;
  }

  it("scopes an authored bare ref to the repository the arguments name", async () => {
    const intent = await reservedIntent({
      ...PLAN,
      arguments: { repository: "tulip/farm", body: "hello" },
      credentialRef: GITHUB_INSTALLATION_SECRET_REF,
    });
    expect(intent.credentialRef).toBe(
      githubInstallationSecretRef({ kind: "repository", repository: "tulip/farm" })
    );
  });

  it("scopes to the account when only an owner is named", async () => {
    const intent = await reservedIntent({
      ...PLAN,
      arguments: { owner: "tulip", name: "new-repo" },
      credentialRef: GITHUB_INSTALLATION_SECRET_REF,
    });
    expect(intent.credentialRef).toBe(
      githubInstallationSecretRef({ kind: "account", owner: "tulip" })
    );
  });

  it("leaves an already-scoped authored ref alone", async () => {
    const authored = githubInstallationSecretRef({ kind: "account", owner: "acme" });
    const intent = await reservedIntent({
      ...PLAN,
      arguments: { repository: "tulip/farm", body: "hello" },
      credentialRef: authored,
    });
    expect(intent.credentialRef).toBe(authored);
  });

  it("leaves a non-GitHub ref alone", async () => {
    const intent = await reservedIntent({
      ...PLAN,
      arguments: { repository: "tulip/farm", body: "hello" },
      credentialRef: "secret://integrations/slack/bot-token",
    });
    expect(intent.credentialRef).toBe("secret://integrations/slack/bot-token");
  });

  it("leaves the bare ref alone when the arguments name no installation", async () => {
    const intent = await reservedIntent({
      ...PLAN,
      arguments: { body: "hello" },
      credentialRef: GITHUB_INSTALLATION_SECRET_REF,
    });
    expect(intent.credentialRef).toBe(GITHUB_INSTALLATION_SECRET_REF);
  });
});
