import { PGlite } from "@electric-sql/pglite";
import {
  AgentLoop,
  type AgentLoopCheckpoint,
  InMemoryLoopCheckpointStore,
  type ModelInvocationResult,
  type ToolDispatchPort,
} from "@tulipfarm/agent-runtime";
import {
  type ArtifactService,
  RunRecoveryManager,
  type TargetedRunRecoveryStore,
} from "@tulipfarm/run-kernel";
import { textContent } from "@tulipfarm/schema";
import {
  DISPATCH_HANDLER_ERROR_REF,
  DISPATCH_REQUEUED_ONCE_REF,
  type PersistedRun,
  type TransactionPort,
} from "@tulipfarm/storage";
import { EFFECT_STORAGE_STATEMENTS, type EffectStore, PgEffectStore } from "@tulipfarm/tool-broker";
import {
  defineApiTool,
  defineParkableApiTool,
  err,
  InMemoryToolCatalog,
  ok,
  type ParkableToolCallResult,
  parked,
  RegistryToolDispatcher,
  type RequestContext,
  type ToolApprovalPort,
  type TurnAuthority,
  toToolDef,
} from "@tulipfarm/tool-host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BUSINESS_ID = "tulipfarm-local";
const RUN_ID = "00000000-0000-4000-8000-000000000001";
const AUTHORITY: TurnAuthority = {
  businessId: BUSINESS_ID,
  runId: RUN_ID,
  subject: { kind: "user", id: "user-1" },
  source: "routine",
  bundleDigest: "sha256:bundle",
};
const CALL = {
  callId: "write-1",
  name: "local_write",
  arguments: { value: "kept" },
};

