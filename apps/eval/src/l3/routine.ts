import { randomUUID } from "node:crypto";
import {
  createRoutineExecutor,
  DurableEffectRetryWaitHost,
  DurableWaitManager,
  type RoutineRunExecutor,
  RoutineStateScheduler,
  RunInterruptedError,
  RunResumeGateway,
  routineEffectId,
  routineStateDefinitionRef,
  WaitTimerSweeper,
} from "@tulipfarm/run-kernel";
import { MANUAL_REQUEST_SCHEMA_REF } from "@tulipfarm/schema";
import { type PersistedRun, RunStore, WaitStore } from "@tulipfarm/storage";
import {
  AdapterDispatchError,
  BrokerRoutineToolPort,
  PgEffectStore,
  type RoutineToolPort,
  type ToolAdapter,
} from "@tulipfarm/tool-broker";
import { ToolApprovalService } from "@tulipfarm/tool-host";
import type { L3RoutineFixture, RoutineProviderStep } from "../case.ts";
import { openEvalDatabase } from "./database.ts";

export interface L3RoutineResult {
  readonly runStatus: string;
  readonly stateStatus: string;
  readonly stateOutput: Record<string, unknown>;
  readonly toolCalls: readonly {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  }[];
}

class InjectedRoutineCrash extends Error {}

function paddedOutput(step: Extract<RoutineProviderStep, { kind: "success" }>) {
  if (step.paddingBytes === undefined) return step.output;
  const output =
    typeof step.output === "object" && step.output !== null && !Array.isArray(step.output)
      ? step.output
      : { value: step.output };
  return { ...output, padding: "x".repeat(step.paddingBytes) };
}

async function claimRun(runs: RunStore, businessId: string, now: Date, workerId: string) {
  const claimed = await runs.claimNextQueued(businessId, workerId, {
    now: now.toISOString(),
    leaseDurationMs: 60_000,
    limit: 1,
  });
  const claimedRun = claimed[0];
  if (claimed.length !== 1 || claimedRun === undefined) {
    throw new Error("L3 Routine Run was not claimable");
  }
  const moved = await runs.transitionRun(businessId, claimedRun.id, {
    expectedStatus: "claimed",
    expectedVersion: claimedRun.version,
    status: "running",
    startedAt: now.toISOString(),
    leaseOwner: workerId,
    leaseExpiresAt: claimedRun.leaseExpiresAt,
  });
  if (!moved) throw new Error("L3 Routine Run could not start");
  const running = await runs.find(businessId, claimedRun.id);
  if (running === null) throw new Error("L3 Routine Run disappeared after claim");
  return running;
}

async function parkRun(runs: RunStore, run: PersistedRun) {
  const moved = await runs.transitionRun(run.businessId, run.id, {
    expectedVersion: run.version,
    expectedStatus: "running",
    status: "waiting",
    leaseOwner: null,
    leaseExpiresAt: null,
  });
  if (!moved) throw new Error("L3 Routine Run could not park");
}

async function settleRun(runs: RunStore, run: PersistedRun, now: Date) {
  const moved = await runs.transitionRun(run.businessId, run.id, {
    expectedStatus: "running",
    expectedVersion: run.version,
    status: "succeeded",
    finishedAt: now.toISOString(),
    leaseOwner: null,
    leaseExpiresAt: null,
  });
  if (!moved) throw new Error("L3 Routine Run could not settle");
}

