import { createHash, randomUUID } from "node:crypto";
import {
  admitNativeRoutine,
  applyMentionGate,
  ChannelRouteDeniedError,
  type ChannelRoutingSnapshot,
  type ChannelRunStarter,
  decideIntegrationAccess,
  GitHubChannelAdapter,
  type NativeRoutineAdmissionDeps,
  NativeRoutineAdmissionError,
  type NativeWebhookProvider,
  nativeAutomationTarget,
  resolveChannelRoute,
  SlackChannelAdapter,
  type SlackEventEnvelope,
  type VerifiedNativeWebhook,
  verifyNativeWebhook,
} from "@tulipfarm/integrations";
import type { DurableInvocationGateway } from "@tulipfarm/run-kernel";
import { type AccessGrantDefinition, canonicalHash } from "@tulipfarm/schema";
import type {
  ChannelInboundStore,
  ChannelMentionedThreadStore,
  ChannelRunDeliveryStore,
  IntegrationStore,
  NativeChannelInboxInput,
  NativeChannelInboxRecord,
  NativeChannelInboxStore,
  PersistedRoutingSnapshot,
  TransactionPort,
} from "@tulipfarm/storage";
import type { FastifyBaseLogger } from "fastify";
import type { ConversationRepo } from "../../chat/conversations";
import { durableTurnSubmitter } from "../../chat/turn-submit";
import type { ConversationStore } from "../../conversations/service";
import type { IngressIdentityResolver } from "../../ingress/identity";
import type { IntegrationConversationsRepo } from "../../ingress/repo";
import { type NativeChannelCredentials, NativeChannelError, object } from "./credentials";

type RunInput = Parameters<ChannelRunStarter["start"]>[0];
type NativeEventContext = NativeChannelInboxInput & { readonly runId?: string | null };

function commandPayload(payload: Record<string, unknown>) {
  const { command, team_id, api_app_id, user_id, channel_id, trigger_id, text } = payload;
  if (
    command !== "/tulipfarm" ||
    typeof team_id !== "string" ||
    !team_id ||
    typeof api_app_id !== "string" ||
    !api_app_id ||
    typeof user_id !== "string" ||
    !user_id ||
    typeof channel_id !== "string" ||
    !/^[CGD][A-Z0-9]+$/.test(channel_id) ||
    typeof trigger_id !== "string" ||
    !trigger_id ||
    typeof text !== "string" ||
    !text.trim()
  )
    throw new NativeChannelError("native_slack_command_invalid", 400);
  return { command, team_id, api_app_id, user_id, channel_id, trigger_id, text: text.trim() };
}

export interface NativeChannelDeps {
  readonly businessId: string;
  readonly transactions: TransactionPort;
  readonly credentials: NativeChannelCredentials;
  readonly integrations: IntegrationStore;
  readonly inbox: NativeChannelInboxStore;
  readonly inbound: ChannelInboundStore;
  readonly mentionedThreads: ChannelMentionedThreadStore;
  readonly identity: IngressIdentityResolver;
  readonly store: ConversationStore;
  readonly conversations: ConversationRepo;
  readonly threads: IntegrationConversationsRepo;
  readonly invocations: DurableInvocationGateway;
  readonly runDeliveries: ChannelRunDeliveryStore;
  readonly log: FastifyBaseLogger;
  readonly mayUseAgent: (agentId: string, userId: string) => Promise<boolean>;
  readonly authorizeRoutine?: NativeRoutineAdmissionDeps["authorizeRoutine"];
}

function routing(snapshot: PersistedRoutingSnapshot): ChannelRoutingSnapshot {
  return {
    ...snapshot,
    accessGrants: snapshot.accessGrants
      .filter((grant) => grant.status === "active")
      .map((grant) => grant.definition as AccessGrantDefinition),
    routes: snapshot.routes.map(({ channelId, threadId, ...route }) => ({
      ...route,
      ...(channelId === null ? {} : { channelId }),
      ...(threadId === null ? {} : { threadId }),
    })),
  };
}