describe("Worker local Tool effect replay", () => {
  let database: PGlite;
  let transactions: TransactionPort;

  beforeEach(async () => {
    database = new PGlite();
    for (const statement of EFFECT_STORAGE_STATEMENTS) await database.exec(statement);
    transactions = { withTransaction: (operation) => database.transaction(operation) };
  });

  afterEach(async () => {
    await database.close();
  });

  function dispatcher(
    effects: EffectStore,
    execute: (arguments_: unknown) => Promise<ReturnType<typeof ok> | ReturnType<typeof err>>,
    options: {
      readonly requiresApproval?: boolean;
      readonly approvals?: ToolApprovalPort;
    } = {}
  ): RegistryToolDispatcher {
    const catalog = new InMemoryToolCatalog();
    catalog.register(
      toToolDef(
        defineApiTool<RequestContext>({
          name: "local_write",
          description: "writes local state",
          tier: "platform",
          mutating: true,
          idempotency: "reconcile",
          ...(options.requiresApproval === true ? { requiresApproval: true } : {}),
          inputSchema: {
            type: "object",
            required: ["value"],
            additionalProperties: false,
            properties: { value: { type: "string" } },
          },
          authorization: {
            action: "platform.local.write",
            resources: ["platform.local"],
            dataClasses: ["operational"],
          },
          handler: async (arguments_) => execute(arguments_),
        }),
        (context) => context
      )
    );
    return new RegistryToolDispatcher({
      registry: catalog,
      artifacts: {
        read: async () => {
          throw new Error("no chat request");
        },
      } as unknown as ArtifactService,
      effects,
      ...(options.approvals === undefined ? {} : { approvals: options.approvals }),
    });
  }

  function childDispatcher(
    execute: (args: unknown, ctx: RequestContext) => Promise<ParkableToolCallResult>
  ): RegistryToolDispatcher {
    const catalog = new InMemoryToolCatalog();
    catalog.register(
      toToolDef(
        defineParkableApiTool<RequestContext>({
          name: "delegate_to_agent",
          description: "delegate work",
          tier: "platform",
          mutating: true,
          idempotency: "reconcile",
          inputSchema: { type: "object", additionalProperties: false },
          authorization: {
            action: "platform.agent.delegate",
            resources: ["platform.agent"],
            dataClasses: ["operational"],
          },
          handler: execute,
        }),
        (context) => context
      )
    );
    return new RegistryToolDispatcher({
      registry: catalog,
      artifacts: {
        read: async () => {
          throw new Error("no chat request");
        },
      } as unknown as ArtifactService,
      effects: new PgEffectStore(transactions),
    });
  }

  async function recoverWith(effects: EffectStore): Promise<void> {
    let recoveredRun: PersistedRun = {
      id: RUN_ID,
      businessId: BUSINESS_ID,
      source: "chat",
      bundle: { digest: "digest", routineId: "chat", routineVersion: "1" },
      identity: {
        initiator: { kind: "user", id: "user-1" },
        effectiveSubject: { kind: "user", id: "user-1" },
        guardrailContextRef: "guardrail-1",
      },
      status: "needs_reconciliation",
      version: 3,
      createdAt: "2026-09-12T00:00:00.000Z",
      startedAt: "2026-09-12T00:00:01.000Z",
      finishedAt: null,
      resultArtifactId: null,
      errorEvidenceRef: DISPATCH_HANDLER_ERROR_REF,
      leaseOwner: null,
      leaseExpiresAt: null,
      leaseGeneration: 1,
    };
    const recoveryStore: TargetedRunRecoveryStore = {
      find: async () => recoveredRun,
      listRecoveryCandidates: async () => [recoveredRun],
      requeueParkedRun: async (_businessId, _runId, expectedVersion) => {
        if (recoveredRun.version !== expectedVersion) return null;
        recoveredRun = {
          ...recoveredRun,
          status: "queued",
          version: recoveredRun.version + 1,
          errorEvidenceRef: DISPATCH_REQUEUED_ONCE_REF,
        };
        return recoveredRun;
      },
    };
    await expect(
      new RunRecoveryManager(recoveryStore, effects).reconcile({
        businessId: BUSINESS_ID,
        runId: RUN_ID,
        expectedVersion: 3,
      })
    ).resolves.toMatchObject({ outcome: "requeued" });
  }

  it("returns the confirmed result after process reconstruction without executing again", async () => {
    const execute = vi.fn(async () => ok({ stored: true }));
    const first = dispatcher(new PgEffectStore(transactions), execute);

    expect(await first.dispatch(AUTHORITY, CALL)).toEqual({
      status: "succeeded",
      output: { stored: true },
    });

    const reconstructed = dispatcher(new PgEffectStore(transactions), execute);
    expect(await reconstructed.dispatch(AUTHORITY, CALL)).toEqual({
      status: "succeeded",
      replayed: true,
      output: { stored: true },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("blocks an ambiguous mutation after process reconstruction", async () => {
    const execute = vi.fn(async () => {
      throw new Error("connection disappeared after send");
    });
    const first = dispatcher(new PgEffectStore(transactions), execute);

    expect(await first.dispatch(AUTHORITY, CALL)).toMatchObject({ status: "failed" });

    const reconstructed = dispatcher(new PgEffectStore(transactions), execute);
    const replay = await reconstructed.dispatch(AUTHORITY, CALL);

    expect(replay).toMatchObject({ status: "failed" });
    expect(replay.status === "failed" && replay.reason).toContain("awaiting reconciliation");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("returns a stored terminal failure after process reconstruction", async () => {
    const execute = vi.fn(async () => err("write_denied", "read only"));
    const first = dispatcher(new PgEffectStore(transactions), execute);

    expect(await first.dispatch(AUTHORITY, CALL)).toMatchObject({
      status: "failed",
      code: "write_denied",
    });

    const reconstructed = dispatcher(new PgEffectStore(transactions), execute);
    expect(await reconstructed.dispatch(AUTHORITY, CALL)).toEqual({
      status: "failed",
      reason: 'tool "local_write" already ran and failed',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rechecks authority but does not spend a second approval for a confirmed replay", async () => {
    const execute = vi.fn(async () => ok({ stored: true }));
    const first = dispatcher(new PgEffectStore(transactions), execute, {
      requiresApproval: true,
      approvals: {
        decide: vi.fn(async () => ({ status: "approved" as const, approvalId: "approval-1" })),
        consume: vi.fn(async () => true),
      },
    });
    await first.dispatch(AUTHORITY, CALL);

    const replayDecide = vi.fn(async () => ({
      status: "pending" as const,
      approvalId: "approval-2",
    }));
    const reconstructed = dispatcher(new PgEffectStore(transactions), execute, {
      requiresApproval: true,
      approvals: { decide: replayDecide, consume: vi.fn(async () => false) },
    });

    expect(await reconstructed.dispatch(AUTHORITY, CALL)).toEqual({
      status: "succeeded",
      replayed: true,
      output: { stored: true },
    });
    expect(replayDecide).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("re-enters only a durably parked child call and stores its final answer", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce(parked({ kind: "child_run", childRunId: "child-1", waitId: "wait-1" }))
      .mockResolvedValueOnce(ok({ answer: "finished once" }));
    const call = { callId: "delegate-1", name: "delegate_to_agent", arguments: {} };

    await expect(childDispatcher(execute).dispatch(AUTHORITY, call)).resolves.toEqual({
      status: "awaiting_child",
      childRunId: "child-1",
      waitId: "wait-1",
    });
    await expect(childDispatcher(execute).dispatch(AUTHORITY, call)).resolves.toEqual({
      status: "succeeded",
      output: { answer: "finished once" },
    });
    await expect(childDispatcher(execute).dispatch(AUTHORITY, call)).resolves.toEqual({
      status: "succeeded",
      replayed: true,
      output: { answer: "finished once" },
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it.each(["authorized", "dispatched"] as const)(
    "adopts the same parked child after reconstruction from %s",
    async (crashState) => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce(
          parked({ kind: "child_run", childRunId: "child-1", waitId: "wait-1" })
        )
        .mockResolvedValueOnce(ok({ answer: "finished once" }));
      const call = { callId: "delegate-1", name: "delegate_to_agent", arguments: {} };
      const effects = new PgEffectStore(transactions);

      await expect(childDispatcher(execute).dispatch(AUTHORITY, call)).resolves.toMatchObject({
        status: "awaiting_child",
      });
      const [effect] = await effects.list(BUSINESS_ID);
      expect(effect).toBeDefined();
      await effects.transition({
        businessId: BUSINESS_ID,
        effectId: effect?.effectId ?? "",
        expectedStates: ["awaiting_child"],
        state: "authorized",
        updatedAt: "2026-09-12T00:00:02.000Z",
      });
      if (crashState === "dispatched") {
        await effects.beginAttempt(BUSINESS_ID, effect?.effectId ?? "", "2026-09-12T00:00:03.000Z");
      }

      await recoverWith(effects);
      await expect(childDispatcher(execute).dispatch(AUTHORITY, call)).resolves.toEqual({
        status: "succeeded",
        output: { answer: "finished once" },
      });
      expect(execute).toHaveBeenCalledTimes(2);
    }
  );

  it("resumes the real AgentLoop batch against the durable ledger", async () => {
    class CrashAfterFirstResultStore extends InMemoryLoopCheckpointStore {
      private crashed = false;

      override async save(checkpoint: AgentLoopCheckpoint): Promise<void> {
        if (!this.crashed && checkpoint.resume?.pendingBatch?.nextCallIndex === 1) {
          this.crashed = true;
          throw new Error("process crashed after the first write");
        }
        await super.save(checkpoint);
      }
    }

    const checkpoints = new CrashAfterFirstResultStore();
    const executed: string[] = [];
    const execute = vi.fn(async (arguments_: unknown) => {
      executed.push((arguments_ as { value: string }).value);
      return ok({ stored: true });
    });
    const port = (host: RegistryToolDispatcher): ToolDispatchPort => ({
      dispatch: async (call) => ({
        ...(await host.dispatch(AUTHORITY, {
          callId: call.callId,
          name: call.name,
          arguments: call.arguments,
        })),
        callId: call.callId,
      }),
    });
    const result = (
      output: ModelInvocationResult["output"],
      requestId: string
    ): ModelInvocationResult => ({
      requestId,
      output,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const loop = (
      modelResults: readonly ModelInvocationResult[],
      tools: ToolDispatchPort
    ): AgentLoop => {
      const queue = [...modelResults];
      return new AgentLoop({
        model: {
          invoke: async () => {
            const next = queue.shift();
            if (next === undefined) throw new Error("unexpected model request");
            return next;
          },
        },
        tools,
        checkpoints,
        events: { append: async () => {} },
        budget: { consume: async () => ({ outcome: "allowed" }) },
        isCancelled: async () => false,
      });
    };
    const input = {
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      stateId: "state-1",
      modelProfileId: "primary",
      contextDigest: "sha256:context",
      guardrailDigest: "sha256:guardrail",
      messages: [{ role: "user" as const, content: textContent("write both values") }],
      tools: [
        {
          name: "local_write",
          inputSchema: { type: "object", required: ["value"] },
          mutating: true,
        },
      ],
      limits: { maxIterations: 3, maxToolCalls: 3, maxRepairAttempts: 1 },
    };

    await expect(
      loop(
        [
          result(
            {
              kind: "tool_calls",
              calls: [
                { callId: "write-1", name: "local_write", arguments: { value: "one" } },
                { callId: "write-2", name: "local_write", arguments: { value: "two" } },
              ],
            },
            "request-1"
          ),
        ],
        port(dispatcher(new PgEffectStore(transactions), execute))
      ).run(input)
    ).rejects.toThrow("process crashed after the first write");

    await recoverWith(new PgEffectStore(transactions));

    const outcome = await loop(
      [result({ kind: "text", text: "done" }, "request-2")],
      port(dispatcher(new PgEffectStore(transactions), execute))
    ).run(input);

    expect(outcome).toMatchObject({ status: "completed", toolCalls: 2 });
    expect(executed).toEqual(["one", "two"]);
  });
});
