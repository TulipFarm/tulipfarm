/**
 * Slack channel membership is the ACL; unreadable members, unmapped users, private channels,
 * archives, and deleted messages fail closed without leaking ids or text in results.
 */

import { canonicalHash } from "@tulipfarm/schema";
import type {
  EmittedPrincipalRef,
  KnowledgeEmissionSink,
  KnowledgeIdentityMapPort,
  KnowledgeSourceEmission,
} from "../../knowledge/source";
import { knowledgeSourceId } from "../../knowledge/source";
import type {
  SlackKnowledgeApiPort,
  SlackKnowledgeChannel,
  SlackKnowledgeCheckpointStore,
} from "./ports";

export const SLACK_PROVIDER = "slack";

export interface SlackKnowledgeSyncDeps {
  readonly api: SlackKnowledgeApiPort;
  readonly checkpoints: SlackKnowledgeCheckpointStore;
  readonly sink: KnowledgeEmissionSink;
  readonly identity: KnowledgeIdentityMapPort;
  readonly now: () => Date;
}

export interface SlackKnowledgeSyncOptions {
  readonly businessId: string;
  readonly integrationId: string;
  readonly externalTenantId: string;
  readonly pageLimit?: number;
  /** Classification for public channels; private channels and DMs are always `restricted`. */
  readonly publicClassification?: readonly string[];
  readonly aclMaximumAgeSeconds?: number;
  readonly liveMaximumAgeSeconds?: number;
}

export type SlackSyncFailureCode =
  | "channels_failed"
  | "members_failed"
  | "emit_failed"
  | "messages_failed";

export interface SlackKnowledgeSyncResult {
  readonly channelsProcessed: number;
  readonly emitted: number;
  readonly unverifiable: number;
  readonly messagesIndexed: number;
  readonly messagesRemoved: number;
  readonly failures: readonly { readonly code: SlackSyncFailureCode }[];
}

const DEFAULTS = {
  pageLimit: 200,
  publicClassification: ["internal"] as readonly string[],
  restrictedClassification: ["restricted"] as readonly string[],
  aclMaximumAgeSeconds: 300,
  liveMaximumAgeSeconds: 60,
};

/** Private channels, DMs, and group DMs never get a cached ACL. */
function isSensitive(kind: SlackKnowledgeChannel["kind"]): boolean {
  return kind !== "public";
}