function snapshotHash(snapshot: PersistedRoutingSnapshot): string {
  return canonicalHash({
    apps: [...snapshot.apps].sort((a, b) => a.id.localeCompare(b.id)),
    integrations: [...snapshot.integrations].sort((a, b) => a.id.localeCompare(b.id)),
    routes: [...snapshot.routes].sort((a, b) => a.id.localeCompare(b.id)),
    grants: [...snapshot.accessGrants].sort((a, b) => a.id.localeCompare(b.id)),
  });
}

export class NativeChannelService {
  constructor(readonly deps: NativeChannelDeps) {}

  async accept(
    provider: NativeWebhookProvider,
    rawBody: Buffer,
    headers: Readonly<Record<string, string | string[] | undefined>>
  ): Promise<{ outcome: "accepted" | "duplicate"; eventId: string } | { challenge: string }> {
    const verified = verifyNativeWebhook({
      provider,
      rawBody,
      headers,
      secret: await this.deps.credentials.signingSecret(provider),
    });
    if (verified.challenge !== undefined) return { challenge: verified.challenge };
    return this.acceptVerified(provider, verified);
  }

  async acceptSocketEnvelope(payload: Record<string, unknown>) {
    if (
      payload.type !== "event_callback" ||
      typeof payload.team_id !== "string" ||
      typeof payload.api_app_id !== "string" ||
      typeof payload.event_id !== "string"
    ) {
      throw new NativeChannelError("native_socket_envelope_invalid", 400);
    }
    this.deps.credentials.assertEnabled("slack");
    return this.acceptVerified("slack", {
      payload,
      eventType: "event_callback",
      deliveryId: payload.event_id,
      payloadDigest: canonicalHash(payload),
    });
  }

  async acceptSocketCommand(payload: Record<string, unknown>) {
    const command = commandPayload(payload);
    this.deps.credentials.assertEnabled("slack");
    const accepted = await this.acceptVerified("slack", {
      payload: command,
      eventType: "slash_command",
      deliveryId: `slack-command:${command.team_id}:${command.trigger_id}`,
      payloadDigest: canonicalHash(command),
    });
    const event = await this.deps.inbox.find(this.deps.businessId, accepted.eventId);
    if (!event) throw new NativeChannelError("native_command_persistence_unavailable", 503);
    const denial = event.binding.admissionError;
    return {
      ...accepted,
      response:
        denial === "native_external_identity_unmapped"
          ? ("unlinked" as const)
          : typeof denial === "string"
            ? ("denied" as const)
            : ("starting" as const),
    };
  }

  async acceptSurfaceInteraction(input: {
    readonly sourceRunId: string;
    readonly interactionId: string;
    readonly provider: string;
    readonly externalSubject: string;
    readonly externalTenantId?: string;
    readonly principalId: string;
    readonly content: string;
  }): Promise<void> {
    const source = await this.authorizeReply(input.sourceRunId);
    const delivery = await this.deps.runDeliveries.find(this.deps.businessId, input.sourceRunId);
    if (
      input.provider !== "slack" ||
      source.provider !== "slack" ||
      !delivery ||
      source.externalTenantId !== input.externalTenantId
    )
      throw new NativeChannelError("native_surface_binding_invalid");
    const payload = {
      api_app_id: source.externalAppId,
      team_id: source.externalTenantId,
      user_id: input.externalSubject,
      channel_id: delivery.destination,
      ...(delivery.threadId === undefined ? {} : { thread_id: delivery.threadId }),
      text: input.content,
      sourceRunId: input.sourceRunId,
      interactionId: input.interactionId,
    };
    const accepted = await this.acceptVerified(
      "slack",
      {
        payload,
        eventType: "surface_interaction",
        deliveryId: `surface:${input.interactionId}`,
        payloadDigest: canonicalHash(payload),
      },
      {
        id: canonicalHash({ sourceRunId: input.sourceRunId, interactionId: input.interactionId }),
        principalId: input.principalId,
      }
    );
    const event = await this.deps.inbox.find(this.deps.businessId, accepted.eventId);
    if (!event) throw new NativeChannelError("native_surface_persistence_unavailable", 503);
    if (typeof event.binding.admissionError === "string") {
      throw new NativeChannelError(event.binding.admissionError);
    }
  }

