import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Queryable } from "../apps/api/src/db";
import { InternalTurnHost } from "../apps/api/src/internal/turn-host";
import { makeMigratedPglite } from "../apps/api/src/test/pglite";
import { createRoutineExecutor } from "../apps/worker/src/routine/executor";
import { BrokerRoutineToolPort } from "../apps/worker/src/routine/tool-port";
import { RunDispatcher } from "../apps/worker/src/run-dispatcher";
import {
  DurableWaitManager,
  RoutineStateScheduler,
  RunLeaseManager,
  RunResumeGateway,
  routineEffectId,
} from "../packages/run-kernel/src";
import { MANUAL_REQUEST_SCHEMA_REF, type routine } from "../packages/schema/src";
import type { RuntimeBundle } from "../packages/soul/src";
import { RunStore, type TransactionPort, WaitStore } from "../packages/storage/src";
import { PgEffectStore, type ToolAdapter } from "../packages/tool-broker/src";
import { ApprovalsRepo, ToolApprovalService } from "../packages/tool-host/src";
import { RunStoreStateTransitions } from "../packages/turn-executor/src";

const BUSINESS_ID = "business-1";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const ROUTINE_ID = "22222222-2222-4222-8222-222222222222";
const SUBJECT = { kind: "agent", id: "assistant" } as const;
const PRINCIPAL = `${SUBJECT.kind}:${SUBJECT.id}`;
const NOW = new Date("2026-09-08T10:00:00.000Z");

const document: routine.RoutineDefinition = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "Routine",
  metadata: {
    id: ROUTINE_ID,
    slug: "approval-tool",
    schemaVersion: 1,
    authoredVersion: 1,
    lifecycle: "published",
  },
  spec: {
    owner: PRINCIPAL,
    start: "Comment",
    states: [
      {
        type: "tool",
        name: "Comment",
        toolRef: { name: "github.issue.comment", version: "1.0.0" },
        action: "issue.comment",
        destination: "github",
        input: { body: "hello" },
        end: true,
      },
    ],
  },
};

const toolContract = {
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
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["body"],
      properties: { body: { type: "string" } },
    },
    outputSchema: { type: "object" },
    riskClass: "medium",
    mutating: true,
    dataClasses: ["source-content"],
    allowedDestinations: ["github"],
    idempotency: { strategy: "provider_key" },
    dryRun: false,
    adapter: { kind: "integration", ref: "github" },
  },
};

const guardrail = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "Guardrail",
  metadata: {
    id: "01J0000000000000000000GUAR",
    slug: "approval",
    schemaVersion: 1,
    authoredVersion: 1,
    lifecycle: "published",
  },
  spec: {
    defaultDecision: "deny",
    rules: [
      {
        id: "allow-comment",
        type: "allow",
        actions: ["issue.comment"],
        dataClasses: ["source-content"],
        destinations: ["github"],
      },
      {
        id: "approve-comment",
        type: "approval",
        actions: ["issue.comment"],
        category: "highRiskAction",
        minimumApprovers: 1,
        separationOfDuties: false,
      },
    ],
  },
};

const bundle = {
  digest: "b".repeat(64),
  businessId: BUSINESS_ID,
  changesetId: "changeset-1",
  commitSha: "c".repeat(40),
  definitions: [
    {
      kind: "ToolContract",
      id: toolContract.metadata.id,
      slug: toolContract.metadata.slug,
      authoredVersion: 1,
      hash: "d".repeat(64),
      document: toolContract,
      references: [],
    },
    {
      kind: "Guardrail",
      id: guardrail.metadata.id,
      slug: guardrail.metadata.slug,
      authoredVersion: 1,
      hash: "e".repeat(64),
      document: guardrail,
      references: [],
    },
  ],
  assets: [],
  get: () => undefined,
  getById: () => undefined,
  asset: () => undefined,
} as unknown as RuntimeBundle;

