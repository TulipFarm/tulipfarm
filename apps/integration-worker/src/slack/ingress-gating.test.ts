import {
  type ChannelIdentityPort,
  type ChannelInboundEvent,
  type ChannelInboundStore,
  type ChannelRoutingSnapshot,
  type ChannelRoutingSource,
  type IntegrationHttpPort,
  type IntegrationHttpRequest,
  SlackChannelAdapter,
} from "@tulipfarm/integrations";
import type { AccessGrantDefinition } from "@tulipfarm/schema";
import type { ChannelMentionedThreadStore } from "@tulipfarm/storage";
import { beforeEach, describe, expect, it } from "vitest";
import { httpChannelRunStarter } from "../channels/run-starter";
import type { InternalApiClient } from "../internal/client";
import { dispatchSlackEnvelope } from "./dispatch";
import { SlackSocketTransport } from "./socket-transport";

const BUSINESS_ID = "business-1";
const APP_ID = "00000000-0000-4000-8000-000000000001";
const INTEGRATION_ID = "00000000-0000-4000-8000-000000000002";
const AGENT_ID = "00000000-0000-4000-8000-000000000003";
const PRINCIPAL_ID = "00000000-0000-4000-8000-000000000005";
const BOT_USER_ID = "UBOT";
const CHANNEL = "C-OPS";
const DM = "D-OPS";

function grant(): AccessGrantDefinition {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "AccessGrant",
    metadata: {
      id: "00000000-0000-4000-8000-000000000006",
      slug: "slack-channel-access",
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "active",
    },
    spec: {
      integrationId: INTEGRATION_ID,
      principals: [{ kind: "user", id: PRINCIPAL_ID }],
      actions: ["channels.message.receive"],
      externalTargets: [{ type: "slack.channel", ids: [CHANNEL, DM] }],
      delegable: false,
    },
  };
}

function snapshot(): ChannelRoutingSnapshot {
  return {
    apps: [
      {
        id: APP_ID,
        businessId: BUSINESS_ID,
        provider: "slack",
        externalAppId: "A-PRIMARY",
        credentialRefs: ["secret://slack/bot"],
        status: "active",
      },
    ],
    integrations: [
      {
        id: INTEGRATION_ID,
        businessId: BUSINESS_ID,
        appId: APP_ID,
        externalTenantId: "T-ACME",
        credentialRef: "secret://slack/bot",
        status: "active",
      },
    ],
    accessGrants: [grant()],
    routes: [
      {
        id: "route-default",
        businessId: BUSINESS_ID,
        integrationId: INTEGRATION_ID,
        agentId: AGENT_ID,
        channelId: CHANNEL,
        eventTypes: ["message"],
        priority: 10,
        status: "active",
      },
      {
        id: "route-dm",
        businessId: BUSINESS_ID,
        integrationId: INTEGRATION_ID,
        agentId: AGENT_ID,
        channelId: DM,
        eventTypes: ["message"],
        priority: 10,
        status: "active",
      },
    ],
  };
}

/** In-memory stand-in for the `channel_mentioned_threads` table. */
function mentionedThreadStore(seed: readonly string[] = []) {
  const marked = new Set(seed);
  const key = (i: { channelId: string; threadId: string }) => `${i.channelId}:${i.threadId}`;
  return {
    marked,
    store: {
      async mark(input: { channelId: string; threadId: string }) {
        marked.add(key(input));
      },
      async isMentioned(input: { channelId: string; threadId: string }) {
        return marked.has(key(input));
      },
    } as unknown as ChannelMentionedThreadStore,
  };
}

interface Harness {
  /** Every Run the API was asked to mint — one per Turn the bot decided to take. */
  runs: { channelId: string; threadId?: string; text: string }[];
  /** Every Slack Web API call the ingress path made, i.e. everything a human would see. */
  slackCalls: IntegrationHttpRequest[];
  accepted: ChannelInboundEvent[];
  marked: Set<string>;
  warnings: unknown[];
  deliver(event: Record<string, unknown>): Promise<void>;
}

