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
import {
  classifyHttpFailure,
  type IntegrationHttpPort,
  type IntegrationHttpResponse,
} from "../http";
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

/** Durable inbound Slack boundary. Ack follows the idempotent Run reservation, never execution. */
export class SlackChannelAdapter {
  constructor(private readonly deps: SlackChannelAdapterDeps) {}

  async receive(
    businessId: string,
    envelope: SlackEventEnvelope,
    ack: () => Promise<void>
  ): Promise<SlackReceiveResult> {
    const inbound = normalizeSlackEvent(businessId, envelope, this.deps.now());
    await this.deps.inbound.accept(inbound);

    const principal = await this.deps.identities.resolve({
      businessId,
      provider: "slack",
      externalSubject: inbound.principal.externalId,
      externalTenantId: inbound.source.externalTenantId,
    });
    if (principal === undefined) {
      await ack();
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
      await ack();
      return { outcome: run.outcome, runId: run.runId };
    } catch (error) {
      if (error instanceof ChannelRouteDeniedError) {
        await ack();
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
  now?: () => number;
}

export class SlackDeliveryError extends Error {
  readonly name = "SlackDeliveryError";

  constructor(
    readonly code: string,
    readonly retryable = false,
    readonly retryAfterMs = 5000
  ) {
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
      const now = this.deps.now?.() ?? Date.now();
      if (
        begun.record.status === "ambiguous" ||
        (begun.record.status === "pending" &&
          begun.record.updatedAt !== undefined &&
          Date.parse(begun.record.updatedAt) + 60_000 <= now)
      ) {
        if (request.updateTs !== undefined) {
          await this.deps.ledger.fail(attempt, {
            status: "retry_wait",
            code: "idempotent_update_recovery",
            retryAfterMs: 0,
          });
          return this.deliver(request, credential);
        }
        return this.reconcile(request, credential, attempt);
      }
      const retryable = ["pending", "retry_wait", "ambiguous"].includes(begun.record.status);
      throw new SlackDeliveryError(
        "delivery_in_progress",
        retryable,
        begun.record.nextAttemptAt === undefined
          ? 5000
          : Math.max(1000, Date.parse(begun.record.nextAttemptAt) - now)
      );
    }

    let authorization: "allowed" | "revoked";
    try {
      authorization = await this.deps.authorization.authorize(attempt);
    } catch {
      await this.deps.ledger.fail(attempt, {
        status: "retry_wait",
        code: "authorization_unavailable",
        retryAfterMs: 5000,
      });
      throw new SlackDeliveryError("authorization_unavailable", true);
    }
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
    let response: IntegrationHttpResponse;
    try {
      response = await this.deps.http.send(
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
                metadata: {
                  event_type: "tulipfarm_delivery",
                  event_payload: { id: request.idempotencyKey },
                },
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
    } catch {
      await this.deps.ledger.fail(attempt, {
        status: request.updateTs === undefined ? "ambiguous" : "retry_wait",
        code: "provider_unavailable",
        retryAfterMs: 5000,
      });
      throw new SlackDeliveryError("provider_unavailable", true);
    }
    const failure = classifyHttpFailure(
      response,
      true,
      "Retry-After",
      new Date(this.deps.now?.() ?? Date.now())
    );
    if (failure !== null) {
      const retryable = failure.retryable || failure.code === "provider_unauthorized";
      const retryAfterMs =
        failure.retryAfterMs ?? (failure.code === "provider_unauthorized" ? 30_000 : 5000);
      // Slack does not promise idempotency for chat.postMessage. An uncertain write must
      // reconcile its receipt, not trust client_msg_id to prevent a second message.
      const status = retryable
        ? failure.phase === "after_dispatch" && request.updateTs === undefined
          ? "ambiguous"
          : "retry_wait"
        : "failed";
      await this.deps.ledger.fail(attempt, {
        status,
        code: failure.code,
        ...(retryable ? { retryAfterMs } : {}),
      });
      throw new SlackDeliveryError(failure.code, retryable, retryAfterMs);
    }

    const providerMessageId = slackMessageId(response.body);
    if (providerMessageId === undefined) {
      const body = response.body as { ok?: boolean; error?: string } | undefined;
      const code = body?.ok === false && typeof body.error === "string" ? body.error : undefined;
      const retryable =
        code !== undefined &&
        ["invalid_auth", "token_revoked", "token_expired", "not_authed", "ratelimited"].includes(
          code
        );
      const permanent =
        code !== undefined &&
        [
          "channel_not_found",
          "not_in_channel",
          "is_archived",
          "missing_scope",
          "msg_too_long",
          "invalid_blocks",
          "no_text",
        ].includes(code);
      await this.deps.ledger.fail(attempt, {
        status: retryable ? "retry_wait" : permanent ? "failed" : "ambiguous",
        code: code ?? "provider_response_malformed",
        ...(retryable ? { retryAfterMs: 30_000 } : {}),
      });
      throw new SlackDeliveryError(code ?? "provider_response_malformed", !permanent, 30_000);
    }
    return this.deps.ledger.complete(attempt, providerMessageId);
  }

  private async reconcile(
    request: SlackDeliveryRequest,
    credential: string,
    attempt: ChannelDeliveryAttempt
  ): Promise<ChannelDeliveryRecord> {
    const authorized = await this.deps.authorization.authorize(attempt);
    if (authorized !== "allowed") throw new SlackDeliveryError("integration_revoked");
    const identity = await this.deps.http.send({ method: "POST", path: "/auth.test" }, credential);
    const identityFailure = classifyHttpFailure(
      identity,
      false,
      "Retry-After",
      new Date(this.deps.now?.() ?? Date.now())
    );
    if (identityFailure !== null) {
      throw new SlackDeliveryError(
        identityFailure.code,
        true,
        identityFailure.retryAfterMs ?? 30_000
      );
    }
    const identityBody = identity.body as { ok?: boolean; user_id?: string } | undefined;
    if (identityBody?.ok !== true || typeof identityBody.user_id !== "string") {
      throw new SlackDeliveryError("delivery_reconciliation_unavailable", true, 30_000);
    }
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const response = await this.deps.http.send(
        {
          method: "GET",
          path:
            request.threadId === undefined ? "/conversations.history" : "/conversations.replies",
          query: {
            channel: request.destination,
            limit: "100",
            include_all_metadata: "true",
            ...(request.threadId === undefined ? {} : { ts: request.threadId }),
            ...(cursor === undefined ? {} : { cursor }),
          },
        },
        credential
      );
      const failure = classifyHttpFailure(
        response,
        false,
        "Retry-After",
        new Date(this.deps.now?.() ?? Date.now())
      );
      if (failure !== null) {
        throw new SlackDeliveryError(failure.code, true, failure.retryAfterMs ?? 30_000);
      }
      const body = response.body as
        | {
            ok?: boolean;
            messages?: {
              ts?: string;
              user?: string;
              client_msg_id?: string;
              metadata?: {
                event_type?: string;
                event_payload?: { id?: string };
              };
            }[];
            response_metadata?: { next_cursor?: string };
          }
        | undefined;
      if (body?.ok !== true || !Array.isArray(body.messages)) {
        throw new SlackDeliveryError("delivery_reconciliation_unavailable", true, 30_000);
      }
      const receipt = body.messages.find(
        (message) =>
          message.user === identityBody.user_id &&
          (message.client_msg_id === request.idempotencyKey ||
            (message.metadata?.event_type === "tulipfarm_delivery" &&
              message.metadata.event_payload?.id === request.idempotencyKey))
      );
      if (receipt?.ts !== undefined) {
        return this.deps.ledger.complete(attempt, receipt.ts);
      }
      cursor = body.response_metadata?.next_cursor?.trim();
      if (!cursor) break;
    }
    throw new SlackDeliveryError("delivery_outcome_unknown", true, 30_000);
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
