import type {
  ChannelDeliveryAttempt,
  ChannelDeliveryAuthorizationPort,
  ChannelDeliveryLedger,
  ChannelDeliveryRecord,
  ChannelIdentityPort,
  ChannelInboundEvent,
  ChannelInboundStore,
  ChannelMediaReference,
  ChannelRoutingSource,
  ChannelRunStarter,
} from "../channels";
import { classifyHttpFailure, type IntegrationHttpPort } from "../http";
import { ChannelRouteDeniedError, resolveChannelRoute } from "../model";
import { toSlackMrkdwn } from "./markdown";
import { resolveMentionsInText, type SlackMentionResolverPort } from "./mentions";

export interface SlackFile {
  id?: unknown;
  mimetype?: unknown;
  name?: unknown;
  size?: unknown;
  url_private?: unknown;
}

export interface SlackMessageEvent {
  type?: unknown;
  user?: unknown;
  channel?: unknown;
  ts?: unknown;
  thread_ts?: unknown;
  text?: unknown;
  subtype?: unknown;
  bot_id?: unknown;
  files?: unknown;
}

export interface SlackEventEnvelope {
  token?: unknown;
  team_id?: unknown;
  api_app_id?: unknown;
  event_id?: unknown;
  event_time?: unknown;
  type?: unknown;
  event?: SlackMessageEvent;
}

export type SlackReceiveResult =
  | { outcome: "started" | "duplicate"; runId?: string }
  | { outcome: "denied"; reason: string };

export interface SlackChannelAdapterDeps {
  inbound: ChannelInboundStore;
  identities: ChannelIdentityPort;
  routing: ChannelRoutingSource;
  runs: ChannelRunStarter;
  now: () => string;
  /**
   * Resolves `<@USERID>` mention tokens to display names before the agent sees the message text.
   * Undefined skips resolution — the raw token passes through, matching prior behavior.
   */
  mentions?: SlackMentionResolverPort;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("slack_event_rejected:malformed_payload");
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function mediaKind(contentType: string | undefined): ChannelMediaReference["kind"] {
  if (contentType?.startsWith("image/")) return "image";
  if (contentType?.startsWith("audio/")) return "audio";
  if (contentType?.startsWith("video/")) return "video";
  return "document";
}

function normalizeFiles(value: unknown): ChannelMediaReference[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("slack_event_rejected:malformed_payload");
    }
    const file = raw as SlackFile;
    const contentType = optionalString(file.mimetype);
    const fileName = optionalString(file.name);
    const sizeBytes =
      typeof file.size === "number" && Number.isFinite(file.size) ? file.size : undefined;
    return {
      id: requiredString(file.id),
      kind: mediaKind(contentType),
      ...(contentType === undefined ? {} : { contentType }),
      ...(fileName === undefined ? {} : { fileName }),
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
    };
  });
}

function normalizeSlackEvent(
  businessId: string,
  envelope: SlackEventEnvelope,
  receivedAt: string
): ChannelInboundEvent {
  if (envelope.type !== "event_callback" || envelope.event?.type !== "message") {
    throw new Error("slack_event_rejected:unsupported_event");
  }
  const event = envelope.event;
  if (event.bot_id !== undefined || event.subtype === "bot_message") {
    throw new Error("slack_event_rejected:bot_message");
  }
  const eventTime = envelope.event_time;
  if (typeof eventTime !== "number" || !Number.isFinite(eventTime)) {
    throw new Error("slack_event_rejected:malformed_payload");
  }
  const messageId = requiredString(event.ts);
  const externalTenantId = requiredString(envelope.team_id);
  return {
    eventId: requiredString(envelope.event_id),
    type: "slack.message.received",
    version: 1,
    occurredAt: new Date(eventTime * 1000).toISOString(),
    receivedAt,
    businessId,
    source: {
      provider: "slack",
      externalTenantId,
      deliveryId: requiredString(envelope.event_id),
    },
    principal: { kind: "external", externalId: requiredString(event.user) },
    record: { type: "message", id: messageId },
    deduplicationKey: requiredString(envelope.event_id),
    classification: ["untrusted.external"],
    data: {
      externalAppId: requiredString(envelope.api_app_id),
      channelId: requiredString(event.channel),
      threadId: optionalString(event.thread_ts) ?? messageId,
      sourceMessageTs: messageId,
      text: typeof event.text === "string" ? event.text : "",
      media: normalizeFiles(event.files),
    },
    verification: { status: "verified", method: "slack_signature" },
  };
}

/** Durable inbound Slack boundary. Persistence and ack happen before identity/routing work. */
export class SlackChannelAdapter {
  constructor(private readonly deps: SlackChannelAdapterDeps) {}

  async receive(
    businessId: string,
    envelope: SlackEventEnvelope,
    ack: () => Promise<void>
  ): Promise<SlackReceiveResult> {
    const inbound = normalizeSlackEvent(businessId, envelope, this.deps.now());
    const accepted = await this.deps.inbound.accept(inbound);
    await ack();
    if (accepted.outcome === "duplicate") return { outcome: "duplicate" };

    const principal = await this.deps.identities.resolve({
      businessId,
      provider: "slack",
      externalSubject: inbound.principal.externalId,
    });
    if (principal === undefined) {
      return { outcome: "denied", reason: "external_identity_unmapped" };
    }

    const snapshot = await this.deps.routing.load({
      businessId,
      provider: "slack",
      externalTenantId: inbound.source.externalTenantId ?? "",
    });
    try {
      const route = resolveChannelRoute(snapshot, {
        businessId,
        provider: "slack",
        externalTenantId: inbound.source.externalTenantId ?? "",
        externalAppId: inbound.data.externalAppId,
        channelId: inbound.data.channelId,
        ...(inbound.data.threadId === undefined ? {} : { threadId: inbound.data.threadId }),
        eventType: "message",
        principal,
        action: "channels.message.receive",
        targetType: "slack.channel",
      });
      const resolvedText = this.deps.mentions
        ? await resolveMentionsInText(inbound.data.text, this.deps.mentions).catch(
            () => inbound.data.text
          )
        : inbound.data.text;

      const run = await this.deps.runs.start({
        businessId,
        eventId: inbound.eventId,
        integrationId: route.integrationId,
        routeId: route.routeId,
        agentId: route.agentId,
        principal,
        message: { ...inbound.data, text: resolvedText },
      });
      return { outcome: run.outcome, runId: run.runId };
    } catch (error) {
      if (error instanceof ChannelRouteDeniedError) {
        return { outcome: "denied", reason: error.reason };
      }
      throw error;
    }
  }
}

