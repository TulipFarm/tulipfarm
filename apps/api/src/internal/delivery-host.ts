import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { ArtifactService } from "@tulipfarm/run-kernel";
import {
  chatRequestArtifactId,
  INVOKE_STATE_KEY,
  RUN_EXECUTOR_PRINCIPAL_REF,
  requestArtifactId,
} from "@tulipfarm/run-kernel";
import { CHAT_REQUEST_SCHEMA_REF } from "@tulipfarm/schema";
import type { ChatIngressConfig, SoulLoader } from "@tulipfarm/soul";
import { DOMAIN_EVENTS, type IntegrationEventPayload } from "@tulipfarm/storage";
import type { FastifyBaseLogger } from "fastify";
import type { ToolRegistry } from "../broker/tool-adapter";
import type { ConversationRepo } from "../chat/conversations";
import type { ConversationStore, PersistedTurn } from "../conversations/service";
import type { IngressIdentityResolver } from "../ingress/identity";
import type { IntegrationConversationsRepo, IntegrationEventsRepo } from "../ingress/repo";
import { postReply } from "../ingress/responder";
import { dotPath, renderBodyTemplate } from "../ingress/template";
import { isSecretRef } from "../integrations/connection-env";
import type { HostedRunReader } from "./turn-host";

/** Delivery host: re-derive delivery facts from the Run; never send bind links/text to Worker. */

/** User-facing replies for turns that produced no answer — generic on purpose. */
const GUARD_BLOCK_REPLY = "I can't help with that request.";
const ERROR_REPLY = "Something went wrong handling that — please try again.";

export type DeliveryDenial =
  | "run_not_found"
  | "run_not_running"
  | "not_a_delivery"
  | "integration_unavailable";

export class DeliveryDeniedError extends Error {
  readonly name = "DeliveryDeniedError";

  constructor(readonly code: DeliveryDenial) {
    super(code);
  }
}

/** The Run source a delivery is minted under; anything else is not a delivery at all. */
const DELIVERY_SOURCE = "integration";

/** One delivery, resolved from the Run rather than from whoever asked about it. */
interface DeliveryAuthority {
  readonly businessId: string;
  readonly runId: string;
  readonly slug: string;
  readonly protocol: string;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;
  readonly classifier: { readonly source: string; readonly hash: string };
  readonly chat?: ChatIngressConfig;
  readonly eventTypes?: readonly string[];
  readonly dedupKey?: string;
  /** The external thread this delivery belongs to; absent when the manifest declares no chat. */
  readonly threadKey?: string;
  /** Manifest-declared, non-secret connection env the classifier is entitled to see. */
  readonly env: Record<string, string>;
}

/** What the Worker needs before it can classify one delivery. */
export interface DeliveryDescription {
  readonly slug: string;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;
  /** The Integration's `classify` module and the hash the sandbox must verify it against. */
  readonly classifier: { readonly source: string; readonly hash: string };
  /** Thread mapping is computed here because the isolate has no I/O. */
  readonly hasThreadMapping: boolean;
  readonly chatEnabled: boolean;
  readonly eventsEnabled: boolean;
  /** Non-secret `ingress.context_env` values for classifier self-identification. */
  readonly env: Record<string, string>;
}

export type AttachChatResult =
  | { readonly outcome: "attached"; readonly turnId: string; readonly attempt: number }
  | { readonly outcome: "unlinked" }
  | { readonly outcome: "ignored"; readonly reason: string };

export type RecordEventResult =
  | { readonly outcome: "recorded"; readonly eventId: string }
  | { readonly outcome: "ignored"; readonly reason: string };

/** How the Worker's turn ended. Selects among *this app's* replies; it never supplies wording. */
export type ReplyOutcome = "answered" | "blocked" | "failed";

