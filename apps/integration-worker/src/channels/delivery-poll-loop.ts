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

const FAILURE_MESSAGE = "Something went wrong answering this — please try again.";

interface ReplyResponse {
  status: "succeeded" | "failed" | "pending";
  text?: string;
  agentDisplayName?: string;
  blocks?: readonly Record<string, unknown>[];
}

export interface DeliveryPollLoopDeps {
  businessId: string;
  runDeliveries: ChannelRunDeliveryStore;
  runs: RunStore;
  internalApi: InternalApiClient;
  delivery: SlackDeliveryAdapter;
  credential: string;
  /**
   * When supplied, checks each still-running row for an open tool-call approval every tick and
   * posts the Approve/Deny prompt (plan §5) the first time one appears. Omitted for providers or
   * test setups that don't need interactive approvals.
   */
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
  deps: DeliveryPollLoopDeps
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
        text: FAILURE_MESSAGE,
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
    await markFailed(row, deps);
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
    await markFailed(row, deps);
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

/** Polls `channel_run_deliveries` for terminal Runs and drives §10's status rotation. */
export function startDeliveryPollLoop(
  signal: AbortSignal,
  deps: DeliveryPollLoopDeps
): DrainableLoop {
  return { name: "slack-delivery-poll", settled: pollLoop(signal, deps) };
}