  async authorizeSurfaceInteraction(
    sourceRunId: string,
    interactionId: string,
    principalId: string
  ): Promise<void> {
    await this.authorizeReply(sourceRunId);
    const event = await this.deps.inbox.find(
      this.deps.businessId,
      canonicalHash({ sourceRunId, interactionId })
    );
    if (
      !event ||
      event.status === "denied" ||
      event.eventType !== "surface_interaction" ||
      event.payload.sourceRunId !== sourceRunId ||
      event.payload.interactionId !== interactionId ||
      (await this.resolve(event)).principal.id !== principalId
    )
      throw new NativeChannelError("native_surface_binding_invalid");
  }

  private async acceptVerified(
    provider: NativeWebhookProvider,
    verified: VerifiedNativeWebhook,
    reservation?: { readonly id: string; readonly principalId: string }
  ) {
    const externalTenantId =
      provider === "slack"
        ? String(verified.payload.team_id)
        : String(object(verified.payload.installation)?.id ?? "");
    const externalAppId =
      provider === "slack"
        ? String(verified.payload.api_app_id)
        : await this.deps.credentials.secret("github", "GITHUB_APP_ID");
    const snapshot = await this.deps.integrations.loadRoutingSnapshot(
      this.deps.businessId,
      provider,
      externalTenantId
    );
    const apps = snapshot.apps.filter(
      (app) => app.status === "active" && app.externalAppId === externalAppId
    );
    const installations = snapshot.integrations.filter(
      (integration) =>
        integration.status === "active" &&
        integration.externalTenantId === externalTenantId &&
        integration.appId === apps[0]?.id
    );
    if (apps.length !== 1 || installations.length !== 1) {
      throw new NativeChannelError("native_installation_not_active", 404);
    }
    const botLogin =
      provider === "github"
        ? `${await this.deps.credentials.secret("github", "GITHUB_APP_SLUG")}[bot]`
        : undefined;
    const target = nativeAutomationTarget(provider, verified.eventType, verified.payload);
    const routineRoute = target
      ? (await this.deps.inbox.routineRoutes(this.deps.businessId, provider)).find(
          (route) =>
            route.enabled &&
            route.integrationId === installations[0].id &&
            route.destination === target.destination &&
            route.eventType === target.eventType
        )
      : undefined;
    const input: NativeChannelInboxInput = {
      id: reservation?.id ?? randomUUID(),
      businessId: this.deps.businessId,
      provider,
      integrationId: installations[0].id,
      externalAppId,
      externalTenantId,
      deliveryId: verified.deliveryId,
      payloadDigest: canonicalHash(verified.payload),
      eventType: verified.eventType,
      payload: verified.payload,
      binding: {
        snapshotHash: snapshotHash(snapshot),
        ...(botLogin === undefined ? {} : { botLogin }),
        ...(routineRoute === undefined ? {} : { routineRoute }),
        ...(reservation === undefined ? {} : { principalId: reservation.principalId }),
      },
    };
    if (
      provider === "slack" &&
      (verified.eventType === "slash_command" || verified.eventType === "surface_interaction")
    ) {
      try {
        input.binding.principalId = (await this.resolve(input)).principal.id;
      } catch (error) {
        if (!(error instanceof NativeChannelError) && !(error instanceof ChannelRouteDeniedError)) {
          throw error;
        }
        if (error instanceof NativeChannelError && error.status === 503) throw error;
        input.binding.admissionError =
          error instanceof NativeChannelError ? error.code : error.reason;
      }
    }
    const accepted = await this.deps.inbox.accept(input);
    return { outcome: accepted.outcome, eventId: accepted.event.id };
  }

  private async snapshot(event: NativeEventContext): Promise<PersistedRoutingSnapshot> {
    this.deps.credentials.assertEnabled(event.provider);
    const snapshot = await this.deps.integrations.loadRoutingSnapshot(
      event.businessId,
      event.provider,
      event.externalTenantId
    );
    if (snapshotHash(snapshot) !== event.binding.snapshotHash) {
      throw new NativeChannelError("native_channel_binding_changed");
    }
    return snapshot;
  }

