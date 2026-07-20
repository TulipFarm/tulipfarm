import {
  type EnginePorts,
  executeState,
  LIFECYCLE_HOOKS,
  parseIsoDuration,
  type ResolvedFunction,
  type RunEvent,
  type RunSnapshot,
  type SelectedRoute,
  type StateExecutionData,
} from "@tulipfarm/routine-engine";
import type { StreamHub } from "../chat/stream-hub";
import type { RoutineRegistry } from "./registry";
import type {
  PendingRunEvent,
  RoutineRunRow,
  RoutineRunsRepo,
  RunStatus,
  RunTransitionGuard,
  RunTransitionPatch,
} from "./repo";
import { makeRunJournalEmitter, publishRunEvents, runStreamId } from "./stream-adapter";

type DriverLogger = {
  error: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  info?: (obj: unknown, msg?: string) => void;
};

/** Sandbox surface the driver needs (implemented by HookExecutor). */
export interface RoutineSandbox {
  runExpression(code: string, scope: Record<string, unknown>, breakerKey: string): Promise<unknown>;
  runRoutineHook(
    hookSource: string,
    fnName: string,
    invocation: Record<string, unknown>,
    args: unknown,
    breakerKey: string,
    opts?: { expectedHash?: string; optional?: boolean }
  ): Promise<unknown>;
}

/** Executes a tool/agent action for an operation state (Phase 4 provides the real one). */
export type ActionExecutor = (
  fn: ResolvedFunction,
  args: Record<string, unknown>,
  run: RunSnapshot
) => Promise<unknown>;

/** Creates the approval row + delivers channels; returns the approval id (Phase 6). */
export type ApprovalRequester = (
  run: RoutineRunRow,
  request: { stateName: string; channels: string[]; summary: Record<string, unknown> }
) => Promise<string>;

export interface DriverDeps {
  runs: RoutineRunsRepo;
  registry: RoutineRegistry;
  hub: StreamHub;
  sandbox: RoutineSandbox;
  actionExecutor: ActionExecutor;
  requestApproval?: ApprovalRequester;
  /** Enqueue a routine-wake delivery at `startAfter`. */
  enqueueWake: (args: {
    runId: string;
    reason: "sleep" | "retry" | "approval";
    token: string;
    startAfter?: Date;
  }) => Promise<void>;
  /**
   * Records one activity-feed row per run at its terminal outcome (succeeded/failed), fired once
   * from the CAS-winning `finish`. Best-effort — the caller must never throw back into the driver.
   */
  recordRun?: (r: {
    slug: string;
    runId: string;
    status: "succeeded" | "failed";
    error?: Record<string, unknown>;
  }) => void;
  log: DriverLogger;
}

export interface DriveOptions {
  /** Approval decision when resuming a waiting_approval run. */
  approvalOutcome?: "approved" | "denied";
}

const TERMINAL: RunStatus[] = ["succeeded", "failed", "cancelled"];

function hookMentions(hookSource: string, fnName: string): boolean {
  return new RegExp(`\\b${fnName}\\s*[(:]`).test(hookSource);
}

function stateCompleted(data: StateExecutionData): PendingRunEvent {
  return { type: "state.completed", payload: { state: data.state, output: data.output ?? {} } };
}

function stateTransitioned(source: string, selected: SelectedRoute): PendingRunEvent {
  const payload: Record<string, unknown> = { source };
  if ("target" in selected && selected.target) payload.target = selected.target;
  if ("end" in selected && selected.end) payload.end = true;
  switch (selected.kind) {
    case "condition":
      payload.route = { kind: selected.kind, index: selected.index };
      break;
    case "error":
      payload.route = { kind: selected.kind, index: selected.index, error: selected.error };
      break;
    default:
      payload.route = { kind: selected.kind };
  }
  return { type: "state.transitioned", payload };
}

/**
 * The run driver: loads a run, loops `executeState`, persists after every outcome
 * (persist-first, enqueue-second — the sweep heals the gap), and exits the loop on any
 * suspension. Safe under at-least-once delivery: every transition is CAS-guarded, so a
 * duplicate delivery loses the CAS and returns quietly.
 */
export class RoutineRunDriver {
  constructor(private readonly deps: DriverDeps) {}

