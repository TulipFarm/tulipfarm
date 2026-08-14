import { SlackChannelAdapter, SlackDeliveryAdapter } from "@tulipfarm/integrations";
import {
  ChannelDeliveryStore,
  ChannelInboundStore,
  ChannelMentionedThreadStore,
  ChannelRunDeliveryStore,
  IntegrationStore,
  RunStore,
} from "@tulipfarm/storage";
import type { Pool } from "pg";
import { transactionPort } from "../db";
import { InternalApiClient } from "../internal/client";
import type { DrainableLoop } from "../shutdown";
import { dispatchSlackEnvelope } from "../slack/dispatch";
import { SlackWebApiHttp } from "../slack/http";
import { slackUserDirectoryMentionResolver } from "../slack/mention-resolver";
import { SlackSocketTransport } from "../slack/socket-transport";
import { SlackSocketWorker } from "../slack/worker";
import { channelDeliveryAuthorization } from "./delivery-authorization";
import { channelDeliveryLedger } from "./delivery-ledger";
import { defaultWait, startDeliveryPollLoop } from "./delivery-poll-loop";
import { httpChannelIdentityBindOfferPort, httpChannelIdentityPort } from "./identity-port";
import { channelInboundStore } from "./inbound-store";
import { handleSlackInteractive } from "./interactive-handler";
import { channelRoutingSource } from "./routing-source";
import { httpChannelRunStarter } from "./run-starter";

export interface SlackChannelDeps {
  businessId: string;
  pool: Pool;
  internalApiUrl: string;
  internalApiCredential: string;
  /** Shared with `main.ts`'s drain controller — aborting it stops both loops below together. */
  signal: AbortSignal;
  log: { info: (message: string) => void; warn: (message: string, error?: unknown) => void };
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

  const inbound = channelInboundStore(new ChannelInboundStore(transactions));
  const routing = channelRoutingSource(new IntegrationStore(transactions));
  const identities = httpChannelIdentityPort(internalApi);
  const identityBindOffer = httpChannelIdentityBindOfferPort(internalApi, deps.log);
  const runDeliveries = new ChannelRunDeliveryStore(transactions, now);
  const mentionedThreads = new ChannelMentionedThreadStore(transactions, now);
  const deliveryStore = new ChannelDeliveryStore(transactions, now);
  const http = new SlackWebApiHttp();

  const runs = httpChannelRunStarter(internalApi, "slack", {
    assistantStatus: { http, credential: botToken, log: deps.log },
  });

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

  const onInteractive = async (payload: unknown): Promise<void> => {
    await handleSlackInteractive(payload, {
      provider: "slack",
      internalApi,
      http,
      credential: botToken,
      log: deps.log,
    });
  };

  const socketTransport = new SlackSocketTransport({
    http,
    appToken,
    log: deps.log,
    onEnvelope: (envelope) =>
      dispatchSlackEnvelope(envelope, {
        businessId: deps.businessId,
        channelAdapter,
        mentionGate: { businessId: deps.businessId, provider: "slack", mentionedThreads },
        identityBindOffer,
        onInteractive,
        log: deps.log,
      }),
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

  return [socketLoop, pollLoop];
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