async function mapPrincipals(
  members: readonly string[],
  identity: KnowledgeIdentityMapPort,
  businessId: string
): Promise<EmittedPrincipalRef[]> {
  const principals: EmittedPrincipalRef[] = [];
  const seen = new Set<string>();
  for (const member of members) {
    const resolved = await identity.resolve({
      businessId,
      provider: SLACK_PROVIDER,
      externalSubject: member,
    });
    for (const principal of resolved ?? []) {
      const key = `${principal.kind}:${principal.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      principals.push(principal);
    }
  }
  return principals;
}

/**
 * Sync every channel this Integration can see, each from its own durable checkpoint. Channels are
 * independent: a channel that fails leaves its checkpoint untouched and does not stop the others.
 */
export async function syncSlackKnowledge(
  deps: SlackKnowledgeSyncDeps,
  options: SlackKnowledgeSyncOptions
): Promise<SlackKnowledgeSyncResult> {
  const failures: { code: SlackSyncFailureCode }[] = [];
  const totals = { channelsProcessed: 0, emitted: 0, unverifiable: 0, indexed: 0, removed: 0 };

  let channels: readonly SlackKnowledgeChannel[];
  try {
    channels = await deps.api.listChannels();
  } catch {
    // The provider error routinely names the channel that caused it.
    return {
      channelsProcessed: 0,
      emitted: 0,
      unverifiable: 0,
      messagesIndexed: 0,
      messagesRemoved: 0,
      failures: [{ code: "channels_failed" }],
    };
  }

  for (const channel of channels) {
    const outcome = await syncChannel(deps, options, channel);
    totals.channelsProcessed += 1;
    totals.emitted += outcome.emitted;
    totals.unverifiable += outcome.unverifiable;
    totals.indexed += outcome.indexed;
    totals.removed += outcome.removed;
    if (outcome.failure !== undefined) failures.push({ code: outcome.failure });
  }

  return {
    channelsProcessed: totals.channelsProcessed,
    emitted: totals.emitted,
    unverifiable: totals.unverifiable,
    messagesIndexed: totals.indexed,
    messagesRemoved: totals.removed,
    failures,
  };
}

interface ChannelOutcome {
  emitted: number;
  unverifiable: number;
  indexed: number;
  removed: number;
  failure?: SlackSyncFailureCode;
}

async function syncChannel(
  deps: SlackKnowledgeSyncDeps,
  options: SlackKnowledgeSyncOptions,
  channel: SlackKnowledgeChannel
): Promise<ChannelOutcome> {
  const outcome: ChannelOutcome = { emitted: 0, unverifiable: 0, indexed: 0, removed: 0 };
  const sourceId = knowledgeSourceId(SLACK_PROVIDER, channel.id);
  const capturedAt = deps.now().toISOString();
  const sensitive = isSensitive(channel.kind);
  const classification =
    channel.classification ??
    (sensitive
      ? DEFAULTS.restrictedClassification
      : (options.publicClassification ?? DEFAULTS.publicClassification));

  let members: readonly string[] | undefined;
  try {
    members = await deps.api.listMembers(channel.id);
  } catch {
    return { ...outcome, failure: "members_failed" };
  }

  const stored = await deps.checkpoints.load(options.integrationId, channel.id);
  let cursor = stored?.cursor;

  const common = {
    sourceId,
    businessId: options.businessId,
    integrationId: options.integrationId,
    provider: SLACK_PROVIDER,
    externalId: channel.id,
    externalTenantId: options.externalTenantId,
    ownerExternalId: channel.teamId,
    classification,
    lastSyncedAt: capturedAt,
  } as const;

  const liveAccessControl = {
    mode: "live",
    maximumAgeSeconds: options.liveMaximumAgeSeconds ?? DEFAULTS.liveMaximumAgeSeconds,
  } as const;

  if (members === undefined) {
    // Unreadable membership is not "no membership". The source stays recorded so it remains
    // citable and invalidatable, but it holds no content and denies on retrieval.
    try {
      await deps.sink.emitSource({
        ...common,
        revision: cursor ?? "0",
        status: "active",
        verification: "unverifiable",
        accessControl: liveAccessControl,
        provenance: { capturedAt, contentHash: canonicalHash({ unverifiable: sourceId }) },
      });
      await deps.sink.removeSourceContent(options.businessId, sourceId);
    } catch {
      return { ...outcome, failure: "emit_failed" };
    }
    return { ...outcome, unverifiable: 1 };
  }

  const principals = await mapPrincipals(members, deps.identity, options.businessId);
  const aclRevision = canonicalHash({ channelId: channel.id, principals });
  const access = sensitive
    ? { accessControl: liveAccessControl }
    : {
        accessControl: {
          mode: "snapshot" as const,
          aclRevision,
          maximumAgeSeconds: options.aclMaximumAgeSeconds ?? DEFAULTS.aclMaximumAgeSeconds,
        },
        acl: { aclRevision, capturedAt, principals },
      };

  const emitSource = (revision: string, status: KnowledgeSourceEmission["status"]) =>
    deps.sink.emitSource({
      ...common,
      ...access,
      revision,
      status,
      verification: "verified",
      provenance: { capturedAt, contentHash: aclRevision, checkpoint: revision },
    });

  if (channel.archived) {
    // Archived channels stop contributing content but stay citable for answers already given.
    try {
      await emitSource(cursor ?? "0", "revoked");
      await deps.sink.removeSourceContent(options.businessId, sourceId);
    } catch {
      return { ...outcome, failure: "emit_failed" };
    }
    return { ...outcome, emitted: 1 };
  }

  try {
    await emitSource(cursor ?? "0", "active");
  } catch {
    return { ...outcome, failure: "emit_failed" };
  }
  outcome.emitted = 1;

  let messages: Awaited<ReturnType<SlackKnowledgeApiPort["listMessages"]>>["messages"];
  try {
    ({ messages } = await deps.api.listMessages({
      channelId: channel.id,
      ...(cursor === undefined ? {} : { cursor }),
      pageLimit: options.pageLimit ?? DEFAULTS.pageLimit,
    }));
  } catch {
    return { ...outcome, failure: "messages_failed" };
  }

  for (const message of messages) {
    const chunkId = `${sourceId}#${message.ts}`;
    try {
      if (message.deleted) {
        await deps.sink.removeChunk(options.businessId, sourceId, chunkId);
        outcome.removed += 1;
      } else {
        await deps.sink.emitChunk({
          businessId: options.businessId,
          sourceId,
          chunkId,
          // An edit is a new revision of the same chunk, so a stale copy cannot survive it.
          revision: message.editedTs ?? message.ts,
          // Message text inherits the channel's classification; it is the same protected content.
          classification,
          digest: canonicalHash({ text: message.text }),
          text: message.text,
        });
        outcome.indexed += 1;
      }
    } catch {
      return { ...outcome, failure: "emit_failed" };
    }
    cursor = message.ts;
    await deps.checkpoints.save({
      integrationId: options.integrationId,
      channelId: channel.id,
      cursor,
      updatedAt: capturedAt,
    });
  }

  if (cursor !== undefined && cursor !== stored?.cursor) {
    // Re-emit at the new revision so downstream caches and citations invalidate against the
    // messages that actually landed, rather than the revision the channel had before this run.
    try {
      await emitSource(cursor, "active");
    } catch {
      return { ...outcome, failure: "emit_failed" };
    }
  }

  return outcome;
}