  async drive(runId: string, opts: DriveOptions = {}): Promise<void> {
    const { runs, hub, log } = this.deps;
    const row = await runs.findById(runId);
    if (!row) {
      log.warn({ runId }, "routine-run job for unknown run");
      return;
    }
    if (TERMINAL.includes(row.status)) return;

    // Claim: pending (fresh) / sleeping (wake) / waiting_approval (decision) → running.
    const claimed = await this.transition(
      runId,
      { status: row.status },
      { status: "running", wakeAt: null }
    );
    if (!claimed) return; // another delivery got here first

    const streamId = runStreamId(runId);
    hub.register(streamId);
    const emitter = makeRunJournalEmitter(runId, { runs, hub, log });

    const routine = this.deps.registry.get(row.routineSlug);
    const hookSource = routine?.hookSource;
    const hookHash = routine?.hookHash;
    const breakerKey = `routine:${row.routineSlug}`;
    const sandbox = this.deps.sandbox;

    // sleep-completion: currentState null means "the run finished sleeping into its end".
    if (row.currentState === null) {
      await this.finish(runId, row.routineSlug, {
        status: "succeeded",
        output: row.context,
      });
      return;
    }

    let snapshot: RunSnapshot = {
      runId,
      slug: row.routineSlug,
      definition: row.definitionSnapshot,
      currentState: row.currentState,
      context: row.context,
      trigger: {
        type: row.trigger.type as RunSnapshot["trigger"]["type"],
        payload: row.trigger.payload,
      },
      attemptCounts: row.attemptCounts,
      approvalOutcome: opts.approvalOutcome,
    };

    const ports: EnginePorts = {
      evalExpression: (expr, scope) => sandbox.runExpression(expr, scope, breakerKey),
      runHook: (fnName, invocation, args) => {
        if (!hookSource) throw new Error(`routine "${row?.routineSlug}" has no hooks.ts`);
        const optional = /^(before|after)/.test(fnName);
        return sandbox.runRoutineHook(
          hookSource,
          fnName,
          invocation as unknown as Record<string, unknown>,
          args,
          breakerKey,
          { expectedHash: hookHash, optional }
        );
      },
      hasHook: (fnName) => Boolean(hookSource && hookMentions(hookSource, fnName)),
      runAction: (fn, args, run) => this.deps.actionExecutor(fn, args, run),
      emit: (event: RunEvent) => emitter.emit(event.type, event.data),
      now: () => new Date(),
      log: { warn: (msg) => log.warn({ runId }, msg) },
    };

    const isFirstState =
      snapshot.currentState === snapshot.definition.start &&
      (await runs.listEvents(runId)).length === 0;
    if (isFirstState) {
      await emitter.emit("run.started", {
        slug: row.routineSlug,
        trigger: row.trigger.type,
        triggerIndex: row.trigger.triggerIndex,
      });
      if (hookSource && hookMentions(hookSource, LIFECYCLE_HOOKS.beforeRun)) {
        try {
          await ports.runHook(LIFECYCLE_HOOKS.beforeRun, {
            runId,
            slug: row.routineSlug,
            context: snapshot.context,
            trigger: snapshot.trigger,
          });
        } catch (err) {
          log.warn({ runId, err }, "beforeHook failed; continuing run");
        }
      }
    }

    // The state loop. Every iteration: execute exactly one state, persist, continue or exit.
    for (;;) {
      const stateName = snapshot.currentState;

      // Persist the per-state deadline before executing so the sweep can time the state
      // out across a crash/restart (the in-process race lives in the engine).
      const stateDef = snapshot.definition.states.find((s) => s.name === stateName);
      const timeoutIso = stateDef?.timeouts?.stateExecTimeout;
      const approvalGate = stateDef?.["x-autonomy-level"] === "human_approval";
      if (timeoutIso && (!approvalGate || snapshot.approvalOutcome === "approved")) {
        const deadlineSet = await this.transition(
          runId,
          { status: "running", currentState: stateName },
          { stateDeadline: new Date(Date.now() + parseIsoDuration(timeoutIso)) }
        );
        if (!deadlineSet) return;
      }

      const outcome = await executeState(snapshot, ports);
      await runs.touch(runId); // heartbeat for the sweep

      switch (outcome.type) {
        case "continue": {
          const events = [
            ...(outcome.route.kind === "error" ? [] : [stateCompleted(outcome.stateData)]),
            stateTransitioned(stateName, outcome.route),
          ];
          const ok = await this.transition(
            runId,
            { status: "running", currentState: stateName },
            { currentState: outcome.nextState, context: outcome.context, stateDeadline: null },
            events
          );
          if (!ok) return; // raced: cancelled or duplicate delivery advanced it
          snapshot = {
            ...snapshot,
            currentState: outcome.nextState,
            context: outcome.context,
          };
          snapshot.approvalOutcome = undefined;
          continue;
        }
        case "complete": {
          await this.runAfterHook(ports, hookSource, snapshot);
          const events = [
            ...(outcome.route.kind === "error" ? [] : [stateCompleted(outcome.stateData)]),
            stateTransitioned(stateName, outcome.route),
          ];
          await this.finish(
            runId,
            row.routineSlug,
            {
              status: "succeeded",
              output: outcome.output,
              expectState: stateName,
            },
            events
          );
          return;
        }
        case "fail": {
          await this.runAfterHook(ports, hookSource, snapshot);
          await this.finish(runId, row.routineSlug, {
            status: "failed",
            error: outcome.error as unknown as Record<string, unknown>,
            expectState: stateName,
          });
          return;
        }
        case "sleep": {
          const token = `sleep:${stateName}:${outcome.until.getTime()}`;
          const ok = await this.transition(
            runId,
            { status: "running", currentState: stateName },
            {
              status: "sleeping",
              currentState: outcome.nextState,
              context: outcome.context,
              wakeAt: outcome.until,
              stateDeadline: null,
            },
            [
              stateCompleted(outcome.stateData),
              stateTransitioned(stateName, outcome.route),
              {
                type: "run.sleeping",
                payload: { state: stateName, wakeAt: outcome.until.toISOString() },
              },
              {
                type: "finish",
                payload: { reason: "suspended", wakeAt: outcome.until.toISOString() },
              },
            ]
          );
          if (!ok) return;
          hub.finish(streamId);
          await this.deps.enqueueWake({ runId, reason: "sleep", token, startAfter: outcome.until });
          return;
        }
        case "retry": {
          const wakeAt = new Date(Date.now() + outcome.delayMs);
          const token = `retry:${stateName}:${outcome.attempt}`;
          const attemptCounts = { ...snapshot.attemptCounts, [stateName]: outcome.attempt };
          const ok = await this.transition(
            runId,
            { status: "running", currentState: stateName },
            { status: "sleeping", attemptCounts, wakeAt, stateDeadline: null },
            [
              {
                type: "state.retrying",
                payload: {
                  state: stateName,
                  attempt: outcome.attempt,
                  delayMs: outcome.delayMs,
                  error: outcome.error,
                },
              },
              { type: "finish", payload: { reason: "suspended", wakeAt: wakeAt.toISOString() } },
            ]
          );
          if (!ok) return;
          hub.finish(streamId);
          await this.deps.enqueueWake({ runId, reason: "retry", token, startAfter: wakeAt });
          return;
        }
        case "wait_approval": {
          if (!this.deps.requestApproval) {
            await this.finish(runId, row.routineSlug, {
              status: "failed",
              error: { name: "approvals_unavailable", message: "approvals are not configured" },
              expectState: stateName,
            });
            return;
          }
          const approvalId = await this.deps.requestApproval(row, outcome.request);
          const ok = await this.transition(
            runId,
            { status: "running", currentState: stateName },
            { status: "waiting_approval", approvalId, stateDeadline: null },
            [
              {
                type: "run.waiting_approval",
                payload: {
                  state: stateName,
                  approvalId,
                  channels: outcome.request.channels,
                  pendingInput: outcome.request.summary,
                },
              },
              { type: "finish", payload: { reason: "suspended" } },
            ]
          );
          if (!ok) return;
          hub.finish(streamId);
          return;
        }
      }
    }
  }

