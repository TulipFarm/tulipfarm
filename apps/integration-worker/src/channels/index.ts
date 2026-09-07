import { hostname } from "node:os";
import { SlackChannelAdapter, SlackDeliveryAdapter } from "@tulipfarm/integrations";
import {
  ChannelDeliveryStore,
  ChannelInboundStore,
  ChannelMentionedThreadStore,
  ChannelRunDeliveryStore,
  ChannelSurfaceStore,
  IntegrationStore,
  RunStore,
} from "@tulipfarm/storage";
import type { Pool } from "pg";
import { transactionPort } from "../db";
import { InternalApiClient } from "../internal/client";
import type { DrainableLoop } from "../shutdown";
import {
  dispatchSlackEnvelope,
  reserveSlackEnvelopeReceipt,
  type SlackAppHomeOpenedEvent,
} from "../slack/dispatch";
import { SlackEventPublisher } from "../slack/event-publisher";
import { SlackHomePublisher, startSlackHomePublishLoop } from "../slack/home-publisher";
import { SlackWebApiHttp } from "../slack/http";
import { slackUserDirectoryMentionResolver } from "../slack/mention-resolver";
import { SlackSocketTransport } from "../slack/socket-transport";
import { THINKING_STATUS } from "../slack/thinking-status";
import { SlackSocketWorker } from "../slack/worker";
import { startCommandResponseRecoveryLoop } from "./command-response-recovery";
import { channelDeliveryAuthorization } from "./delivery-authorization";
import { channelDeliveryLedger } from "./delivery-ledger";
import { defaultWait, startDeliveryPollLoop } from "./delivery-poll-loop";
import { httpChannelIdentityBindOfferPort, httpChannelIdentityPort } from "./identity-port";
import { channelInboundStore } from "./inbound-store";
import {
  reserveSlackInteractive,
  reserveSlackResponseInteractive,
  reserveSlackSlashCommand,
} from "./interactive-handler";
import { channelRoutingSource } from "./routing-source";
import { httpChannelRunStarter } from "./run-starter";
import { startSurfaceInteractionRecoveryLoop } from "./surface-interaction-recovery";

export interface SlackChannelDeps {
  businessId: string;
  pool: Pool;
  internalApiUrl: string;
  internalApiCredential: string;
  /** Shared with `main.ts`'s drain controller — aborting it stops both loops below together. */
  signal: AbortSignal;
  log: { info: (message: string) => void; warn: (message: string, error?: unknown) => void };
}

export function slackHomeOpenedHandler(deps: {
  businessId: string;
  integrations: Pick<IntegrationStore, "loadRoutingSnapshot">;
  publish: (event: SlackAppHomeOpenedEvent) => Promise<void>;
}): (event: SlackAppHomeOpenedEvent) => Promise<void> {
  return async (event) => {
    if (event.tab !== "home" || event.externalAppId === undefined) return;
    const snapshot = await deps.integrations.loadRoutingSnapshot(
      deps.businessId,
      "slack",
      event.externalTenantId
    );
    const app = snapshot.apps.find(
      (candidate) =>
        candidate.externalAppId === event.externalAppId && candidate.status === "active"
    );
    const integration = snapshot.integrations.find(
      (candidate) => candidate.appId === app?.id && candidate.status === "active"
    );
    if (integration === undefined) return;
    await deps.publish({ ...event, integrationId: integration.id });
  };
}

interface SlackCredentialResponse {
  configured: boolean;
  botToken?: string;
  appToken?: string;
}