  private async resolve(event: NativeEventContext): Promise<RunInput> {
    if (typeof event.binding.admissionError === "string") {
      throw new NativeChannelError(event.binding.admissionError);
    }
    const snapshot = routing(await this.snapshot(event));
    let resolved: RunInput | undefined;
    const adapterDeps = {
      inbound: {
        accept: (
          inbound: Parameters<import("@tulipfarm/integrations").ChannelInboundStore["accept"]>[0]
        ) =>
          this.deps.inbound.accept({
            businessId: inbound.businessId,
            provider: event.provider,
            eventId: inbound.eventId,
            deduplicationKey: `native:${event.id}`,
            receivedAt: inbound.receivedAt,
          }),
      },
      identities: {
        resolve: async (input: { externalSubject: string }) => {
          const identity = await this.deps.identity.resolve({
            slug: event.provider,
            sender: input.externalSubject,
            externalTenantId: event.externalTenantId,
          });
          return identity.outcome === "linked" && identity.principalKind === "user"
            ? { kind: "user" as const, id: identity.principalId }
            : undefined;
        },
      },
      routing: { load: async () => snapshot },
      runs: {
        start: async (input: RunInput) => {
          if (
            input.integrationId !== event.integrationId ||
            input.principal.kind !== "user" ||
            (typeof event.binding.principalId === "string" &&
              event.binding.principalId !== input.principal.id) ||
            !(await this.deps.mayUseAgent(input.agentId, input.principal.id))
          ) {
            throw new NativeChannelError("native_caller_not_authorized");
          }
          for (const action of ["channels.message.receive", "channels.message.send"]) {
            const access = decideIntegrationAccess(
              snapshot.accessGrants.filter((grant) => grant.metadata.id === input.routeId),
              {
                integrationId: input.integrationId,
                principals: [input.principal],
                action,
                target: {
                  type: event.provider === "github" ? "github.repository" : "slack.channel",
                  id: input.message.channelId,
                },
              },
              new Date()
            );
            if (!access.allowed) throw new NativeChannelError("native_access_denied");
          }
          resolved = input;
          return { outcome: "started" as const, runId: event.runId ?? event.id };
        },
      },
      now: () => new Date().toISOString(),
    };
    if (
      event.provider === "slack" &&
      (event.eventType === "slash_command" || event.eventType === "surface_interaction")
    ) {
      const message =
        event.eventType === "slash_command" ? commandPayload(event.payload) : event.payload;
      if (
        typeof message.user_id !== "string" ||
        typeof message.channel_id !== "string" ||
        typeof message.text !== "string"
      )
        throw new NativeChannelError("native_message_invalid", 400);
      const threadId =
        event.eventType === "surface_interaction" && typeof event.payload.thread_id === "string"
          ? event.payload.thread_id
          : undefined;
      const principal = await adapterDeps.identities.resolve({ externalSubject: message.user_id });
      if (!principal) throw new NativeChannelError("native_external_identity_unmapped");
      const route = resolveChannelRoute(snapshot, {
        businessId: event.businessId,
        provider: "slack",
        externalTenantId: event.externalTenantId,
        externalAppId: event.externalAppId,
        channelId: message.channel_id,
        ...(threadId === undefined ? {} : { threadId }),
        eventType: "message",
        principal,
        action: "channels.message.receive",
        targetType: "slack.channel",
      });
      await adapterDeps.runs.start({
        businessId: event.businessId,
        eventId: event.id,
        integrationId: route.integrationId,
        routeId: route.routeId,
        agentId: route.agentId,
        principal,
        message: {
          externalAppId: event.externalAppId,
          channelId: message.channel_id,
          ...(threadId === undefined ? {} : { threadId }),
          text: message.text,
          media: [],
        },
      });
    } else if (event.provider === "github") {
      await new GitHubChannelAdapter(adapterDeps).receive(
        {
          businessId: event.businessId,
          externalAppId: event.externalAppId,
          installationId: event.externalTenantId,
          botLogin: String(event.binding.botLogin),
        },
        event.id,
        event.eventType,
        event.payload
      );
    } else {
      const gated = await applyMentionGate(event.payload as SlackEventEnvelope, {
        businessId: event.businessId,
        provider: `slack:${event.externalAppId}:${event.externalTenantId}`,
        mentionedThreads: this.deps.mentionedThreads,
      });
      if (gated.outcome !== "pass") throw new NativeChannelError("native_message_not_addressed");
      await new SlackChannelAdapter(adapterDeps).receive(
        event.businessId,
        { ...gated.envelope, event_id: event.id },
        async () => {}
      );
    }
    if (!resolved) throw new NativeChannelError("native_message_not_authorized");
    return resolved;
  }