  private async runAfterHook(
    ports: EnginePorts,
    hookSource: string | undefined,
    snapshot: RunSnapshot
  ): Promise<void> {
    if (!hookSource || !hookMentions(hookSource, LIFECYCLE_HOOKS.afterRun)) return;
    try {
      await ports.runHook(LIFECYCLE_HOOKS.afterRun, {
        runId: snapshot.runId,
        slug: snapshot.slug,
        context: snapshot.context,
        trigger: snapshot.trigger,
      });
    } catch (err) {
      this.deps.log.warn({ runId: snapshot.runId, err }, "afterHook failed");
    }
  }

  private async finish(
    runId: string,
    slug: string,
    result: {
      status: "succeeded" | "failed";
      output?: Record<string, unknown>;
      error?: Record<string, unknown>;
      expectState?: string | null;
    },
    leadingEvents: PendingRunEvent[] = []
  ): Promise<void> {
    const { hub } = this.deps;
    const terminalEvent: PendingRunEvent =
      result.status === "succeeded"
        ? { type: "finish", payload: { reason: "completed", output: result.output ?? {} } }
        : { type: "error", payload: { error: result.error ?? {} } };
    const ok = await this.transition(
      runId,
      {
        status: "running",
        ...(result.expectState !== undefined ? { currentState: result.expectState } : {}),
      },
      {
        status: result.status,
        output: result.output ?? null,
        error: result.error ?? null,
        wakeAt: null,
        stateDeadline: null,
        finished: true,
      },
      [...leadingEvents, terminalEvent]
    );
    if (!ok) return;
    this.deps.recordRun?.({ slug, runId, status: result.status, error: result.error });
    hub.finish(runStreamId(runId));
  }

  private async transition(
    runId: string,
    expected: RunTransitionGuard,
    patch: RunTransitionPatch,
    events: PendingRunEvent[] = []
  ): Promise<boolean> {
    const result = await this.deps.runs.transitionWithEvents(runId, expected, patch, events);
    publishRunEvents(runId, result.events, this.deps.hub, this.deps.log);
    return result.transitioned;
  }
}