/** Starts Slack loops only when tokens are sealed; disconnected Slack returns no loops. */
export async function createSlackChannelLoops(
  deps: SlackChannelDeps,
  quiet = false
): Promise<DrainableLoop[]> {
  const internalApi = new InternalApiClient({
    baseUrl: deps.internalApiUrl,
    credential: deps.internalApiCredential,
  });
  const responseInternalApi = new InternalApiClient({
    baseUrl: deps.internalApiUrl,
    credential: deps.internalApiCredential,
    timeoutMs: 1_200,
  });
  const reservationInternalApi = new InternalApiClient({
    baseUrl: deps.internalApiUrl,
    credential: deps.internalApiCredential,
    timeoutMs: 2_000,
  });

  let credential: SlackCredentialResponse;
  try {
    credential = await internalApi.require<SlackCredentialResponse>(
      "GET",
      "/api/v1/internal/channels/slack/credential"
    );
  } catch (error) {
    if (!quiet) {
      deps.log.warn("slack credential lease failed; Slack channel disabled for this boot", error);
    }
    return [];
  }
  if (
    !credential.configured ||
    credential.botToken === undefined ||
    credential.appToken === undefined
  ) {
    if (!quiet) {
      deps.log.info("Slack not connected yet; Slack channel disabled for this boot");
    }
    return [];
  }
  const botToken = credential.botToken;
  const appToken = credential.appToken;

  const transactions = transactionPort(deps.pool);
  const now = () => new Date().toISOString();

  const inboundRecords = new ChannelInboundStore(transactions);
  const inbound = channelInboundStore(inboundRecords);
  const integrationStore = new IntegrationStore(transactions);
  const routing = channelRoutingSource(integrationStore);
  const identities = httpChannelIdentityPort(reservationInternalApi);
  const identityBindOffer = httpChannelIdentityBindOfferPort(internalApi, deps.log);
  const runDeliveries = new ChannelRunDeliveryStore(transactions, now);
  const mentionedThreads = new ChannelMentionedThreadStore(transactions, now);
  const deliveryStore = new ChannelDeliveryStore(transactions, now);
  const http = new SlackWebApiHttp();
  const homePublisher = new SlackHomePublisher({
    businessId: deps.businessId,
    store: new ChannelSurfaceStore(transactions, now),
    internalApi,
    http,
    credential: botToken,
    leaseOwner: `${hostname()}:${process.pid}`,
    resolveExternalAppId: async (input) => {
      const snapshot = await integrationStore.loadRoutingSnapshot(
        input.businessId,
        "slack",
        input.externalTenantId
      );
      const integration = snapshot.integrations.find(
        (candidate) => candidate.id === input.integrationId && candidate.status === "active"
      );
      if (integration === undefined) return undefined;
      return snapshot.apps.find((app) => app.id === integration.appId && app.status === "active")
        ?.externalAppId;
    },
    log: deps.log,
  });
  const onAppHomeOpened = slackHomeOpenedHandler({
    businessId: deps.businessId,
    integrations: integrationStore,
    publish: (event) => homePublisher.onAppHomeOpened(event),
  });
  const eventPublisher = new SlackEventPublisher({
    businessId: deps.businessId,
    integrations: integrationStore,
    internalApi: reservationInternalApi,
    log: deps.log,
  });

  const runs = httpChannelRunStarter(reservationInternalApi, "slack");

  const mentions = slackUserDirectoryMentionResolver(http, botToken, deps.log);
  const channelAdapter = new SlackChannelAdapter({
    inbound,
    identities,
    routing,
    runs,
    now,
    mentions,
  });
  const deliveryAdapter = new SlackDeliveryAdapter({
    ledger: channelDeliveryLedger(deliveryStore),
    authorization: channelDeliveryAuthorization(new IntegrationStore(transactions)),
    http,
  });

  const onInteractive = (payload: unknown) =>
    reserveSlackInteractive(payload, {
      provider: "slack",
      internalApi: reservationInternalApi,
      followUpInternalApi: internalApi,
      http,
      credential: botToken,
      log: deps.log,
    });
  const onResponseEnvelope = async (envelope: { envelope_id: string; payload?: unknown }) => {
    await reserveSlackEnvelopeReceipt(
      { envelope_id: envelope.envelope_id, type: "interactive", payload: envelope.payload },
      { businessId: deps.businessId, receipts: inboundRecords, now }
    );
    return reserveSlackResponseInteractive(envelope.payload, {
      provider: "slack",
      internalApi: responseInternalApi,
      followUpInternalApi: internalApi,
      http,
      credential: botToken,
      log: deps.log,
    });
  };
  const onSlashCommand = (payload: unknown, envelopeId: string) =>
    reserveSlackSlashCommand(payload, envelopeId, {
      businessId: deps.businessId,
      provider: "slack",
      internalApi: reservationInternalApi,
      followUpInternalApi: internalApi,
      identities,
      routing,
      runs,
      http,
      credential: botToken,
      log: deps.log,
    });

  const socketTransport = new SlackSocketTransport({
    http,
    appToken,
    log: deps.log,
    onEnvelope: (envelope, ack) =>
      dispatchSlackEnvelope(
        envelope,
        {
          businessId: deps.businessId,
          channelAdapter,
          mentionGate: { businessId: deps.businessId, provider: "slack", mentionedThreads },
          receipts: inboundRecords,
          now,
          identityBindOffer,
          onInteractive,
          onSlashCommand,
          onAppHomeOpened,
          onCuratedEvent: (payload) => eventPublisher.publish(payload),
          onMessageReserved: async ({ channelId, threadId }) => {
            try {
              await http.send(
                {
                  method: "POST",
                  path: "/assistant.threads.setStatus",
                  body: {
                    channel_id: channelId,
                    thread_ts: threadId,
                    status: THINKING_STATUS,
                  },
                },
                botToken
              );
            } catch (error) {
              deps.log.warn("slack assistant status failed", error);
            }
          },
          log: deps.log,
        },
        ack
      ),
    onResponseEnvelope,
  });
  const socketWorker = new SlackSocketWorker(socketTransport);

  const socketLoop: DrainableLoop = {
    name: "slack-socket",
    settled: socketWorker.run(deps.signal),
  };

  const pollLoop = startDeliveryPollLoop(deps.signal, {
    businessId: deps.businessId,
    runDeliveries,
    runs: new RunStore(transactions),
    internalApi,
    delivery: deliveryAdapter,
    credential: botToken,
    http,
    log: deps.log,
  });
  const homeLoop = startSlackHomePublishLoop(deps.signal, homePublisher);
  const surfaceInteractionRecoveryLoop = startSurfaceInteractionRecoveryLoop(deps.signal, {
    internalApi,
    log: deps.log,
  });
  const commandResponseRecoveryLoop = startCommandResponseRecoveryLoop(deps.signal, {
    internalApi,
    log: deps.log,
  });

  return [
    socketLoop,
    pollLoop,
    homeLoop,
    surfaceInteractionRecoveryLoop,
    commandResponseRecoveryLoop,
  ];
}

const CREDENTIAL_POLL_INTERVAL_MS = 30_000;

/** Watches for Slack connection; the wait drains and never starts loops after abort. */
export function watchForSlackChannelCredential(
  deps: SlackChannelDeps,
  onReady: (loops: DrainableLoop[]) => void,
  pollIntervalMs = CREDENTIAL_POLL_INTERVAL_MS
): DrainableLoop {
  const settled = (async () => {
    deps.log.info("Slack not connected yet; watching for connection in the background");
    while (!deps.signal.aborted) {
      const loops = await createSlackChannelLoops(deps, /* quiet */ true);
      if (loops.length > 0) {
        if (deps.signal.aborted) return;
        deps.log.info("Slack connected; starting the socket + delivery-poll loops");
        onReady(loops);
        return;
      }
      await defaultWait(pollIntervalMs, deps.signal);
    }
  })();

  return { name: "slack-credential-watch", settled };
}
