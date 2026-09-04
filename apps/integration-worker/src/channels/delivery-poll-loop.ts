import type { IntegrationHttpPort, SlackDeliveryAdapter } from "@tulipfarm/integrations";
import type {
  ChannelRunDeliveryStore,
  PersistedChannelRunDeliveryRecord,
  PersistedRunStatus,
  RunStore,
} from "@tulipfarm/storage";
import type { InternalApiClient } from "../internal/client";
import type { DrainableLoop } from "../shutdown";
import { THINKING_STATUS } from "../slack/thinking-status";
import { deliverPendingApproval } from "./approval-delivery";

const TERMINAL_RUN_STATUSES: ReadonlySet<PersistedRunStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

const GENERIC_FAILURE_MESSAGE = "Something went wrong answering this — please try again.";

/** Sanitized, participant-safe copy per `AgentLoopFailureReason` (`packages/agent-runtime/src/loop/contract.ts`) plus driver-level reasons. Never echoes raw provider error text. */
const FAILURE_MESSAGE_BY_REASON: Readonly<Record<string, string>> = {
  model_rate_limited:
    "The model provider is rate-limiting us right now. I retried automatically but it's still throttled — please try again shortly.",
  model_provider_unavailable:
    "The model provider looks to be down or unreachable right now. I retried automatically — please try again shortly.",
  model_error:
    "The model provider returned an error while answering. I retried automatically but it kept failing — please try again.",
  model_billing_inactive:
    "The configured model provider's billing is inactive, so I can't answer right now. This needs an operator to check the provider account.",
  model_authentication_failed:
    "The configured model provider rejected our credentials, so I can't answer right now. This needs an operator to check the provider API key.",
  model_not_configured:
    "No model is configured for this, so I can't answer right now. This needs an operator to set one up.",
  model_not_found:
    "The configured model couldn't be found by the provider, so I can't answer right now. This needs an operator to check the model configuration.",
  iteration_limit:
    "This took more steps than I'm allowed to run in one turn, so I stopped before finishing.",
  tool_call_limit:
    "This needed more tool calls than I'm allowed to make in one turn, so I stopped before finishing.",
  budget_exhausted: "This turn used up its allotted budget before finishing.",
  repair_budget_exhausted:
    "I kept producing output that didn't fit what was needed, and ran out of attempts to fix it.",
  input_request_failed: "I couldn't record the question I needed to ask — please try again.",
  handoff_unavailable: "The agent this needed to hand off to isn't available right now.",
  effect_after_report: "I ran into an internal ordering error while finishing this turn.",
  empty_model_output: "The model provider returned nothing for this turn — please try again.",
  needs_reconciliation: "This got stuck mid-run and needs to be retried — please try again.",
  turn_execution_failed: "Something went wrong while running this turn — please try again.",
};

function failureMessageFor(reason?: string): string {
  if (reason === undefined) return GENERIC_FAILURE_MESSAGE;
  return FAILURE_MESSAGE_BY_REASON[reason] ?? GENERIC_FAILURE_MESSAGE;
}

interface ReplyResponse {
  status: "succeeded" | "failed" | "pending";
  text?: string;
  agentDisplayName?: string;
  blocks?: readonly Record<string, unknown>[];
  reason?: string;
}

export interface DeliveryPollLoopDeps {
  businessId: string;
  runDeliveries: ChannelRunDeliveryStore;
  runs: RunStore;
  internalApi: InternalApiClient;
  delivery: SlackDeliveryAdapter;
  credential: string;
  /** Optional approval prompt hook; omitted when a provider/test does not need approvals. */
  http?: IntegrationHttpPort;
  /** Best-effort display name for the Agent that answered; falls back to the raw `agentId`. */
  agentDisplayName?: (agentId: string) => string;
  pollIntervalMs?: number;
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  log: { warn: (message: string, error?: unknown) => void };
}

export function defaultWait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

async function rotateStatus(
  row: PersistedChannelRunDeliveryRecord,
  deps: DeliveryPollLoopDeps
): Promise<void> {
  if (row.threadId === undefined) return;
  try {
    await deps.delivery.setStatus(
      { destination: row.destination, threadId: row.threadId, status: THINKING_STATUS },
      deps.credential
    );
  } catch (error) {
    deps.log.warn("slack assistant status rotation failed", error);
  }
}

