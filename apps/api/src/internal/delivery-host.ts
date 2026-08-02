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
import type { FastifyBaseLogger } from "fastify";
import type { ToolRegistry } from "../broker/tool-adapter";
import type { ConversationRepo } from "../chat/conversations";
import type { ConversationStore, PersistedTurn } from "../conversations/service";
import { DOMAIN_EVENTS, type IntegrationEventPayload } from "../domain-events";
import type { IngressIdentityResolver } from "../ingress/identity";
import type { IntegrationConversationsRepo, IntegrationEventsRepo } from "../ingress/repo";
import { postReply } from "../ingress/responder";
import { dotPath, renderBodyTemplate } from "../ingress/template";
import type { HostedRunReader } from "./turn-host";

/**
 * The internal delivery host — what a channel Run calls back into (plan §6).
 *
 * A verified Integration delivery is acknowledged and stored as a Run before anything interprets
 * it. The Worker then executes that Run: it classifies the envelope in its own sandbox and comes
 * back here to turn a `chat` decision into a Turn, an `event` decision into a recorded event, and
 * a finished turn into a reply on the channel it came from. Everything it needs that lives in this
 * app — the Soul manifest, the conversation tables, the identity mappings, the Integration's own
 * MCP tools — it reaches only through this class.
 *
 * The same rule as the turn host governs it: **the caller states which Run, never as whom.** The
 * slug, the envelope, the thread key, and the manifest are all re-derived from the Run's immutable
 * request Artifact, so a worker cannot claim a delivery arrived on an Integration it did not, nor
 * point a reply at a thread the delivery never named.
 *
 * Two things deliberately never cross to the Worker:
 *
 *  - **The bind link.** An unlinked sender is answered here, in this process, because that link is
 *    a credential: it is the one thing that can attach a channel identity to an account. The Worker
 *    is told only that the sender was unlinked.
 *  - **The reply text.** `postReplyForAttempt` posts the assistant Message this Run's completion
 *    *names*. A worker can say which attempt finished and how, but it cannot dictate the words
 *    posted into somebody's Slack — those are read back out of the durable conversation.
 */

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
}

/** What the Worker needs before it can classify one delivery. */
export interface DeliveryDescription {
  readonly slug: string;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;
  /** The Integration's `classify` module and the hash the sandbox must verify it against. */
  readonly classifier: { readonly source: string; readonly hash: string };
  /**
   * Whether this thread is already mapped to a Conversation. Computed here because the classifier
   * runs in an isolate with no I/O, and thread-following (`requireExistingThread`) is the one
   * decision it cannot make for itself.
   */
  readonly hasThreadMapping: boolean;
  readonly chatEnabled: boolean;
  readonly eventsEnabled: boolean;
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
    };
  }

  /**
   * Turns a `chat` decision into a Turn on **this** Run.
   *
   * Nothing here mints a second Run. The delivery's Run is the one that answers, so the Artifact
   * lineage, the event stream, and the Turn all name the same execution — which is what makes a
   * Slack turn and a web turn the same object to every reader.
   *
   * Idempotent by construction: a Run that already names a Turn returns it. A Worker killed between
   * attaching and answering therefore resumes the conversation it started rather than posting the
   * sender's message into it twice.
   */
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

  /**
   * Posts the answer this attempt recorded back to the channel the delivery came from.
   *
   * The text is read out of the durable conversation — the assistant Message the attempt's
   * completion names — never taken from the caller. `outcome` only chooses between this app's own
   * replies when there is no answer to post, so the worst a compromised worker achieves is one of
   * two fixed sentences.
   */
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

  /**
   * Answers an unlinked sender with a single-use bind link — from this process, never through the
   * Worker. The link is the one credential in this flow that can attach a channel identity to an
   * account, so it is written straight into the reply binding and returned to nobody.
   */
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

  /**
   * Resolves what one delivery Run is, from the Run and its immutable request Artifact.
   *
   * Three refusals, in order: a Run that is not running has no executor entitled to act on it, a
   * Run minted by anything but a delivery is not this host's to answer, and an Integration that has
   * since been disconnected or lost its handler can no longer be spoken for.
   */
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
      ...(ingress.chat === undefined ? {} : { chat: ingress.chat }),
      ...(ingress.events === undefined ? {} : { eventTypes: ingress.events.types ?? [] }),
      ...(typeof dedupValue === "string" ? { dedupKey: dedupValue } : {}),
      ...(threadKey === undefined ? {} : { threadKey }),
    };
  }
}
