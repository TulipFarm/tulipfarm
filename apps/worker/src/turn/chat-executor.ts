import {
  AgentLoop,
  type AgentLoopBudgetPort,
  InMemoryLoopCheckpointStore,
  type LoopCheckpointStore,
  type ModelPort,
  type ToolDispatchPort,
} from "@tulipfarm/agent-runtime";
import {
  LIMIT_KEYS,
  type LimitKey,
  RunBudgetManager,
  type RunBudgetStore,
} from "@tulipfarm/run-kernel";
import type { PersistedRun, RunStore } from "@tulipfarm/storage";
import { AgentStateRunner, type ApprovalWaitPort, type StateTransitionPort } from "../agent-state";
import { ConversationTurnCompleter, type TurnCompletionStore } from "../conversation-turn";
import type { RunExecutor } from "../executors";
import type { ModelCallReceiptSource } from "../model";
import type { SpendSink } from "../observability";
import type { RunOutcome } from "../run-dispatcher";
import { type TurnContextPort, TurnDriver, type TurnRequest } from "./driver";
import { TurnGuardrails } from "./guardrails";
import { reclaimPendingState, reclaimWaitingState } from "./kernel-ports";
import { type RunEventAppendPort, TurnEventWriter } from "./run-events";
import { announceToolCalls } from "./tool-events";

/** Chat Run executor; resolves all Turn facts from the Run and rebuilds per-Run state. */

/** The single State a Chat invocation runs on, as the API's invocation gateway records it. */
const INVOKE_STATE_KEY = "invoke";

export interface ChatExecutorHost {
  findTurn(
    runId: string
  ): Promise<{ turnId: string; conversationId: string; attempt: number } | undefined>;
}

export interface ChatExecutorOptions {
  /** Resolves the Turn, the Context, the Tools, and the durable completion. */
  readonly host: ChatExecutorHost & TurnCompletionStore & ToolDispatchPort;
  /** Where Tool calls go. Defaults to `host`; a process that hosts Tools passes its own router. */
  readonly tools?: ToolDispatchPort;
  readonly context: TurnContextPort;
  readonly runs: Pick<RunStore, "find" | "findState">;
  readonly events: RunEventAppendPort;
  readonly budgets: RunBudgetStore;
  readonly transitions: StateTransitionPort;
  readonly waits: ApprovalWaitPort;
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
      return "succeeded";
    }

    const state = await options.runs.findState(run.businessId, run.id, INVOKE_STATE_KEY);
    if (state === null) {
      // A Chat Run without its `invoke` State cannot have been minted by the invocation gateway.
      return "needs_reconciliation";
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

    const writer = new TurnEventWriter({
      events: options.events,
      businessId: request.businessId,
      runId: request.runId,
      turnId: request.turnId,
      attempt: request.attempt,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
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
      checkpoints: options.checkpoints ?? new InMemoryLoopCheckpointStore(),
      events: writer,
      budget: runBudget(options.budgets, run.businessId, run.id),
      isCancelled: async () => {
        const current = await options.runs.find(run.businessId, run.id);
        return current !== null && CANCELLING_STATUSES.has(current.status);
      },
      log: options.log,
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
    });

    return driver.run(request);
  };
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