export interface IngressDeliveryHostOptions {
  readonly runs: HostedRunReader;
  readonly artifacts: ArtifactService;
  readonly store: ConversationStore;
  readonly conversations: Pick<ConversationRepo, "create">;
  readonly threads: IntegrationConversationsRepo;
  readonly integrationEvents: IntegrationEventsRepo;
  readonly soulLoader: SoulLoader;
  readonly identity: Pick<IngressIdentityResolver, "resolve">;
  /** The Integration's own MCP tools, used for identity lookups and replies. */
  readonly toolRegistry?: ToolRegistry;
  /** Domain-event bus; recorded Integration events fan out to Routine event triggers. */
  readonly domainEvents?: EventEmitter;
  /** Renders the confirmation URL a bind token is offered as. */
  bindLinkUrl(token: string): string;
  readonly log: FastifyBaseLogger;
  newId?(): string;
  now?(): Date;
}

export class IngressDeliveryHost {
  private readonly newId: () => string;
  private readonly now: () => Date;

  constructor(private readonly options: IngressDeliveryHostOptions) {
    this.newId = options.newId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async describe(businessId: string, runId: string): Promise<DeliveryDescription> {
    const delivery = await this.authority(businessId, runId);
    return {
      slug: delivery.slug,
      body: delivery.body,
      headers: delivery.headers,
      classifier: delivery.classifier,
      hasThreadMapping: await this.hasThreadMapping(delivery),
      chatEnabled: delivery.chat !== undefined,
      eventsEnabled: delivery.eventTypes !== undefined,
      env: delivery.env,
    };
  }

  /** Turns a `chat` decision into one Turn on this Run; idempotent if a Turn already exists. */
  async attachChat(
    businessId: string,
    runId: string,
    decision: {
      sender: string;
      text: string;
      requireExistingThread?: boolean;
      reply: { binding: string; vars?: Record<string, string> };
    }
  ): Promise<AttachChatResult> {
    const delivery = await this.authority(businessId, runId);
    const chat = delivery.chat;
    if (chat === undefined || delivery.threadKey === undefined) {
      return { outcome: "ignored", reason: "chat_not_declared" };
    }

    const existing = await this.options.store.findTurnByRunId(businessId, runId);
    if (existing !== undefined) {
      return { outcome: "attached", turnId: existing.id, attempt: existing.attempt };
    }

    const mapping = await this.options.threads.find(delivery.slug, delivery.threadKey);
    if (decision.requireExistingThread === true && mapping === null) {
      return { outcome: "ignored", reason: "no_thread_mapping" };
    }

    const resolution = await this.options.identity.resolve({
      slug: delivery.slug,
      sender: decision.sender,
      ...(chat.identity === undefined ? {} : { identity: chat.identity }),
      ...(this.options.toolRegistry === undefined ? {} : { registry: this.options.toolRegistry }),
    });
    if (resolution.outcome === "unlinked") {
      await this.offerBind(delivery, chat, decision, resolution.bindOffer);
      return { outcome: "unlinked" };
    }
    const user = resolution.user;

    // A verified sender may still not be the person this thread belongs to. Answering anyway would
    // hand one account's conversation history to another account's channel identity.
    if (mapping !== null && mapping.userId !== user._id) {
      this.options.log.warn(
        { slug: delivery.slug, runId },
        "channel sender does not own the mapped Conversation; refusing the turn"
      );
      return { outcome: "ignored", reason: "sender_not_thread_owner" };
    }

    const now = this.now();
    let conversationId = mapping?.conversationId;
    if (conversationId === undefined) {
      conversationId = this.newId();
      await this.options.conversations.create({
        _id: conversationId,
        userId: user._id,
        createdAt: now,
        updatedAt: now,
      });
      await this.options.threads.insert({
        integrationSlug: delivery.slug,
        externalKey: delivery.threadKey,
        conversationId,
        userId: user._id,
      });
    }

    const turnId = this.newId();
    const messageId = this.newId();
    await this.options.store.appendMessage({
      id: messageId,
      businessId,
      conversationId,
      turnId,
      role: "user",
      content: decision.text,
      createdAt: now,
    });
    const turn: PersistedTurn = {
      id: turnId,
      businessId,
      conversationId,
      // Keyed by the Run, not by the delivery: the delivery was already deduped when it was
      // acknowledged, and one Run answers exactly one Turn.
      idempotencyKey: `${runId}:ingress`,
      requestMessageId: messageId,
      status: "running",
      attempt: 1,
      runId,
      cursor: 0,
      supersededRunIds: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.options.store.saveTurn(turn);

    // The derived Chat request, with lineage back to the raw envelope. This is what the Worker's
    // turn actually runs off, so "what was the model asked?" and "which delivery asked it?" are
    // one recorded chain rather than two records that happen to agree.
    await this.options.artifacts.publish({
      id: chatRequestArtifactId(runId),
      businessId,
      schemaRef: CHAT_REQUEST_SCHEMA_REF,
      value: {
        conversationId,
        message: { role: "user", content: decision.text },
        autonomy: "full",
      },
      storage: "inline",
      classification: [],
      acl: {
        readers: [...new Set([RUN_EXECUTOR_PRINCIPAL_REF, `user:${user._id}`])],
      },
      retention: { policy: "standard", expiresAt: null },
      redaction: { redactedPaths: [] },
      producer: { runId, stateKey: INVOKE_STATE_KEY, attempt: 0 },
      createdAt: now.toISOString(),
      derivedFrom: [requestArtifactId(runId)],
    });

    return { outcome: "attached", turnId, attempt: 1 };
  }

  /** Records an `event` decision, gated by what the manifest actually declares. */
  async recordEvent(
    businessId: string,
    runId: string,
    event: { eventType: string; payload?: Record<string, unknown> }
  ): Promise<RecordEventResult> {
    const delivery = await this.authority(businessId, runId);
    const allowed = delivery.eventTypes;
    if (allowed === undefined) return { outcome: "ignored", reason: "events_not_declared" };
    // An empty allowlist means "every event this Integration classifies"; a non-empty one is the
    // manifest naming the events it handles, and an unnamed event is not one of them.
    if (allowed.length > 0 && !allowed.includes(event.eventType)) {
      return { outcome: "ignored", reason: "event_type_not_allowlisted" };
    }

    const payload = event.payload ?? delivery.body;
    const record = await this.options.integrationEvents.insert({
      integrationSlug: delivery.slug,
      protocol: delivery.protocol,
      eventType: event.eventType,
      ...(delivery.dedupKey === undefined ? {} : { externalId: delivery.dedupKey }),
      payload,
    });
    const emitted: IntegrationEventPayload = {
      integration: delivery.slug,
      protocol: delivery.protocol,
      event: event.eventType,
      eventId: record.id,
      payload,
    };
    this.options.domainEvents?.emit(DOMAIN_EVENTS.INTEGRATION_EVENT, emitted);
    return { outcome: "recorded", eventId: record.id };
  }

  /** Posts text read from the durable assistant Message, never caller-supplied text. */
  async postReplyForAttempt(
    businessId: string,
    runId: string,
    input: {
      attempt: number;
      outcome: ReplyOutcome;
      binding: string;
      vars?: Record<string, string>;
    }
  ): Promise<{ delivered: boolean }> {
    const delivery = await this.authority(businessId, runId);
    const chat = delivery.chat;
    if (chat === undefined) return { delivered: false };

    const turn = await this.options.store.findTurnByRunId(businessId, runId);
    if (turn === undefined) return { delivered: false };

    await postReply(
      {
        ...(this.options.toolRegistry === undefined ? {} : { registry: this.options.toolRegistry }),
        log: this.options.log,
      },
      {
        slug: delivery.slug,
        reply: chat.reply,
        binding: input.binding,
        vars: input.vars ?? {},
        text: await this.replyText(businessId, turn, input.attempt, input.outcome),
        // Stable per (run, attempt, binding): a provider redelivering the webhook reserves the
        // same Effect and replays instead of posting the answer a second time.
        run: { runId, toolCallId: `ingress-reply:${input.attempt}:${input.binding}` },
      }
    );
    return { delivered: true };
  }

  /** The recorded answer, or the fixed reply that stands in when there is none. */
  private async replyText(
    businessId: string,
    turn: PersistedTurn,
    attempt: number,
    outcome: ReplyOutcome
  ): Promise<string> {
    const fallback = outcome === "blocked" ? GUARD_BLOCK_REPLY : ERROR_REPLY;
    if (outcome !== "answered") return fallback;

    const completion = await this.options.store.findCompletion(businessId, turn.id, attempt);
    if (completion?.status !== "succeeded" || completion.messageId === null) return ERROR_REPLY;
    const messages = await this.options.store.listMessages(businessId, turn.conversationId);
    const answer = messages.find((message) => message.id === completion.messageId);
    return answer?.content.trim() || ERROR_REPLY;
  }

  /** Sends single-use bind links from this process only; the Worker never receives them. */
  private async offerBind(
    delivery: DeliveryAuthority,
    chat: ChatIngressConfig,
    decision: { reply: { binding: string; vars?: Record<string, string> } },
    offer: { token: string; expiresAt: Date } | null
  ): Promise<void> {
    if (offer === null) {
      this.options.log.warn(
        { slug: delivery.slug, runId: delivery.runId },
        "unlinked channel sender and no bind link could be issued; denying without an offer"
      );
      return;
    }
    await postReply(
      {
        ...(this.options.toolRegistry === undefined ? {} : { registry: this.options.toolRegistry }),
        log: this.options.log,
      },
      {
        slug: delivery.slug,
        reply: chat.reply,
        binding: decision.reply.binding,
        vars: decision.reply.vars ?? {},
        run: { runId: delivery.runId, toolCallId: `ingress-bind-offer:${decision.reply.binding}` },
        text:
          "I don't know who you are yet. Open this link while signed in to TulipFarm to " +
          `connect this account: ${this.options.bindLinkUrl(offer.token)} — it works once and ` +
          "expires in 15 minutes.",
      }
    );
  }

  private async hasThreadMapping(delivery: DeliveryAuthority): Promise<boolean> {
    if (delivery.threadKey === undefined) return false;
    return this.options.threads.exists(delivery.slug, delivery.threadKey);
  }

  /** Resolves a delivery Run from its immutable request Artifact and refuses stale authority. */
  private async authority(businessId: string, runId: string): Promise<DeliveryAuthority> {
    const run = await this.options.runs.find(businessId, runId);
    if (run === null) throw new DeliveryDeniedError("run_not_found");
    if (run.status !== "running") throw new DeliveryDeniedError("run_not_running");
    if (run.source !== DELIVERY_SOURCE) {
      throw new DeliveryDeniedError("not_a_delivery");
    }

    const artifact = await this.options.artifacts.read({
      businessId,
      artifactId: requestArtifactId(runId),
      reader: RUN_EXECUTOR_PRINCIPAL_REF,
      allowedClassifications: [],
      now: this.now(),
    });
    const envelope = artifact.content as {
      slug: string;
      body: Record<string, unknown>;
      headers?: Record<string, string>;
    };

    const integration = this.options.soulLoader.integrations.get(envelope.slug);
    const ingress = integration?.manifest.ingress;
    const handler = integration?.ingressHandler;
    if (!integration?.connection?.enabled || ingress === undefined || handler === undefined) {
      throw new DeliveryDeniedError("integration_unavailable");
    }

    const threadKey = ingress.chat
      ? renderBodyTemplate(ingress.chat.thread_key, envelope.body)
      : undefined;
    const dedupValue = ingress.webhook.dedup_key
      ? dotPath(envelope.body, ingress.webhook.dedup_key)
      : undefined;

    return {
      businessId,
      runId,
      slug: envelope.slug,
      protocol: integration.sourceIntegration,
      body: envelope.body,
      headers: envelope.headers ?? {},
      classifier: handler,
      env: classifierEnv(ingress.context_env, integration.connection.env),
      ...(ingress.chat === undefined ? {} : { chat: ingress.chat }),
      ...(ingress.events === undefined ? {} : { eventTypes: ingress.events.types ?? [] }),
      ...(typeof dedupValue === "string" ? { dedupKey: dedupValue } : {}),
      ...(threadKey === undefined ? {} : { threadKey }),
    };
  }
}

/** Classifier-visible connection env; unresolved `secret://` refs are omitted, never leaked. */
function classifierEnv(
  declared: readonly string[] | undefined,
  env: Record<string, string> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of declared ?? []) {
    const value = env?.[name];
    if (value !== undefined && !isSecretRef(value)) out[name] = value;
  }
  return out;
}
