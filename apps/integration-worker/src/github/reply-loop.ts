import {
  type GitHubReplyCredential,
  GitHubReplyDelivery,
  GitHubReplyError,
} from "@tulipfarm/integrations";
import {
  ChannelDeliveryStore,
  ChannelRunDeliveryStore,
  IntegrationStore,
  RunStore,
} from "@tulipfarm/storage";
import type { Pool } from "pg";
import { channelDeliveryAuthorization } from "../channels/delivery-authorization";
import { channelDeliveryLedger } from "../channels/delivery-ledger";
import { defaultWait } from "../channels/delivery-poll-loop";
import { transactionPort } from "../db";
import { type InternalApiClient, InternalApiError } from "../internal/client";
import type { DrainableLoop } from "../shutdown";
import { GitHubRestHttp } from "./http";

interface ReplyResponse {
  readonly status: "succeeded" | "failed" | "pending";
  readonly text?: string;
}

export interface GitHubReplyLoopDeps {
  readonly businessId: string;
  readonly runDeliveries: Pick<
    ChannelRunDeliveryStore,
    "listPending" | "claim" | "markStatus" | "retry"
  >;
  readonly runs: Pick<RunStore, "find">;
  readonly internalApi: Pick<InternalApiClient, "require">;
  readonly delivery: Pick<GitHubReplyDelivery, "deliver">;
  readonly log: { warn(message: string, error?: unknown): void };
  readonly wait?: typeof defaultWait;
}

export async function pollGitHubReplies(
  signal: AbortSignal,
  deps: GitHubReplyLoopDeps
): Promise<void> {
  for (const pending of await deps.runDeliveries.listPending(deps.businessId)) {
    if (signal.aborted) return;
    if (pending.provider !== "github") continue;
    try {
      const run = await deps.runs.find(deps.businessId, pending.runId);
      if (run === null || !["succeeded", "failed", "cancelled"].includes(run.status)) continue;
      const reply = await deps.internalApi.require<ReplyResponse>(
        "GET",
        `/api/v1/internal/channels/runs/${encodeURIComponent(pending.runId)}/reply`
      );
      if (reply.status === "pending") continue;
      const row = await deps.runDeliveries.claim(deps.businessId, pending.runId);
      if (row === null) continue;
      try {
        if (
          row.provider !== "github" ||
          row.threadId === undefined ||
          row.leaseGeneration === undefined
        ) {
          throw new GitHubReplyError("delivery_binding_invalid");
        }
        const credential = await deps.internalApi.require<GitHubReplyCredential>(
          "POST",
          "/api/v1/internal/channels/github/credential",
          {
            integrationId: row.integrationId,
            routeId: row.routeId,
            runId: row.runId,
            destination: row.destination,
            leaseGeneration: row.leaseGeneration,
          }
        );
        if (signal.aborted) return;
        await deps.delivery.deliver(
          {
            ...row,
            threadId: row.threadId,
            text:
              reply.status === "succeeded" && reply.text
                ? reply.text
                : "I could not complete this request. Please check the linked chat in TulipFarm.",
          },
          credential
        );
        await deps.runDeliveries.markStatus(
          deps.businessId,
          row.runId,
          reply.status === "succeeded" ? "done" : "failed",
          row.leaseGeneration
        );
      } catch (error) {
        const permanent =
          (error instanceof GitHubReplyError && !error.retryable) ||
          (error instanceof InternalApiError && [400, 403, 404, 409].includes(error.status));
        if (permanent) {
          await deps.runDeliveries.markStatus(
            deps.businessId,
            row.runId,
            "failed",
            row.leaseGeneration
          );
        } else {
          await deps.runDeliveries.retry(
            deps.businessId,
            row.runId,
            row.leaseGeneration ?? 0,
            error instanceof GitHubReplyError ? error.retryAfterMs : 5000
          );
        }
        deps.log.warn(`GitHub reply delivery failed for Run ${row.runId}`, error);
      }
    } catch (error) {
      deps.log.warn(`GitHub reply poll failed for Run ${pending.runId}`, error);
    }
  }
}

export function startGitHubReplyLoop(
  signal: AbortSignal,
  deps: GitHubReplyLoopDeps
): DrainableLoop {
  return {
    name: "github-reply-delivery",
    settled: (async () => {
      while (!signal.aborted) {
        try {
          await pollGitHubReplies(signal, deps);
        } catch (error) {
          deps.log.warn("GitHub reply polling unavailable", error);
        }
        await (deps.wait ?? defaultWait)(2000, signal);
      }
    })(),
  };
}

export function createGitHubReplyLoop(
  signal: AbortSignal,
  options: {
    readonly businessId: string;
    readonly pool: Pool;
    readonly internalApi: InternalApiClient;
    readonly log: GitHubReplyLoopDeps["log"];
  }
): DrainableLoop {
  const transactions = transactionPort(options.pool);
  const now = () => new Date().toISOString();
  return startGitHubReplyLoop(signal, {
    ...options,
    runDeliveries: new ChannelRunDeliveryStore(transactions, now),
    runs: new RunStore(transactions),
    delivery: new GitHubReplyDelivery({
      ledger: channelDeliveryLedger(new ChannelDeliveryStore(transactions, now)),
      authorization: channelDeliveryAuthorization(
        new IntegrationStore(transactions),
        options.internalApi
      ),
      http: new GitHubRestHttp(),
    }),
  });
}
