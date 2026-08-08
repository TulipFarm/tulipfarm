import {
  AgentLoop,
  type AgentLoopBudgetPort,
  InMemoryLoopCheckpointStore,
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
import type { RunOutcome } from "../run-dispatcher";
import { type TurnContextPort, TurnDriver, type TurnRequest } from "./driver";
import { TurnGuardrails } from "./guardrails";
import { reclaimPendingState, reclaimWaitingState } from "./kernel-ports";
import { type RunEventAppendPort, TurnEventWriter } from "./run-events";
import { announceToolCalls } from "./tool-events";

/**
 * The `chat` Run executor (plan §4; blocker §2).
 *
 * A claimed Run arrives holding nothing but its id. Everything the turn needs — which Turn it
 * answers, the assembled Context, the Tools, the transcript — is resolved through the internal
 * turn host, which derives all of it from the Run itself. That is what lets one code path serve
 * web, Slack, Telegram, and any channel added later: the executor never learns which channel
 * submitted the request, because nothing it does depends on the answer.
 *
 * The per-turn graph is rebuilt for every Run rather than shared. Three of its parts are
 * genuinely per-turn — the event writer keys events by `(turnId, attempt)`, the budget is charged
 * against this Run, and cancellation is asked of this Run — so a shared instance would have to
 * thread that state through every call and would leak one turn's identity into the next.
 */

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
  readonly context: TurnContextPort;
  readonly runs: Pick<RunStore, "find" | "findState">;
  readonly events: RunEventAppendPort;
  readonly budgets: RunBudgetStore;
  readonly transitions: StateTransitionPort;
  readonly waits: ApprovalWaitPort;
  readonly model: ModelPort | ((input: ChatModelFactoryInput) => ModelPort);
  /** Where a guard that timed out or threw is reported; it is skipped, never allowed to stall. */
  readonly log: { warn(obj: unknown, msg?: string): void };
  now?(): Date;
}

/**
 * Run statuses that mean the turn must stop.
 *
 * Asked of the Run rather than of a flag in memory: cancellation is requested by whoever owns the
 * Run — an operator, a parent Run, a client abandoning the conversation — and none of them can
 * reach into this process.
 */
const CANCELLING_STATUSES: ReadonlySet<string> = new Set(["cancelling", "cancelled"]);

export function createChatExecutor(options: ChatExecutorOptions): RunExecutor {
  return async (run: PersistedRun): Promise<RunOutcome> => {
    const identity = await options.host.findTurn(run.id);
    if (identity === undefined) {
      // The Run names no Turn: superseded by a retry, or already answered. Nothing is owed, and
      // failing it would tell a reader the conversation broke when it did not.
      return "succeeded";
    }

    const state = await options.runs.findState(run.businessId, run.id, INVOKE_STATE_KEY);
    if (state === null) {
      // A Chat Run without its `invoke` State cannot have been minted by the invocation gateway.
      return "needs_reconciliation";
    }

    // A Run resumed from an approval arrives with its State still parked. Re-claiming it here, on
    // the same Run and the same State, is what makes an approval a pause rather than a restart:
    // nothing mints a second Run, and the conversation gains no second Turn.
    if (state.status === "waiting") {
      await reclaimWaitingState(options.transitions, {
        businessId: run.businessId,
        runId: run.id,
        stateKey: INVOKE_STATE_KEY,
      });
    }

    // A first dispatch arrives `pending` — the gateway's INSERT default, shared with a Routine's
    // start State. Nothing leases a State the way a Run is leased, so this claims it the same way
    // a resumed one is reclaimed above.
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
          })
        : options.model;

    // Built here and configured by the driver once the Context names a policy: the dispatch port
    // has to be wrapped before the loop exists, and the policy is not known until then. Until it is
    // configured every stage refuses, so there is no window in which a Tool runs unguarded.
    const guardrails = new TurnGuardrails(options.log);

    const loop = new AgentLoop({
      model,
      // Guarding wraps announcing, not the other way round: a call a guard refuses never reached a
      // Tool, so announcing it as a call that ran would misreport the turn.
      tools: guardrails.guard(announceToolCalls(options.host, writer), writer),
      // Counters are also charged against the durable Run budget below, which is what actually
      // caps a resumed State. These are the loop's local view for one execution.
      checkpoints: new InMemoryLoopCheckpointStore(),
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
      // Only a port that keeps a receipt can report one; a caller-supplied plain `ModelPort`
      // finishes the turn without one rather than naming a model it never observed.
      ...(isReceiptSource(model) ? { modelReceipt: () => model.latestModelCallReceipt() } : {}),
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
