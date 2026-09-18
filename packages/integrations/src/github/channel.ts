import type {
  ChannelIdentityPort,
  ChannelInboundEvent,
  ChannelInboundStore,
  ChannelRoutingSource,
  ChannelRunStarter,
} from "../channels/ports";
import { ChannelRouteDeniedError, resolveChannelRoute } from "../model";
import { parseRepositoryRef } from "./scope";

export interface GitHubChannelBinding {
  readonly businessId: string;
  readonly externalAppId: string;
  readonly installationId: string;
  readonly botLogin: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function id(value: unknown): string | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : typeof value === "string" && /^[1-9]\d*$/.test(value)
      ? value
      : undefined;
}

export type GitHubChannelResult =
  | { readonly outcome: "started" | "duplicate"; readonly runId: string }
  | { readonly outcome: "ignored" }
  | { readonly outcome: "denied"; readonly reason: string };

export class GitHubChannelAdapter {
  constructor(
    private readonly deps: {
      readonly inbound: ChannelInboundStore;
      readonly identities: ChannelIdentityPort;
      readonly routing: ChannelRoutingSource;
      readonly runs: ChannelRunStarter;
      readonly now: () => string;
    }
  ) {}

  /** Called only after the API verifies the App signature and installation binding. */
  async receive(
    binding: GitHubChannelBinding,
    deliveryId: string,
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<GitHubChannelResult> {
    if (eventType !== "issue_comment" || payload.action !== "created") {
      return { outcome: "ignored" };
    }
    if (
      !deliveryId ||
      !binding.externalAppId ||
      !binding.botLogin ||
      id(object(payload.installation)?.id) !== binding.installationId
    ) {
      return { outcome: "denied", reason: "installation_binding_invalid" };
    }
    const sender = object(payload.sender);
    const comment = object(payload.comment);
    const author = object(comment?.user);
    if (sender?.type !== "User" || author?.type !== "User") return { outcome: "ignored" };
    const senderId = id(sender.id);
    const commentId = id(comment?.id);
    const issueNumber = id(object(payload.issue)?.number);
    const repository = object(payload.repository)?.full_name;
    const body = comment?.body;
    if (
      senderId === undefined ||
      senderId !== id(author.id) ||
      commentId === undefined ||
      issueNumber === undefined ||
      typeof repository !== "string" ||
      typeof body !== "string"
    ) {
      return { outcome: "denied", reason: "message_invalid" };
    }
    parseRepositoryRef(repository);
    const escapedLogin = binding.botLogin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const mention = new RegExp(`(^|\\s)@${escapedLogin}(?=$|\\s|[,:.!?])`, "i");
    if (!mention.test(body)) return { outcome: "ignored" };
    const now = this.deps.now();
    const message: ChannelInboundEvent = {
      businessId: binding.businessId,
      eventId: deliveryId,
      type: "github.message.received",
      version: 1,
      occurredAt: now,
      receivedAt: now,
      source: {
        provider: "github",
        externalTenantId: binding.installationId,
        deliveryId,
      },
      principal: { kind: "external", externalId: senderId },
      record: { type: "message", id: commentId },
      deduplicationKey: deliveryId,
      classification: ["untrusted.external"],
      data: {
        externalAppId: binding.externalAppId,
        channelId: repository,
        threadId: issueNumber,
        sourceMessageTs: commentId,
        text: body.replace(mention, "$1").trim(),
        media: [],
      },
      verification: { status: "verified", method: "github_hmac_sha256" },
    };
    await this.deps.inbound.accept(message);
    const principal = await this.deps.identities.resolve({
      businessId: binding.businessId,
      provider: "github",
      externalTenantId: binding.installationId,
      externalSubject: senderId,
    });
    if (principal?.kind !== "user") {
      return { outcome: "denied", reason: "external_identity_unmapped" };
    }
    const snapshot = await this.deps.routing.load({
      businessId: binding.businessId,
      provider: "github",
      externalTenantId: binding.installationId,
    });
    try {
      const route = resolveChannelRoute(snapshot, {
        businessId: binding.businessId,
        provider: "github",
        externalTenantId: binding.installationId,
        externalAppId: binding.externalAppId,
        channelId: repository,
        threadId: issueNumber,
        eventType: "message",
        principal,
        grantPrincipals: principal.grantPrincipals,
        action: "channels.message.receive",
        targetType: "github.repository",
      });
      return this.deps.runs.start({
        businessId: binding.businessId,
        eventId: deliveryId,
        integrationId: route.integrationId,
        routeId: route.routeId,
        agentId: route.agentId,
        principal,
        message: message.data,
      });
    } catch (error) {
      if (error instanceof ChannelRouteDeniedError) {
        return { outcome: "denied", reason: error.reason };
      }
      throw error;
    }
  }
}