export interface SlackDeliveryRequest extends ChannelDeliveryAttempt {
  text: string;
  agentDisplayName: string;
  threadId?: string;
  /**
   * When present, the final answer overwrites this placeholder message (`chat.update`) instead of
   * posting a new one — the "thinking" status indicator's message `ts`, captured at Run-mint time.
   */
  updateTs?: string;
  /** Caller-rendered Block Kit; this package stays free of `@tulipfarm/surface-slack`. */
  blocks?: readonly Record<string, unknown>[];
}

export interface SlackDeliveryAdapterDeps {
  ledger: ChannelDeliveryLedger;
  authorization: ChannelDeliveryAuthorizationPort;
  http: IntegrationHttpPort;
}

export class SlackDeliveryError extends Error {
  readonly name = "SlackDeliveryError";

  constructor(readonly code: string) {
    super(`slack_delivery_failed:${code}`);
  }
}

function slackMessageId(body: unknown): string | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  return record.ok === true && typeof record.ts === "string" ? record.ts : undefined;
}

/** Durable, idempotent Slack Web API delivery with current-state authorization. */
export class SlackDeliveryAdapter {
  constructor(private readonly deps: SlackDeliveryAdapterDeps) {}

  async deliver(request: SlackDeliveryRequest, credential: string): Promise<ChannelDeliveryRecord> {
    const attempt: ChannelDeliveryAttempt = {
      businessId: request.businessId,
      integrationId: request.integrationId,
      routeId: request.routeId,
      idempotencyKey: request.idempotencyKey,
      provider: "slack",
      destination: request.destination,
      agentId: request.agentId,
      principalId: request.principalId,
    };
    const begun = await this.deps.ledger.begin(attempt);
    if (begun.outcome === "duplicate") {
      if (begun.record.status === "confirmed") return begun.record;
      throw new SlackDeliveryError("delivery_in_progress");
    }

    const authorization = await this.deps.authorization.authorize({
      businessId: attempt.businessId,
      integrationId: attempt.integrationId,
      routeId: attempt.routeId,
      agentId: attempt.agentId,
      principalId: attempt.principalId,
      destination: attempt.destination,
    });
    if (authorization === "revoked") {
      await this.deps.ledger.fail(attempt, {
        status: "revoked",
        code: "integration_revoked",
      });
      throw new SlackDeliveryError("integration_revoked");
    }
    if (credential.length === 0) {
      await this.deps.ledger.fail(attempt, { status: "failed", code: "credential_missing" });
      throw new SlackDeliveryError("credential_missing");
    }

    const text = toSlackMrkdwn(request.text);
    const response = await this.deps.http.send(
      request.updateTs === undefined
        ? {
            method: "POST",
            path: "/chat.postMessage",
            body: {
              channel: request.destination,
              text,
              ...(request.threadId === undefined ? {} : { thread_ts: request.threadId }),
              ...(request.blocks === undefined ? {} : { blocks: request.blocks }),
              client_msg_id: request.idempotencyKey,
            },
          }
        : {
            method: "POST",
            path: "/chat.update",
            body: {
              channel: request.destination,
              ts: request.updateTs,
              text,
              ...(request.blocks === undefined ? {} : { blocks: request.blocks }),
            },
          },
      credential
    );
    const failure = classifyHttpFailure(response, true);
    if (failure !== null) {
      const status =
        failure.code === "provider_rate_limited"
          ? "retry_wait"
          : failure.phase === "after_dispatch"
            ? "ambiguous"
            : "failed";
      await this.deps.ledger.fail(attempt, {
        status,
        code: failure.code,
        ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
      });
      throw new SlackDeliveryError(failure.code);
    }

    const providerMessageId = slackMessageId(response.body);
    if (providerMessageId === undefined) {
      await this.deps.ledger.fail(attempt, {
        status: "failed",
        code: "provider_response_malformed",
      });
      throw new SlackDeliveryError("provider_response_malformed");
    }
    return this.deps.ledger.complete(attempt, providerMessageId);
  }

  /** Best-effort placeholder update; never touches the durable delivery ledger. */
  async update(
    input: { destination: string; ts: string; text: string },
    credential: string
  ): Promise<void> {
    await this.deps.http.send(
      {
        method: "POST",
        path: "/chat.update",
        body: { channel: input.destination, ts: input.ts, text: input.text },
      },
      credential
    );
  }

  /** Best-effort native Slack assistant status; never touches the delivery ledger. */
  async setStatus(
    input: { destination: string; threadId: string; status: string },
    credential: string
  ): Promise<void> {
    await this.deps.http.send(
      {
        method: "POST",
        path: "/assistant.threads.setStatus",
        body: { channel_id: input.destination, thread_ts: input.threadId, status: input.status },
      },
      credential
    );
  }
}
