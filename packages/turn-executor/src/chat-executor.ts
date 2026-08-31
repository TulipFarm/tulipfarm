import {
  AgentLoop,
  type AgentLoopBudgetPort,
  InMemoryLoopCheckpointStore,
  type LoopCheckpointStore,
  type ModelPort,
  type ToolDispatchPort,
  type ToolResultDistillerPort,
} from "@tulipfarm/agent-runtime";
import {
  LIMIT_KEYS,
  type LimitKey,
  RunBudgetManager,
  type RunBudgetStore,
} from "@tulipfarm/run-kernel";
import type { PersistedRun, RunStore } from "@tulipfarm/storage";
import { AgentStateRunner, type StateTransitionPort, type TurnWaitPort } from "./agent-state";
import { ConversationTurnCompleter, type TurnCompletionStore } from "./conversation-turn";
import {
  type TurnAttachmentPort,
  type TurnContextPort,
  TurnDriver,
  type TurnRequest,
} from "./driver";
import { TurnGuardrails } from "./guardrails";
import { reclaimPendingState, reclaimWaitingState } from "./kernel-ports";
import type { ModelCallReceiptSource, RunExecutor, RunOutcome, SpendSink } from "./ports";
import { type RunEventAppendPort, TurnEventWriter } from "./run-events";
import { announceToolCalls } from "./tool-events";

/** Chat Run executor; resolves all Turn facts from the Run and rebuilds per-Run state. */

/** The single State a Chat invocation runs on, as the API's invocation gateway records it. */
const INVOKE_STATE_KEY = "invoke";

export interface ChatExecutorHost {
  findTurn(runId: string): Promise<
    | {
        turnId: string;
        conversationId: string;
        attempt: number;
        /** The Run this attempt supersedes; its unfinished work is readable, never writable. */
        previousRunId?: string;
      }
    | undefined
  >;
}

/**
 * Lets a retry read the failed attempt's unfinished work without ever writing back to it.
 *
 * A retry runs as a new Run, and checkpoints are keyed by Run, so its own key holds nothing and
 * the loop would re-run every Tool the failed attempt already paid for. Copying the row forward
 * instead would race the executor that is already loading it, and a late copy would overwrite
 * live state with stale state. Reading through is race-free: only the current Run is ever saved.
 */
export function resumableFromPreviousRun(
  inner: LoopCheckpointStore,
  previousRunId: string | undefined
): LoopCheckpointStore {
  if (previousRunId === undefined) return inner;
  return {
    save: (checkpoint) => inner.save(checkpoint),
    load: async (businessId, runId, stateId) => {
      const own = await inner.load(businessId, runId, stateId);
      if (own !== undefined) return own;
      const previous = await inner.load(businessId, previousRunId, stateId);
      // Counters without a transcript are a settled loop whose work was deliberately dropped.
      // Adopting that spend would charge this attempt for results it does not receive.
      if (previous?.resume === undefined) return undefined;
      return { ...previous, runId };
    },
  };
}

export interface ChatExecutorOptions {
  /** Resolves the Turn, the Context, the Tools, and the durable completion. */
  readonly host: ChatExecutorHost & TurnCompletionStore & ToolDispatchPort;
  /** Where Tool calls go. Defaults to `host`; a process that hosts Tools passes its own router. */
  readonly tools?: ToolDispatchPort;
  readonly context: TurnContextPort;
  /** Fetches attached File bytes. Absent leaves every Turn attachment-free. */
  readonly attachments?: TurnAttachmentPort;
  /**
   * Shrinks an oversized Tool result against what the Turn asked. Declared, never constructed:
   * this package must not reach a provider. Absent leaves large results raw but bounded.
   *
   * Takes a factory for the same reason `model` does: this is a real model call, and it is only
   * chargeable to the Turn that caused it if the Turn's identity reaches whatever makes it.
   */
  readonly distiller?:
    | ToolResultDistillerPort
    | ((input: ChatModelFactoryInput) => ToolResultDistillerPort);
  readonly runs: Pick<RunStore, "find" | "findState">;
  readonly events: RunEventAppendPort;
  readonly budgets: RunBudgetStore;
  readonly transitions: StateTransitionPort;
  readonly waits: TurnWaitPort;
  /**
   * Durable Agent-loop counters, so an approval park cannot reset `maxToolCalls`/`maxRepairAttempts`
   * by re-entering with a fresh store. Defaults to in-memory for tests; production injects the
   * PostgreSQL store from the composition root.
   */
  readonly checkpoints?: LoopCheckpointStore;
  readonly model: ModelPort | ((input: ChatModelFactoryInput) => ModelPort);
  /** Where a guard that timed out or threw is reported; it is skipped, never allowed to stall. */
  readonly log: { warn(obj: unknown, msg?: string): void };
  /** Where finished turns are reported as spend. */
  readonly spend?: SpendSink;
  now?(): Date;
}

/** Cancellation is read from the Run, not in-memory flags. */
const CANCELLING_STATUSES: ReadonlySet<string> = new Set(["cancelling", "cancelled"]);

export function createChatExecutor(options: ChatExecutorOptions): RunExecutor {
  return async (run: PersistedRun): Promise<RunOutcome> => {
    const identity = await options.host.findTurn(run.id);
    if (identity === undefined) {
      // No Turn means superseded or already answered; nothing is owed.
      return { status: "succeeded" };
    }

    const writer = new TurnEventWriter({
      events: options.events,
      businessId: run.businessId,
      runId: run.id,
      turnId: identity.turnId,
      attempt: identity.attempt,
      ...(options.now === undefined ? {} : { now: options.now }),
    });

    try {
      return await executeTurn(options, run, identity, writer);
    } catch (error) {
      // Everything before the driver — State reclaim, Context assembly, guard configuration — runs
      // where no `turn.finished` has been written yet, and a throw from here reaches the dispatcher,
      // which parks the Run at `needs_reconciliation`. That is not a status the Run event stream
      // closes on, so an unannounced failure leaves the participant waiting on a turn nothing will
      // ever finish. Announce it, then park.
      options.log.warn({ runId: run.id, turnId: identity.turnId, error }, "chat turn failed");
      return announceTurnFailure(writer, options.log);
    }
  };
}

