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

export interface TelegramUser {
  id?: unknown;
  is_bot?: unknown;
  username?: unknown;
}

export interface TelegramChat {
  id?: unknown;
  type?: unknown;
  title?: unknown;
}

export interface TelegramPhotoSize {
  file_id?: unknown;
  width?: unknown;
  height?: unknown;
  file_size?: unknown;
}

export interface TelegramMedia {
  file_id?: unknown;
  file_name?: unknown;
  mime_type?: unknown;
  file_size?: unknown;
}

export interface TelegramMessage {
  message_id?: unknown;
  date?: unknown;
  message_thread_id?: unknown;
  from?: TelegramUser;
  chat?: TelegramChat;
  text?: unknown;
  caption?: unknown;
  photo?: unknown;
  document?: TelegramMedia;
  audio?: TelegramMedia;
  video?: TelegramMedia;
  voice?: TelegramMedia;
}

export interface TelegramUpdate {
  update_id?: unknown;
  message?: TelegramMessage;
}

export type TelegramReceiveResult =
  | { outcome: "started" | "duplicate"; runId?: string }
  | { outcome: "denied"; reason: string };

export interface TelegramChannelAdapterDeps {
  inbound: ChannelInboundStore;
  identities: ChannelIdentityPort;
  routing: ChannelRoutingSource;
  runs: ChannelRunStarter;
  now: () => string;
}

function requiredId(value: unknown): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new Error("telegram_update_rejected:malformed_payload");
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalSize(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function mediaReference(
  media: TelegramMedia,
  kind: ChannelMediaReference["kind"],
  defaultContentType?: string
): ChannelMediaReference {
  const contentType = optionalString(media.mime_type) ?? defaultContentType;
  const fileName = optionalString(media.file_name);
  const sizeBytes = optionalSize(media.file_size);
  return {
    id: requiredId(media.file_id),
    kind,
    ...(contentType === undefined ? {} : { contentType }),
    ...(fileName === undefined ? {} : { fileName }),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
  };
}

function photoScore(photo: TelegramPhotoSize): number {
  const size = optionalSize(photo.file_size);
  if (size !== undefined) return size;
  return (optionalSize(photo.width) ?? 0) * (optionalSize(photo.height) ?? 0);
}

function normalizeMedia(message: TelegramMessage): ChannelMediaReference[] {
  const media: ChannelMediaReference[] = [];
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const candidates = message.photo.filter(
      (entry): entry is TelegramPhotoSize =>
        entry !== null && typeof entry === "object" && !Array.isArray(entry)
    );
    candidates.sort((left, right) => photoScore(right) - photoScore(left));
    const largest = candidates[0];
    if (largest !== undefined) {
      media.push(
        mediaReference(
          {
            file_id: largest.file_id,
            file_size: largest.file_size,
          },
          "image",
          "image/jpeg"
        )
      );
    }
  }
  if (message.document !== undefined) {
    media.push(mediaReference(message.document, "document"));
  }
  if (message.audio !== undefined) media.push(mediaReference(message.audio, "audio"));
  if (message.video !== undefined) media.push(mediaReference(message.video, "video"));
  if (message.voice !== undefined) {
    media.push(mediaReference(message.voice, "audio", "audio/ogg"));
  }
  return media;
}

function normalizeTelegramUpdate(
  businessId: string,
  externalBotId: string,
  update: TelegramUpdate,
  receivedAt: string
): ChannelInboundEvent {
  const message = update.message;
  if (message === undefined) throw new Error("telegram_update_rejected:unsupported_update");
  if (message.from?.is_bot === true) throw new Error("telegram_update_rejected:bot_message");
  const occurredAt = message.date;
  if (typeof occurredAt !== "number" || !Number.isFinite(occurredAt)) {
    throw new Error("telegram_update_rejected:malformed_payload");
  }
  const updateId = requiredId(update.update_id);
  const channelId = requiredId(message.chat?.id);
  const threadId =
    message.message_thread_id === undefined ? undefined : requiredId(message.message_thread_id);
  return {
    eventId: `telegram:update:${updateId}`,
    type: "telegram.message.received",
    version: 1,
    occurredAt: new Date(occurredAt * 1000).toISOString(),
    receivedAt,
    businessId,
    source: {
      provider: "telegram",
      externalTenantId: externalBotId,
      deliveryId: updateId,
    },
    principal: { kind: "external", externalId: requiredId(message.from?.id) },
    record: { type: "message", id: requiredId(message.message_id) },
    deduplicationKey: updateId,
    classification: ["untrusted.external"],
    data: {
      externalAppId: externalBotId,
      channelId,
      ...(threadId === undefined ? {} : { threadId }),
      text:
        typeof message.text === "string"
          ? message.text
          : typeof message.caption === "string"
            ? message.caption
            : "",
      media: normalizeMedia(message),
    },
    verification: { status: "verified", method: "telegram_bot_update" },
  };
}

export class TelegramChannelAdapter {
  constructor(private readonly deps: TelegramChannelAdapterDeps) {}