export async function runL3Routine(fixture: L3RoutineFixture): Promise<L3RoutineResult> {
  const database = await openEvalDatabase();
  try {
    const businessId = "eval-business";
    const runId = randomUUID();
    const initialNow = new Date("2026-01-01T00:00:00.000Z");
    let now = initialNow;
    const runs = new RunStore(database.transactions);
    const waits = new WaitStore(database.transactions);
    const resume = new RunResumeGateway(runs);
    const durableWaits = new DurableWaitManager(waits, resume);
    const retryWaits = new DurableEffectRetryWaitHost(durableWaits);
    const effects = new PgEffectStore(database.transactions);
    const approvals = new ToolApprovalService({
      transactions: database.transactions,
      now: () => now,
    });
    await database.query(`INSERT INTO users (id, status, role) VALUES ($1, 'active', 'admin')`, [
      "eval-approver",
    ]);

    const providerSteps = [...fixture.providerSteps];
    const toolCalls: Array<{
      readonly name: string;
      readonly arguments: Record<string, unknown>;
    }> = [];
    const tool = fixture.toolContract;
    const routine = fixture.definition;
    const toolState = routine.spec.states.find((state) => state.type === "tool");
    if (toolState === undefined) throw new Error("L3 Routine fixture has no Tool State");
    const bundle = {
      digest: `sha256:${runId}`,
      definitions: [
        { kind: tool.kind, document: tool },
        ...(fixture.guardrail === undefined
          ? []
          : [{ kind: fixture.guardrail.kind, document: fixture.guardrail }]),
      ],
    };
    const adapters = new Map<string, ToolAdapter>([
      [
        tool.spec.adapter.ref,
        {
          kind: tool.spec.adapter.kind,
          dispatch: async (request) => {
            const step = providerSteps.shift();
            toolCalls.push({
              name: tool.spec.toolId,
              arguments: request.intent.arguments as Record<string, unknown>,
            });
            if (step === undefined) {
              throw new Error("L3 Routine provider received an unexpected dispatch");
            }
            if (step.kind === "retry") {
              throw new AdapterDispatchError(
                "before_dispatch",
                step.code ?? "eval_retry",
                true,
                undefined,
                step.retryAfterMs
              );
            }
            return paddedOutput(step);
          },
        },
      ],
    ]);

    await runs.start({
      id: runId,
      businessId,
      source: "routine",
      bundle: {
        digest: bundle.digest,
        routineId: routine.metadata.slug,
        routineVersion: String(routine.metadata.authoredVersion),
      },
      identity: {
        initiator: { kind: "agent", id: "eval" },
        effectiveSubject: { kind: "agent", id: "eval" },
        guardrailContextRef: "eval",
      },
      createdAt: initialNow.toISOString(),
      states: [
        {
          key: routine.spec.start,
          definitionRef: routineStateDefinitionRef(
            {
              digest: bundle.digest,
              routineId: routine.metadata.slug,
              routineVersion: String(routine.metadata.authoredVersion),
            },
            routine.spec.start
          ),
          resolvedInput: { payloadRef: `artifact:${runId}:request` },
        },
      ],
    });

    let crashAfterConfirmation = fixture.crashAfter === "effect_confirmed";
    let replayAfterStateSettlement = fixture.crashAfter === "state_succeeded";
    let approvalId: string | undefined;
    const makeToolPort = (): RoutineToolPort => {
      const broker = new BrokerRoutineToolPort({
        adapters,
        effects,
        approvals,
        parkRetry: retryWaits.parkRetry,
        retryWaitStatus: retryWaits.status,
        assertActive: () => {},
        mutationGuard: { assertAllowed: async () => {} },
        now: () => now,
      });
      return {
        execute: async (request) => {
          const outcome = await broker.execute(request);
          if (crashAfterConfirmation && outcome.kind === "succeeded") {
            crashAfterConfirmation = false;
            throw new InjectedRoutineCrash();
          }
          return outcome;
        },
        replaySettled: (request) => broker.replaySettled(request),
      };
    };
    const makeExecutor = () =>
      createRoutineExecutor({
        definitions: { load: async () => ({ document: routine, bundle }) },
        artifacts: {
          read: async () => ({
            schemaRef: MANUAL_REQUEST_SCHEMA_REF,
            content: { slug: routine.metadata.slug, inputs: fixture.inputs ?? {} },
            contentHash: canonicalFixtureHash(runId),
          }),
        },
        runs,
        scheduler: new RoutineStateScheduler(runs),
        transitions: {
          transition: async (input) => {
            const state = await runs.findState(input.businessId, input.runId, input.stateKey);
            if (state === null || state.status !== input.from) throw new RunInterruptedError();
            const result = await runs.transitionOwnedState(
              input.businessId,
              input.runId,
              input.stateKey,
              input.leaseGeneration,
              {
                expectedVersion: state.version,
                expectedStatus: input.from,
                status: input.to,
                ...(input.to === "running" ? { startedAt: now.toISOString() } : {}),
                ...(input.to === "succeeded" || input.to === "failed"
                  ? { finishedAt: now.toISOString() }
                  : {}),
                ...(input.reason === undefined ? {} : { errorEvidenceRef: input.reason }),
                ...(input.output === undefined ? {} : { output: input.output }),
              }
            );
            if (result !== "transitioned") throw new RunInterruptedError();
          },
        },
        waits: {
          register: (input) => durableWaits.register(input),
          find: (scope, waitId) => waits.find(scope, waitId),
        },
        tools: makeToolPort(),
        toolApprovalWaits: {
          register: async (input) => {
            approvalId = input.approvalId;
            return approvals.registerWait({
              businessId,
              runId: input.runId,
              stateKey: input.stateKey,
              approvalId: input.approvalId,
              subject: { kind: "agent", id: "eval" },
            });
          },
        },
        authority: () => [
          {
            name: "eval",
            grants: [{ action: "*", resourceType: "*", effect: "allow" as const }],
          },
        ],
        now: () => now,
      });

    let run = await claimRun(runs, businessId, now, "eval-worker-1");
    for (let iteration = 0; iteration < 12; iteration += 1) {
      let outcome: Awaited<ReturnType<RoutineRunExecutor>>;
      try {
        outcome = await makeExecutor()(run);
      } catch (error) {
        if (!(error instanceof InjectedRoutineCrash)) throw error;
        outcome = await makeExecutor()(run);
      }

      if (outcome.status === "waiting") {
        await parkRun(runs, run);
        if (approvalId !== undefined) {
          const currentApprovalId = approvalId;
          approvalId = undefined;
          const signaled = await approvals.signal({
            businessId,
            approvalId: currentApprovalId,
            decision: fixture.approval ?? "approved",
            principal: "user:eval-approver",
          });
          if (signaled !== "resumed") {
            throw new Error(`L3 Routine Approval did not resume: ${signaled}`);
          }
        } else {
          const retry = await retryWaits.status(
            businessId,
            routineEffectId(runId, toolState.name),
            1
          );
          const notBefore = retry.status === "pending" ? retry.notBefore : undefined;
          if (notBefore === undefined) throw new Error("L3 Routine retry wait disappeared");
          now = new Date(notBefore);
          await new WaitTimerSweeper(waits, resume).sweep({ businessId, now, limit: 10 });
        }
        run = await claimRun(runs, businessId, now, `eval-worker-${iteration + 2}`);
        continue;
      }

      if (outcome.status !== "succeeded") {
        throw new Error(`L3 Routine failed: ${outcome.status}`);
      }
      if (replayAfterStateSettlement) {
        replayAfterStateSettlement = false;
        const replay = await makeExecutor()(run);
        if (replay.status !== "succeeded") {
          throw new Error(`L3 Routine restart failed: ${replay.status}`);
        }
      }
      await settleRun(runs, run, now);
      break;
    }

    const persistedRun = await runs.find(businessId, runId);
    const toolStateRow = await runs.findState(businessId, runId, toolState.name);
    const outputState = routine.spec.states.find((state) => state.name === "Capture");
    const outputRow =
      outputState === undefined ? null : await runs.findState(businessId, runId, outputState.name);
    const output = outputRow?.resolvedInput.output;
    if (
      persistedRun === null ||
      toolStateRow === null ||
      persistedRun.status !== "succeeded" ||
      typeof output !== "object" ||
      output === null ||
      Array.isArray(output)
    ) {
      throw new Error("L3 Routine result disappeared before observation");
    }
    return {
      runStatus: persistedRun.status,
      stateStatus: toolStateRow.status,
      stateOutput: output as Record<string, unknown>,
      toolCalls,
    };
  } finally {
    await database.close();
  }
}

function canonicalFixtureHash(runId: string): string {
  return `eval-routine-request:${runId}`;
}