  private async dispatch(event: NativeChannelInboxRecord): Promise<string> {
    await this.deps.inbox.assertClaim(event);
    if (event.binding.routineRoute !== undefined) return this.dispatchRoutine(event);
    const input = await this.resolve(event);
    const threadKey = createHash("sha256")
      .update(
        JSON.stringify([
          event.provider,
          event.externalAppId,
          event.externalTenantId,
          input.routeId,
          input.principal.id,
          input.message.channelId,
          input.message.threadId,
        ])
      )
      .digest("hex");
    let mapping = await this.deps.threads.find(event.provider, threadKey);
    if (!mapping) {
      const conversationId = randomUUID();
      const now = new Date();
      await this.deps.conversations.create({
        _id: conversationId,
        userId: input.principal.id,
        agentId: input.agentId,
        createdAt: now,
        updatedAt: now,
      });
      mapping = await this.deps.threads.insert({
        integrationSlug: event.provider,
        externalKey: threadKey,
        conversationId,
        userId: input.principal.id,
      });
      if (mapping.conversationId !== conversationId) {
        await this.deps.conversations.deleteOwned(conversationId, input.principal.id);
      }
    }
    if (mapping.userId !== input.principal.id) {
      throw new NativeChannelError("native_conversation_identity_changed");
    }
    await this.deps.inbox.assertClaim(event);
    if (canonicalHash(await this.resolve(event)) !== canonicalHash(input)) {
      throw new NativeChannelError("native_caller_binding_changed");
    }
    const submission = await durableTurnSubmitter({
      store: this.deps.store,
      invocations: this.deps.invocations,
      principal: { kind: "user", id: input.principal.id, businessId: event.businessId },
      payload: {
        conversationId: mapping.conversationId,
        agentId: input.agentId,
        message: { role: "user", content: input.message.text },
      },
      requestMetadata: {
        nativeChannel: {
          provider: event.provider,
          audience: "shared",
          eventId: event.id,
          integrationId: input.integrationId,
          routeId: input.routeId,
        },
      },
      agentId: input.agentId,
      idempotencyKey: `native:${event.id}`,
      log: this.deps.log,
    }).submit({ conversationId: mapping.conversationId, content: input.message.text });
    if (submission.outcome === "conflict") {
      throw new NativeChannelError("native_run_conflict", 409);
    }
    const runId = submission.run.runId;
    await this.deps.inbox.bindRun(event, runId);
    await this.deps.runDeliveries.create({
      businessId: event.businessId,
      runId,
      integrationId: input.integrationId,
      routeId: input.routeId,
      provider: event.provider,
      destination: input.message.channelId,
      threadId: input.message.threadId,
      sourceMessageTs: input.message.sourceMessageTs,
      agentId: input.agentId,
      principalId: input.principal.id,
      idempotencyKey: `native:${event.id}`,
    });
    return runId;
  }

  async drain(limit: number) {
    const events = await this.deps.inbox.claim(this.deps.businessId, randomUUID(), limit);
    const result = { claimed: events.length, dispatched: 0, denied: 0, retrying: 0 };
    for (const event of events) {
      try {
        await this.dispatch(event);
        if (await this.deps.inbox.finish(event, { status: "dispatched" })) result.dispatched++;
        else result.retrying++;
      } catch (error) {
        const denied =
          (error instanceof NativeChannelError && error.status !== 503) || event.attempts >= 20;
        const finished = await this.deps.inbox.finish(event, {
          status: denied ? "denied" : "retry",
          code: error instanceof NativeChannelError ? error.code : "native_dispatch_unavailable",
        });
        if (denied && finished) result.denied++;
        else result.retrying++;
      }
    }
    return result;
  }

