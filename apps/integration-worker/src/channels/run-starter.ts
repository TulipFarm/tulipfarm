import type { ChannelRunStarter, IntegrationHttpPort } from "@tulipfarm/integrations";
import type { InternalApiClient } from "../internal/client";
import { THINKING_STATUS } from "../slack/thinking-status";

interface StartRunResponse {
  runId: string;
  outcome: "started" | "duplicate";
}

export interface HttpChannelRunStarterOptions {
  /** Optional status update; failure never blocks Run creation. */
  assistantStatus?: {
    http: IntegrationHttpPort;
    credential: string;
    log?: { warn: (message: string, error?: unknown) => void };
  };
}

/** Starts provider-scoped channel Runs; API writes Run, chat mapping, and delivery together. */
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
            ...(input.message.sourceMessageTs === undefined
              ? {}
              : { sourceMessageTs: input.message.sourceMessageTs }),
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
