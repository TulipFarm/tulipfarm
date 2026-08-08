import type { ChannelRunStarter, IntegrationHttpPort } from "@tulipfarm/integrations";
import type { InternalApiClient } from "../internal/client";
import { THINKING_STATUS } from "../slack/thinking-status";

interface StartRunResponse {
  runId: string;
  outcome: "started" | "duplicate";
}

export interface HttpChannelRunStarterOptions {
  /**
   * When supplied, sets the Agents & AI Apps status indicator right after a fresh Run mints.
   * Omitted for providers (or test setups) that don't need the live status indicator — a missing
   * status call never blocks the Run itself, so a failure here is swallowed rather than surfaced
   * to the caller.
   */
  assistantStatus?: {
    http: IntegrationHttpPort;
    credential: string;
    log?: { warn: (message: string, error?: unknown) => void };
  };
}

/**
 * Calls `POST /api/v1/internal/channels/runs` — Run minting, Conversation mapping, and the
 * `channel_run_deliveries` correlation row are all written together on the `apps/api` side of
 * this boundary, in the same transaction as the Turn itself.
 *
 * `ChannelRunStarter.start` carries no `provider` — this adapter is composed once per provider
 * (only Slack today, see `channels/index.ts`), so it closes over its own provider string.
 */
export function httpChannelRunStarter(
  client: InternalApiClient,
  provider: string,
  options: HttpChannelRunStarterOptions = {}
): ChannelRunStarter {
  return {
    async start(input) {
      const result = await client.require<StartRunResponse>(
        "POST",
        "/api/v1/internal/channels/runs",
        {
          eventId: input.eventId,
          provider,
          integrationId: input.integrationId,
          routeId: input.routeId,
          agentId: input.agentId,
          principal: input.principal,
          message: {
            externalAppId: input.message.externalAppId,
            channelId: input.message.channelId,
            ...(input.message.threadId === undefined ? {} : { threadId: input.message.threadId }),
            text: input.message.text,
          },
        }
      );

      if (
        result.outcome === "started" &&
        options.assistantStatus !== undefined &&
        input.message.threadId !== undefined
      ) {
        const { http, credential, log } = options.assistantStatus;
        try {
          await http.send(
            {
              method: "POST",
              path: "/assistant.threads.setStatus",
              body: {
                channel_id: input.message.channelId,
                thread_ts: input.message.threadId,
                status: THINKING_STATUS,
              },
            },
            credential
          );
        } catch (error) {
          log?.warn("slack assistant status failed", error);
        }
      }

      return result;
    },
  };
}