  async receive(
    businessId: string,
    externalBotId: string,
    update: TelegramUpdate,
    ack: () => Promise<void>
  ): Promise<TelegramReceiveResult> {
    const inbound = normalizeTelegramUpdate(businessId, externalBotId, update, this.deps.now());
    const accepted = await this.deps.inbound.accept(inbound);
    await ack();
    if (accepted.outcome === "duplicate") return { outcome: "duplicate" };

    const identity = await this.deps.identities.resolve({
      businessId,
      provider: "telegram",
      externalSubject: inbound.principal.externalId,
    });
    if (identity === undefined) {
      return { outcome: "denied", reason: "external_identity_unmapped" };
    }
    const principal = { kind: identity.kind, id: identity.id };
    const snapshot = await this.deps.routing.load({
      businessId,
      provider: "telegram",
      externalTenantId: externalBotId,
    });
    try {
      const route = resolveChannelRoute(snapshot, {
        businessId,
        provider: "telegram",
        externalTenantId: externalBotId,
        externalAppId: externalBotId,
        channelId: inbound.data.channelId,
        ...(inbound.data.threadId === undefined ? {} : { threadId: inbound.data.threadId }),
        eventType: "message",
        principal,
        ...(identity.grantPrincipals === undefined
          ? {}
          : { grantPrincipals: identity.grantPrincipals }),
        action: "channels.message.receive",
        targetType: "telegram.chat",
      });
      const run = await this.deps.runs.start({
        businessId,
        eventId: inbound.eventId,
        integrationId: route.integrationId,
        routeId: route.routeId,
        agentId: route.agentId,
        principal,
        message: inbound.data,
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

export interface TelegramDeliveryRequest extends ChannelDeliveryAttempt {
  text: string;
  agentDisplayName: string;
  threadId?: string;
}

export interface TelegramDeliveryAdapterDeps {
  ledger: ChannelDeliveryLedger;
  authorization: ChannelDeliveryAuthorizationPort;
  http: IntegrationHttpPort;
}

export class TelegramDeliveryError extends Error {
  readonly name = "TelegramDeliveryError";

  constructor(readonly code: string) {
    super(`telegram_delivery_failed:${code}`);
  }
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function telegramMessageId(body: unknown): string | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
  const result = (body as Record<string, unknown>).result;
  if (result === null || typeof result !== "object" || Array.isArray(result)) return undefined;
  const id = (result as Record<string, unknown>).message_id;
  return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
}

function telegramRetryAfterMs(body: unknown): number | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
  const parameters = (body as Record<string, unknown>).parameters;
  if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters)) {
    return undefined;
  }
  const seconds = (parameters as Record<string, unknown>).retry_after;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1000
    : undefined;
}

export class TelegramDeliveryAdapter {
  constructor(private readonly deps: TelegramDeliveryAdapterDeps) {}

  async deliver(
    request: TelegramDeliveryRequest,
    credential: string
  ): Promise<ChannelDeliveryRecord> {
    const attempt: ChannelDeliveryAttempt = {
      businessId: request.businessId,
      integrationId: request.integrationId,
      routeId: request.routeId,
      idempotencyKey: request.idempotencyKey,
      provider: "telegram",
      destination: request.destination,
      agentId: request.agentId,
      principalId: request.principalId,
    };
    const begun = await this.deps.ledger.begin(attempt);
    if (begun.outcome === "duplicate") {
      if (begun.record.status === "confirmed") return begun.record;
      throw new TelegramDeliveryError("delivery_in_progress");
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
      throw new TelegramDeliveryError("integration_revoked");
    }
    if (credential.length === 0) {
      await this.deps.ledger.fail(attempt, { status: "failed", code: "credential_missing" });
      throw new TelegramDeliveryError("credential_missing");
    }

    const numericThreadId =
      request.threadId === undefined ? undefined : Number.parseInt(request.threadId, 10);
    if (request.threadId !== undefined && !Number.isFinite(numericThreadId)) {
      await this.deps.ledger.fail(attempt, { status: "failed", code: "invalid_thread" });
      throw new TelegramDeliveryError("invalid_thread");
    }
    const response = await this.deps.http.send(
      {
        method: "POST",
        path: "/sendMessage",
        body: {
          chat_id: request.destination,
          ...(numericThreadId === undefined ? {} : { message_thread_id: numericThreadId }),
          text: `<b>${escapeHtml(request.agentDisplayName)}</b>\n${escapeHtml(request.text)}`,
          parse_mode: "HTML",
        },
      },
      credential
    );
    const failure = classifyHttpFailure(response, true);
    if (failure !== null) {
      const retryAfterMs = failure.retryAfterMs ?? telegramRetryAfterMs(response.body);
      const status =
        failure.code === "provider_rate_limited"
          ? "retry_wait"
          : failure.phase === "after_dispatch"
            ? "ambiguous"
            : "failed";
      await this.deps.ledger.fail(attempt, {
        status,
        code: failure.code,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      });
      throw new TelegramDeliveryError(failure.code);
    }
    const providerMessageId = telegramMessageId(response.body);
    if (providerMessageId === undefined) {
      await this.deps.ledger.fail(attempt, {
        status: "failed",
        code: "provider_response_malformed",
      });
      throw new TelegramDeliveryError("provider_response_malformed");
    }
    return this.deps.ledger.complete(attempt, providerMessageId);
  }
}