/** Reports a turn no attempt can finish; the Run still parks so reconciliation owns its effects. */
async function announceTurnFailure(
  writer: TurnEventWriter,
  log: ChatExecutorOptions["log"]
): Promise<RunOutcome> {
  try {
    await writer.emit(
      "turn.finished",
      { status: "failed", messageId: null, reason: "turn_execution_failed" },
      "finished"
    );
  } catch (error) {
    log.warn({ error }, "chat turn failure could not be announced");
  }
  return { status: "needs_reconciliation" };
}

async function executeTurn(
  options: ChatExecutorOptions,
  run: PersistedRun,
  identity: { turnId: string; conversationId: string; attempt: number; previousRunId?: string },
  writer: TurnEventWriter
): Promise<RunOutcome> {
  const state = await options.runs.findState(run.businessId, run.id, INVOKE_STATE_KEY);
  if (state === null) {
    // A Chat Run without its `invoke` State cannot have been minted by the invocation gateway.
    return announceTurnFailure(writer, options.log);
  }

  // Reclaim the same State after approval; no second Run or Turn is minted.
  if (state.status === "waiting") {
    await reclaimWaitingState(options.transitions, {
      businessId: run.businessId,
      runId: run.id,
      stateKey: INVOKE_STATE_KEY,
    });
  }

  // First dispatch claims the gateway's `pending` invoke State.
  if (state.status === "pending") {
    await reclaimPendingState(options.transitions, {
      businessId: run.businessId,
      runId: run.id,
      stateKey: INVOKE_STATE_KEY,
    });
  }

  const request: TurnRequest = {
    businessId: run.businessId,
    runId: run.id,
    stateKey: INVOKE_STATE_KEY,
    stateStatus:
      state.status === "waiting" || state.status === "pending" ? "claimed" : state.status,
    turnId: identity.turnId,
    conversationId: identity.conversationId,
    attempt: identity.attempt,
  };

  const model =
    typeof options.model === "function"
      ? options.model({
          events: writer,
          budgets: new RunBudgetManager(options.budgets),
          businessId: run.businessId,
          runId: run.id,
          conversationId: identity.conversationId,
        })
      : options.model;

  // Wrap dispatch before the loop exists; unconfigured guards refuse every stage.
  const guardrails = new TurnGuardrails(options.log);

  const loop = new AgentLoop({
    model,
    // Guard before announcing; refused Tool calls never ran.
    tools: guardrails.guard(announceToolCalls(options.tools ?? options.host, writer), writer),
    checkpoints: resumableFromPreviousRun(
      options.checkpoints ?? new InMemoryLoopCheckpointStore(),
      identity.previousRunId
    ),
    events: writer,
    budget: runBudget(options.budgets, run.businessId, run.id),
    isCancelled: async () => {
      const current = await options.runs.find(run.businessId, run.id);
      return current !== null && CANCELLING_STATUSES.has(current.status);
    },
    log: options.log,
    // The same port the Context's own attachments come from: a File re-read mid-Turn is fetched
    // and re-authorized exactly as one the person attached, through one gate rather than two.
    ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
    ...(options.distiller === undefined
      ? {}
      : {
          distiller: guardrails.guardDistiller(
            typeof options.distiller === "function"
              ? options.distiller({
                  events: writer,
                  budgets: new RunBudgetManager(options.budgets),
                  businessId: run.businessId,
                  runId: run.id,
                  conversationId: identity.conversationId,
                })
              : options.distiller,
            writer
          ),
        }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const driver = new TurnDriver({
    states: new AgentStateRunner({
      loop,
      transitions: options.transitions,
      waits: options.waits,
    }),
    context: options.context,
    completer: new ConversationTurnCompleter({ store: options.host }),
    guardrails,
    buildEvents: () => writer,
    // Only receipt-capable model ports can name the model actually observed.
    ...(isReceiptSource(model) ? { modelReceipt: () => model.latestModelCallReceipt() } : {}),
    ...(options.spend === undefined ? {} : { spend: options.spend }),
    ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
  });

  return driver.run(request);
}

/** The Run kernel budget, narrowed to the one Run being charged. */
const LIMIT_KEY_SET: ReadonlySet<string> = new Set(LIMIT_KEYS);

function isReceiptSource(port: unknown): port is ModelCallReceiptSource {
  return (
    typeof port === "object" &&
    port !== null &&
    typeof (port as ModelCallReceiptSource).latestModelCallReceipt === "function"
  );
}

function isLimitKey(key: string): key is LimitKey {
  return LIMIT_KEY_SET.has(key);
}

export interface ChatModelFactoryInput {
  readonly events: TurnEventWriter;
  readonly budgets: RunBudgetManager;
  readonly businessId: string;
  readonly runId: string;
  /** Which Conversation the turn belongs to, so its model spend can be attributed to it. */
  readonly conversationId: string;
}

function runBudget(
  budgets: RunBudgetStore,
  businessId: string,
  runId: string
): AgentLoopBudgetPort {
  const manager = new RunBudgetManager(budgets);
  return {
    consume: (input) =>
      isLimitKey(input.key)
        ? manager.consume({ businessId, runId, key: input.key, amount: input.amount })
        : budgets.consume(businessId, runId, input.key, input.amount),
  };
}
