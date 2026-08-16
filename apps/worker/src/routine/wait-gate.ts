import {
  type CompiledState,
  planApprovalWait,
  planTimerWait,
  type RegisterWaitInput,
  resolveApproval,
  resolveErrorPath,
  routineWaitId,
  type StateStatus,
  type StepOutcome,
  stateOutcome,
} from "@tulipfarm/run-kernel";
import type { PersistedRun, PersistedState, PersistedWait } from "@tulipfarm/storage";
import type { RoutineApprovalPort } from "./approval-port";
import {
  type ChainOutcome,
  CLAIM_PATH,
  RoutineExecutionRefusal,
  WAIT_TIMED_OUT,
} from "./execution-support";

/**
 * The two ways a Routine State stops being this process's problem and later becomes it again:
 * a durable timer, and an approval only a human answers.
 *
 * Both halves of a pair have to agree, so they are kept together. Opening registers the durable
 * record *before* the row is parked, so a worker that dies between the two finds its own wait on
 * replay rather than opening a second one; resuming reads that same record and refuses to invent
 * an answer it does not find, because a missing wait or a missing approval is an operator's
 * question, not a yes.
 */

/** Durable-wait surface; the executor never redeems resume tokens. */
export interface RoutineWaitPort {
  register(input: RegisterWaitInput): Promise<{ readonly wait: PersistedWait }>;
  find(businessId: string, waitId: string): Promise<PersistedWait | null>;
}

/** What the gate needs from the executor; the executor keeps ownership of the State row CAS. */
export interface WaitGateContext {
  readonly run: PersistedRun;
  readonly waits: RoutineWaitPort;
  /** Absent means `approval` States park; Runs cannot pass unasked questions. */
  readonly approvals?: RoutineApprovalPort;
  readonly now: () => Date;
  readonly transition: (
    key: string,
    from: StateStatus,
    to: StateStatus,
    reason?: string
  ) => Promise<void>;
  readonly claim: (
    key: string,
    from: StateStatus,
    progression: readonly StateStatus[]
  ) => Promise<void>;
  readonly park: (key: string, reason: string) => Promise<void>;
}

/** Open a durable timer and park the State on it. */
export async function openWait(
  ctx: WaitGateContext,
  state: CompiledState,
  key: string
): Promise<{ kind: "outcome"; outcome: StepOutcome } | { kind: ChainOutcome }> {
  const waitId = routineWaitId(ctx.run.id, key);
  // A worker that died between creating the wait and parking the State finds its own wait here.
  const existing = await ctx.waits.find(ctx.run.businessId, waitId);
  if (existing === null) {
    await ctx.waits.register(
      planTimerWait(state, {
        businessId: ctx.run.businessId,
        runId: ctx.run.id,
        waitId,
        stateKey: key,
        now: ctx.now().toISOString(),
      })
    );
  }
  await ctx.transition(key, "running", "waiting");
  return { kind: "waiting" };
}

/** Opens API-side approval wait; Worker never sees the resume token. */
export async function openApproval(
  ctx: WaitGateContext,
  state: CompiledState,
  key: string
): Promise<{ kind: "outcome"; outcome: StepOutcome } | { kind: ChainOutcome }> {
  const port = ctx.approvals;
  if (port === undefined) throw new RoutineExecutionRefusal("unsupported_state", state.name);

  await port.open({
    businessId: ctx.run.businessId,
    runId: ctx.run.id,
    stateKey: key,
    stateName: state.name,
    wait: planApprovalWait(state, {
      businessId: ctx.run.businessId,
      runId: ctx.run.id,
      // Derived from `(runId, occurrence key)` so replay finds the same approval.
      waitId: routineWaitId(ctx.run.id, key),
      stateKey: key,
      now: ctx.now().toISOString(),
    }),
  });
  await ctx.transition(key, "running", "waiting");
  return { kind: "waiting" };
}

/** Rejections take `approval_rejected`; expiries park instead of becoming yes/no. */
export async function resumeApproval(
  ctx: WaitGateContext,
  state: CompiledState,
  key: string,
  row: PersistedState
): Promise<{ kind: "outcome"; outcome: StepOutcome } | { kind: ChainOutcome }> {
  const port = ctx.approvals;
  if (port === undefined) return { kind: "needs_reconciliation" };

  const record = await port.find({
    businessId: ctx.run.businessId,
    runId: ctx.run.id,
    stateKey: key,
  });
  // Missing approval for a parked State is reconciliation-only.
  if (record === undefined) return { kind: "needs_reconciliation" };
  if (record.decision === "pending") return { kind: "waiting" };

  await ctx.claim(key, row.status as StateStatus, CLAIM_PATH);
  const decision = resolveApproval(
    state,
    record.decision === "approved"
      ? "approved"
      : record.decision === "denied"
        ? "rejected"
        : "expired"
  );
  if (decision.kind === "continue" || decision.kind === "handled") {
    return { kind: "outcome", outcome: decision.outcome };
  }
  if (decision.kind === "failed") {
    await ctx.transition(key, "running", "failed", `routine:${decision.errorRef}`);
    return { kind: "failed" };
  }
  await ctx.park(key, `routine:${decision.errorRef}`);
  return { kind: "needs_reconciliation" };
}

/** Resumed timers stay `running` until the caller persists the successor first. */
export async function resumeWait(
  ctx: WaitGateContext,
  state: CompiledState,
  key: string,
  row: PersistedState
): Promise<{ kind: "outcome"; outcome: StepOutcome } | { kind: ChainOutcome }> {
  const wait = await ctx.waits.find(ctx.run.businessId, routineWaitId(ctx.run.id, key));
  if (wait === null) return { kind: "needs_reconciliation" };
  if (wait.status === "pending") return { kind: "waiting" };

  await ctx.claim(key, row.status as StateStatus, CLAIM_PATH);
  if (wait.status === "satisfied") return { kind: "outcome", outcome: stateOutcome(state) };

  const decision = resolveErrorPath(state, WAIT_TIMED_OUT, "attention");
  if (decision.kind === "handled") return { kind: "outcome", outcome: decision.outcome };
  if (decision.kind === "failed") {
    await ctx.transition(key, "running", "failed", `routine:${WAIT_TIMED_OUT}`);
    return { kind: "failed" };
  }
  await ctx.park(key, `routine:${WAIT_TIMED_OUT}`);
  return { kind: "needs_reconciliation" };
}