function harness(options: { mentionedThreads?: readonly string[] } = {}): Harness {
  const runs: Harness["runs"] = [];
  const slackCalls: IntegrationHttpRequest[] = [];
  const accepted: ChannelInboundEvent[] = [];
  const mentioned = mentionedThreadStore(options.mentionedThreads);

  const inbound: ChannelInboundStore = {
    async accept(event) {
      accepted.push(event);
      return { outcome: "accepted" };
    },
  };
  const identities: ChannelIdentityPort = {
    async resolve() {
      return { kind: "user", id: PRINCIPAL_ID };
    },
  };
  const routing: ChannelRoutingSource = {
    async load() {
      return snapshot();
    },
  };
  const http: IntegrationHttpPort = {
    async send(request) {
      slackCalls.push(request);
      if (request.path === "/apps.connections.open") {
        return { status: 200, headers: {}, body: { ok: true, url: "wss://slack.test/ws" } };
      }
      return { status: 200, headers: {}, body: { ok: true, ts: "9.9" } };
    },
  };
  const internalApi = {
    async require(_method: string, path: string, body?: unknown) {
      if (path === "/api/v1/internal/channels/runs") {
        const message = (
          body as { message: { channelId: string; threadId?: string; text: string } }
        ).message;
        runs.push(message);
        return { runId: `run-${runs.length}`, outcome: "started" };
      }
      throw new Error(`unexpected internal call ${path}`);
    },
  } as unknown as InternalApiClient;

  const warnings: unknown[] = [];
  const log = {
    info: () => {},
    warn: (message: string, error?: unknown) => {
      warnings.push([message, error instanceof Error ? error.message : error]);
    },
  };
  const channelAdapter = new SlackChannelAdapter({
    inbound,
    identities,
    routing,
    runs: httpChannelRunStarter(internalApi, "slack", {
      assistantStatus: { http, credential: "xoxb-test", log },
    }),
    now: () => "2026-01-01T00:00:00.000Z",
  });

  let onMessage: ((event: { data?: unknown }) => void) | undefined;
  const socket = {
    addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
      if (type === "message") onMessage = listener;
    },
    send() {},
    close() {},
  };

  const transport = new SlackSocketTransport({
    http,
    appToken: "xapp-test",
    openWebSocket: () => socket,
    log,
    onEnvelope: (envelope) =>
      dispatchSlackEnvelope(envelope, {
        businessId: BUSINESS_ID,
        channelAdapter,
        mentionGate: {
          businessId: BUSINESS_ID,
          provider: "slack",
          mentionedThreads: mentioned.store,
        },
        log,
      }),
  });

  let sequence = 0;
  return {
    runs,
    slackCalls,
    accepted,
    marked: mentioned.marked,
    warnings,
    async deliver(event) {
      sequence += 1;
      await transport.connect(new AbortController().signal);
      slackCalls.length = 0;
      const payload = {
        token: "t",
        team_id: "T-ACME",
        api_app_id: "A-PRIMARY",
        event_id: `Ev${sequence}`,
        event_time: 1_720_000_000 + sequence,
        type: "event_callback",
        authorizations: [{ user_id: BOT_USER_ID, is_bot: true }],
        event,
      };
      warnings.length = 0;
      onMessage?.({
        data: JSON.stringify({ envelope_id: `env-${sequence}`, type: "events_api", payload }),
      });
      // `SlackSocketTransport` acks first and dispatches without awaiting; drain the queue.
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe("slack ingress gating (issue #508)", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("1. plain channel chatter starts no Turn and posts nothing", async () => {
    await h.deliver({
      type: "message",
      channel_type: "channel",
      user: "U1",
      channel: CHANNEL,
      ts: "1.1",
      text: "anyone got lunch plans",
    });
    expect(h.runs).toEqual([]);
    expect(h.slackCalls).toEqual([]);
  });

  it("2a. an app_mention starts a Turn", async () => {
    await h.deliver({
      type: "app_mention",
      user: "U1",
      channel: CHANNEL,
      ts: "2.1",
      text: `<@${BOT_USER_ID}> summarize this`,
    });
    expect(h.warnings).toEqual([]);
    expect(h.runs).toHaveLength(1);
    expect(h.slackCalls.map((c) => c.path)).toContain("/assistant.threads.setStatus");
  });

  it("2b. the app_mention/message pair Slack sends for one @mention starts exactly one Turn", async () => {
    // Slack delivers both events for the same @mention; the `message` copy must not double-answer.
    const mention = {
      user: "U1",
      channel: CHANNEL,
      ts: "2.2",
      text: `hey <@${BOT_USER_ID}> can you help`,
    };
    await h.deliver({ ...mention, type: "app_mention" });
    await h.deliver({ ...mention, type: "message", channel_type: "channel" });
    expect(h.warnings).toEqual([]);
    expect(h.runs).toHaveLength(1);
  });

  it("3. a reply in a thread the bot already answered starts a Turn", async () => {
    const seeded = harness({ mentionedThreads: [`${CHANNEL}:3.0`] });
    await seeded.deliver({
      type: "message",
      channel_type: "channel",
      user: "U1",
      channel: CHANNEL,
      ts: "3.1",
      thread_ts: "3.0",
      text: "and the second one?",
    });
    expect(seeded.warnings).toEqual([]);
    expect(seeded.runs).toHaveLength(1);
  });

  it("4. a reply in a thread the bot never joined starts no Turn", async () => {
    await h.deliver({
      type: "message",
      channel_type: "channel",
      user: "U1",
      channel: CHANNEL,
      ts: "4.1",
      thread_ts: "4.0",
      text: "unrelated thread chatter",
    });
    expect(h.runs).toEqual([]);
    expect(h.slackCalls).toEqual([]);
  });

  it("5. a direct message starts a Turn", async () => {
    await h.deliver({
      type: "message",
      channel_type: "im",
      user: "U1",
      channel: DM,
      ts: "5.1",
      text: "hello there",
    });
    expect(h.warnings).toEqual([]);
    expect(h.runs).toHaveLength(1);
  });

  it("6a. the bot's own posted message starts no Turn", async () => {
    await h.deliver({
      type: "message",
      channel_type: "im",
      bot_id: "B123",
      user: BOT_USER_ID,
      channel: DM,
      ts: "6.1",
      text: "here is your answer",
    });
    expect(h.runs).toEqual([]);
    expect(h.slackCalls).toEqual([]);
  });

  it("6b. a message from the bot's own user id without bot_id starts no Turn", async () => {
    await h.deliver({
      type: "message",
      channel_type: "im",
      user: BOT_USER_ID,
      channel: DM,
      ts: "6.2",
      text: "here is your answer",
    });
    expect(h.runs).toEqual([]);
    expect(h.slackCalls).toEqual([]);
  });

  it("7a. a message_changed edit starts no Turn", async () => {
    await h.deliver({
      type: "message",
      subtype: "message_changed",
      channel_type: "im",
      channel: DM,
      ts: "7.1",
      message: { type: "message", user: "U1", ts: "7.0", text: "edited" },
      previous_message: { type: "message", user: "U1", ts: "7.0", text: "original" },
    });
    expect(h.warnings).toEqual([]);
    expect(h.accepted).toEqual([]);
    expect(h.runs).toEqual([]);
    expect(h.slackCalls).toEqual([]);
  });

  it("7b. a message_deleted tombstone starts no Turn", async () => {
    await h.deliver({
      type: "message",
      subtype: "message_deleted",
      channel_type: "im",
      channel: DM,
      ts: "7.2",
      deleted_ts: "7.0",
      previous_message: { type: "message", user: "U1", ts: "7.0", text: "original" },
    });
    expect(h.warnings).toEqual([]);
    expect(h.accepted).toEqual([]);
    expect(h.runs).toEqual([]);
    expect(h.slackCalls).toEqual([]);
  });
});