describe("Routine Tool approval continuation", () => {
  let database: PGlite;
  let transactions: TransactionPort;
  let runs: RunStore;
  let approvals: ToolApprovalService;
  let effects: PgEffectStore;
  const dispatch = vi.fn<ToolAdapter["dispatch"]>(async () => ({ commentId: 7 }));

  beforeEach(async () => {
    database = await makeMigratedPglite();
    transactions = {
      withTransaction: (operation) =>
        database.transaction((transaction) => operation(transaction as unknown as Queryable)),
    };
    runs = new RunStore(transactions);
    approvals = new ToolApprovalService({ transactions, now: () => NOW });
    effects = new PgEffectStore(transactions);
    dispatch.mockClear();

    await runs.start({
      id: RUN_ID,
      businessId: BUSINESS_ID,
      source: "routine",
      bundle: { digest: bundle.digest, routineId: ROUTINE_ID, routineVersion: "1" },
      identity: {
        initiator: SUBJECT,
        effectiveSubject: SUBJECT,
        guardrailContextRef: "guardrail:default",
      },
      createdAt: NOW.toISOString(),
      states: [
        {
          key: "Comment",
          definitionRef: `${bundle.digest}#/states/Comment`,
          resolvedInput: { payloadRef: `artifact:${RUN_ID}:request` },
        },
      ],
    });
  });

  afterEach(async () => {
    await database.close();
  });

  it("resumes the same State occurrence and executes its authorized effect once", async () => {
    const waits = new DurableWaitManager(new WaitStore(transactions), new RunResumeGateway(runs));
    const apiHost = new InternalTurnHost({
      runs,
      store: { findTurnByRunId: async () => undefined } as never,
      context: {} as never,
      tools: {} as never,
      approvals: {
        registerWait: (authority, input) =>
          approvals.registerWait({
            businessId: authority.businessId,
            runId: authority.runId,
            stateKey: input.stateKey,
            approvalId: input.approvalId,
            subject: authority.subject,
          }),
      },
    });
    const executor = createRoutineExecutor({
      definitions: { load: async () => ({ document, bundle }) },
      artifacts: {
        read: async () => ({
          schemaRef: MANUAL_REQUEST_SCHEMA_REF,
          content: { slug: "approval-tool", inputs: {} },
          contentHash: "request-hash",
        }),
      },
      runs,
      scheduler: new RoutineStateScheduler(runs),
      transitions: new RunStoreStateTransitions(runs),
      waits,
      toolApprovalWaits: {
        register: ({ runId, stateKey, approvalId }) =>
          apiHost.registerApprovalWait(BUSINESS_ID, runId, { stateKey, approvalId }),
      },
      tools: new BrokerRoutineToolPort({
        effects,
        approvals,
        adapters: new Map([["github", { kind: "integration", dispatch }]]),
        now: () => NOW,
      }),
      now: () => NOW,
    });
    const dispatcher = new RunDispatcher({
      leases: new RunLeaseManager(runs),
      businessId: BUSINESS_ID,
      owner: "worker-1",
      handler: executor,
      onWaiting: async (run) => {
        await waits.resumeIfUnblocked(BUSINESS_ID, run.id);
      },
      now: () => NOW,
    });

    expect(await dispatcher.dispatchBatch()).toEqual({
      reclaimed: 0,
      requeuedParked: 0,
      claimed: 1,
      dispatched: 0,
      waiting: 1,
      failed: 0,
    });
    expect(await runs.find(BUSINESS_ID, RUN_ID)).toMatchObject({ status: "waiting" });
    expect(await runs.findState(BUSINESS_ID, RUN_ID, "Comment")).toMatchObject({
      key: "Comment",
      status: "waiting",
    });

    const approval = await new ApprovalsRepo(database).findPendingByRun(RUN_ID);
    if (approval === null) throw new Error("Routine Tool did not create an approval");
    await approvals.signal({
      businessId: BUSINESS_ID,
      approvalId: approval.id,
      decision: "approved",
      principal: PRINCIPAL,
    });
    expect(await runs.find(BUSINESS_ID, RUN_ID)).toMatchObject({ status: "queued" });

    expect(await dispatcher.dispatchBatch()).toMatchObject({ waiting: 0, dispatched: 1 });
    expect(await runs.find(BUSINESS_ID, RUN_ID)).toMatchObject({ status: "succeeded" });
    expect(await runs.findState(BUSINESS_ID, RUN_ID, "Comment")).toMatchObject({
      key: "Comment",
      status: "succeeded",
    });
    expect(await runs.listStates(BUSINESS_ID, RUN_ID)).toHaveLength(1);
    expect(await effects.get(BUSINESS_ID, routineEffectId(RUN_ID, "Comment"))).toMatchObject({
      state: "confirmed",
      approvalId: approval.id,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);

    const restarted = new ToolApprovalService({ transactions, now: () => NOW });
    expect(
      await restarted.signal({
        businessId: BUSINESS_ID,
        approvalId: approval.id,
        decision: "approved",
        principal: PRINCIPAL,
      })
    ).toBe("resumed");
    expect(await runs.find(BUSINESS_ID, RUN_ID)).toMatchObject({ status: "succeeded" });
    expect(await dispatcher.dispatchBatch()).toMatchObject({ claimed: 0, dispatched: 0 });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