async function markFailed(
  row: PersistedChannelRunDeliveryRecord,
  deps: DeliveryPollLoopDeps,
  reason?: string
): Promise<void> {
  try {
    await deps.delivery.deliver(
      {
        businessId: row.businessId,
        integrationId: row.integrationId,
        routeId: row.routeId,
        idempotencyKey: row.idempotencyKey,
        provider: row.provider,
        destination: row.destination,
        agentId: row.agentId,
        principalId: row.principalId,
        text: failureMessageFor(reason),
        agentDisplayName: deps.agentDisplayName?.(row.agentId) ?? row.agentId,
        ...(row.threadId === undefined ? {} : { threadId: row.threadId }),
      },
      deps.credential
    );
  } catch (error) {
    deps.log.warn("slack failure message delivery failed", error);
  }
  await deps.runDeliveries.markStatus(deps.businessId, row.runId, "failed");
}

async function deliverReply(
  row: PersistedChannelRunDeliveryRecord,
  reply: ReplyResponse,
  deps: DeliveryPollLoopDeps
): Promise<void> {
  if (reply.status !== "succeeded") {
    await markFailed(row, deps, reply.reason);
    return;
  }
  const agentDisplayName =
    reply.agentDisplayName ?? deps.agentDisplayName?.(row.agentId) ?? row.agentId;
  try {
    await deps.delivery.deliver(
      {
        businessId: row.businessId,
        integrationId: row.integrationId,
        routeId: row.routeId,
        idempotencyKey: row.idempotencyKey,
        provider: row.provider,
        destination: row.destination,
        agentId: row.agentId,
        principalId: row.principalId,
        // Slack requires a non-empty top-level `text` fallback even when `blocks` renders the
        // actual content — it backs notifications and screen readers, which don't read blocks.
        text: reply.text && reply.text.length > 0 ? reply.text : "New message",
        agentDisplayName,
        ...(row.threadId === undefined ? {} : { threadId: row.threadId }),
        ...(row.slackMessageTs === undefined ? {} : { updateTs: row.slackMessageTs }),
        ...(reply.blocks === undefined ? {} : { blocks: reply.blocks }),
      },
      deps.credential
    );
  } catch (error) {
    deps.log.warn(`slack reply delivery failed for run ${row.runId}`, error);
    await markFailed(row, deps);
    return;
  }
  await deps.runDeliveries.markStatus(deps.businessId, row.runId, "done");
}

async function handleRow(
  row: PersistedChannelRunDeliveryRecord,
  deps: DeliveryPollLoopDeps
): Promise<void> {
  const run = await deps.runs.find(deps.businessId, row.runId);
  if (run === null || !TERMINAL_RUN_STATUSES.has(run.status)) {
    if (deps.http !== undefined) {
      await deliverPendingApproval(row, {
        businessId: deps.businessId,
        internalApi: deps.internalApi,
        http: deps.http,
        credential: deps.credential,
        runDeliveries: deps.runDeliveries,
        log: deps.log,
      });
    }
    await rotateStatus(row, deps);
    return;
  }

  if (run.status !== "succeeded") {
    // Best-effort: a completed attempt may have recorded a reason even though the Run itself
    // ended failed/cancelled; a Run that never completed a Turn attempt has none to read.
    const reply = await deps.internalApi
      .find<ReplyResponse>("GET", `/api/v1/internal/channels/runs/${row.runId}/reply`, [404])
      .catch(() => undefined);
    await markFailed(row, deps, reply?.reason);
    return;
  }

  const reply = await deps.internalApi.require<ReplyResponse>(
    "GET",
    `/api/v1/internal/channels/runs/${row.runId}/reply`
  );
  if (reply.status === "pending") {
    await rotateStatus(row, deps);
    return;
  }
  await deliverReply(row, reply, deps);
}

async function pollOnce(deps: DeliveryPollLoopDeps): Promise<void> {
  const pending = await deps.runDeliveries.listPending(deps.businessId);
  for (const row of pending) {
    try {
      await handleRow(row, deps);
    } catch (error) {
      deps.log.warn(`channel delivery poll failed for run ${row.runId}`, error);
    }
  }
}

async function pollLoop(signal: AbortSignal, deps: DeliveryPollLoopDeps): Promise<void> {
  const intervalMs = deps.pollIntervalMs ?? 2000;
  const wait = deps.wait ?? defaultWait;
  while (!signal.aborted) {
    await pollOnce(deps);
    await wait(intervalMs, signal);
  }
}

/** Polls terminal Run deliveries and drives status rotation. */
export function startDeliveryPollLoop(
  signal: AbortSignal,
  deps: DeliveryPollLoopDeps
): DrainableLoop {
  return { name: "slack-delivery-poll", settled: pollLoop(signal, deps) };
}