  async authorizeReply(runId: string): Promise<NativeChannelInboxRecord> {
    const event = await this.deps.inbox.findByRun(this.deps.businessId, runId);
    if (event?.status !== "dispatched") {
      throw new NativeChannelError(
        "native_reply_not_ready",
        event && event.status !== "denied" ? 503 : 403
      );
    }
    const input = await this.resolve(event);
    const delivery = await this.deps.runDeliveries.find(event.businessId, runId);
    if (
      !delivery ||
      delivery.provider !== event.provider ||
      delivery.integrationId !== input.integrationId ||
      delivery.routeId !== input.routeId ||
      delivery.agentId !== input.agentId ||
      delivery.principalId !== input.principal.id ||
      delivery.destination !== input.message.channelId ||
      delivery.threadId !== input.message.threadId
    ) {
      throw new NativeChannelError("native_reply_binding_changed");
    }
    return event;
  }

  async githubCredential(input: {
    integrationId: string;
    routeId: string;
    runId: string;
    destination: string;
    leaseGeneration: number;
  }): Promise<{ token: string; botUserId: string }> {
    const event = await this.authorizeReply(input.runId);
    const delivery = await this.deps.runDeliveries.find(this.deps.businessId, input.runId);
    if (
      event.provider !== "github" ||
      !delivery ||
      delivery.status !== "delivering" ||
      delivery.integrationId !== input.integrationId ||
      delivery.routeId !== input.routeId ||
      delivery.destination !== input.destination ||
      delivery.leaseGeneration !== input.leaseGeneration ||
      !delivery.leaseExpiresAt ||
      Date.parse(delivery.leaseExpiresAt) <= Date.now()
    ) {
      throw new NativeChannelError("native_reply_lease_invalid", 409);
    }
    const credential = await this.deps.credentials.githubReply({
      externalAppId: event.externalAppId,
      installationId: event.externalTenantId,
      repository: input.destination,
    });
    await this.authorizeReply(input.runId);
    const current = await this.deps.runDeliveries.find(this.deps.businessId, input.runId);
    if (
      current?.status !== "delivering" ||
      current.leaseGeneration !== input.leaseGeneration ||
      !current.leaseExpiresAt ||
      Date.parse(current.leaseExpiresAt) <= Date.now()
    ) {
      throw new NativeChannelError("native_reply_lease_invalid", 409);
    }
    return credential;
  }

  async authorizeDelivery(input: {
    integrationId: string;
    routeId: string;
    principalId: string;
    agentId: string;
    destination: string;
    idempotencyKey: string;
  }): Promise<void> {
    if (!input.idempotencyKey.startsWith("native:")) {
      throw new NativeChannelError("native_delivery_unbound");
    }
    const event = await this.deps.inbox.find(this.deps.businessId, input.idempotencyKey.slice(7));
    if (!event?.runId) throw new NativeChannelError("native_delivery_unbound");
    await this.authorizeReply(event.runId);
    const delivery = await this.deps.runDeliveries.find(this.deps.businessId, event.runId);
    if (
      !delivery ||
      delivery.integrationId !== input.integrationId ||
      delivery.routeId !== input.routeId ||
      delivery.principalId !== input.principalId ||
      delivery.agentId !== input.agentId ||
      delivery.destination !== input.destination ||
      delivery.idempotencyKey !== input.idempotencyKey ||
      delivery.status !== "delivering" ||
      !delivery.leaseExpiresAt ||
      Date.parse(delivery.leaseExpiresAt) <= Date.now()
    ) {
      throw new NativeChannelError("native_delivery_binding_invalid");
    }
  }

  private async dispatchRoutine(event: NativeChannelInboxRecord): Promise<string> {
    await this.snapshot(event);
    try {
      return await admitNativeRoutine(event, this.deps);
    } catch (error) {
      if (error instanceof NativeRoutineAdmissionError) throw new NativeChannelError(error.code);
      throw error;
    }
  }
}
