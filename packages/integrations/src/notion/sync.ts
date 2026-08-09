/**
 * Notion Knowledge sync.
 *
 * The sync mirrors Confluence's ACL-preserving shape: one Notion page is one Knowledge source,
 * ACLs are explicit snapshot allow-lists of mapped Notion users, unreadable/missing ACL data
 * emits an unverifiable source and removes text, and checkpoints advance only after emission.
 */

import { canonicalHash } from "@tulipfarm/schema";
import type {
  KnowledgeEmissionSink,
  KnowledgeIdentityMapPort,
  KnowledgeSourceEmission,
} from "../knowledge/source";
import { knowledgeSourceId } from "../knowledge/source";
import { mapExternalPrincipals, splitTextChunks } from "../knowledge/sync-helpers";
import type { NotionApiPort, NotionChange } from "./ports";

export const NOTION_PROVIDER = "notion";

export interface NotionKnowledgeSyncDeps {
  readonly api: NotionApiPort;
  readonly checkpoints: {
    load(integrationId: string): Promise<{ readonly cursor?: string } | undefined>;
    save(input: {
      readonly integrationId: string;
      readonly cursor?: string;
      readonly updatedAt: string;
    }): Promise<void>;
  };
  readonly sink: KnowledgeEmissionSink;
  readonly identity: KnowledgeIdentityMapPort;
  readonly now: () => Date;
}

export interface NotionKnowledgeSyncOptions {
  readonly businessId: string;
  readonly integrationId: string;
  readonly externalTenantId: string;
  readonly pageLimit?: number;
  readonly defaultClassification?: readonly string[];
  readonly aclMaximumAgeSeconds?: number;
  readonly revalidatePageIds?: readonly string[];
}

export type NotionSyncFailureCode = "list_failed" | "emit_failed";

export interface NotionKnowledgeSyncResult {
  readonly processed: number;
  readonly emitted: number;
  readonly deleted: number;
  readonly unverifiable: number;
  readonly chunksIndexed: number;
  readonly revalidated: number;
  readonly cursor?: string;
  readonly failures: readonly { readonly code: NotionSyncFailureCode }[];
}

const DEFAULTS = {
  pageLimit: 100,
  classification: ["internal"] as readonly string[],
  aclMaximumAgeSeconds: 300,
  maxChunkChars: 1_800,
};

function deletionEmission(
  pageId: string,
  options: NotionKnowledgeSyncOptions,
  capturedAt: string,
  checkpoint: string
): KnowledgeSourceEmission {
  return {
    sourceId: knowledgeSourceId(NOTION_PROVIDER, pageId),
    businessId: options.businessId,
    integrationId: options.integrationId,
    provider: NOTION_PROVIDER,
    externalId: pageId,
    externalTenantId: options.externalTenantId,
    ownerExternalId: "",
    revision: checkpoint,
    classification: options.defaultClassification ?? DEFAULTS.classification,
    status: "deleted",
    verification: "unverifiable",
    accessControl: {
      mode: "snapshot",
      aclRevision: canonicalHash({ deleted: pageId, checkpoint }),
      maximumAgeSeconds: options.aclMaximumAgeSeconds ?? DEFAULTS.aclMaximumAgeSeconds,
    },
    provenance: { capturedAt, contentHash: canonicalHash({ deleted: pageId }), checkpoint },
    lastSyncedAt: capturedAt,
  };
}

async function syncPage(
  deps: NotionKnowledgeSyncDeps,
  options: NotionKnowledgeSyncOptions,
  pageId: string,
  capturedAt: string,
  checkpoint: string
): Promise<"deleted" | "unverifiable" | { readonly chunks: number }> {
  const sourceId = knowledgeSourceId(NOTION_PROVIDER, pageId);
  const page = await deps.api.getPage(pageId);
  if (page === undefined) {
    await deps.sink.emitSource(deletionEmission(pageId, options, capturedAt, checkpoint));
    await deps.sink.removeSourceContent(options.businessId, sourceId);
    return "deleted";
  }

  const classification =
    page.classification ?? options.defaultClassification ?? DEFAULTS.classification;
  const common = {
    sourceId,
    businessId: options.businessId,
    integrationId: options.integrationId,
    provider: NOTION_PROVIDER,
    externalId: page.id,
    externalTenantId: options.externalTenantId,
    ownerExternalId: page.ownerExternalId,
    revision: page.version,
    classification,
    status: "active" as const,
    provenance: {
      capturedAt,
      contentHash: canonicalHash({ title: page.title, content: page.content }),
      checkpoint,
    },
    lastSyncedAt: capturedAt,
  } as const;

  const permissions = await deps.api.getPagePermissions(page.id);
  if (permissions === undefined) {
    await deps.sink.emitSource({
      ...common,
      verification: "unverifiable",
      accessControl: {
        mode: "snapshot",
        aclRevision: canonicalHash({ unreadableAcl: page.id, checkpoint }),
        maximumAgeSeconds: options.aclMaximumAgeSeconds ?? DEFAULTS.aclMaximumAgeSeconds,
      },
    });
    await deps.sink.removeSourceContent(options.businessId, sourceId);
    return "unverifiable";
  }

  const principals = await mapExternalPrincipals({
    subjects: permissions.map((permission) => permission.userId),
    identity: deps.identity,
    businessId: options.businessId,
    provider: NOTION_PROVIDER,
  });
  const aclRevision = canonicalHash({ pageId: page.id, pageVersion: page.version, principals });
  await deps.sink.emitSource({
    ...common,
    verification: "verified",
    accessControl: {
      mode: "snapshot",
      aclRevision,
      maximumAgeSeconds: options.aclMaximumAgeSeconds ?? DEFAULTS.aclMaximumAgeSeconds,
    },
    acl: { aclRevision, capturedAt, principals },
  });

  await deps.sink.removeSourceContent(options.businessId, sourceId);
  let chunks = 0;
  for (const [index, text] of splitTextChunks(
    page.title,
    page.content,
    DEFAULTS.maxChunkChars
  ).entries()) {
    await deps.sink.emitChunk({
      businessId: options.businessId,
      sourceId,
      chunkId: `${sourceId}#${index}`,
      revision: page.version,
      classification,
      digest: canonicalHash({ text }),
      text,
    });
    chunks += 1;
  }
  return { chunks };
}

function uniqueRevalidations(
  changes: readonly NotionChange[],
  revalidatePageIds: readonly string[] | undefined
): readonly string[] {
  const changed = new Set(changes.map((change) => change.pageId));
  return (revalidatePageIds ?? []).filter((pageId) => !changed.has(pageId));
}

export async function syncNotionKnowledge(
  deps: NotionKnowledgeSyncDeps,
  options: NotionKnowledgeSyncOptions
): Promise<NotionKnowledgeSyncResult> {
  const stored = await deps.checkpoints.load(options.integrationId);
  let cursor = stored?.cursor;
  const failures: { code: NotionSyncFailureCode }[] = [];
  let processed = 0;
  let emitted = 0;
  let deleted = 0;
  let unverifiable = 0;
  let chunksIndexed = 0;
  let revalidated = 0;

  let changes: readonly NotionChange[];
  try {
    ({ changes } = await deps.api.listChanged({
      ...(cursor === undefined ? {} : { cursor }),
      pageLimit: options.pageLimit ?? DEFAULTS.pageLimit,
    }));
  } catch {
    return {
      processed,
      emitted,
      deleted,
      unverifiable,
      chunksIndexed,
      revalidated,
      cursor,
      failures: [{ code: "list_failed" }],
    };
  }

  for (const change of changes) {
    const capturedAt = deps.now().toISOString();
    const sourceId = knowledgeSourceId(NOTION_PROVIDER, change.pageId);
    try {
      if (change.deleted) {
        await deps.sink.emitSource(
          deletionEmission(change.pageId, options, capturedAt, change.cursor)
        );
        await deps.sink.removeSourceContent(options.businessId, sourceId);
        deleted += 1;
      } else {
        const outcome = await syncPage(deps, options, change.pageId, capturedAt, change.cursor);
        if (outcome === "deleted") deleted += 1;
        else if (outcome === "unverifiable") unverifiable += 1;
        else {
          emitted += 1;
          chunksIndexed += outcome.chunks;
        }
      }
    } catch {
      failures.push({ code: "emit_failed" });
      break;
    }
    processed += 1;
    cursor = change.cursor;
    await deps.checkpoints.save({
      integrationId: options.integrationId,
      cursor,
      updatedAt: capturedAt,
    });
  }

  if (failures.length === 0) {
    for (const pageId of uniqueRevalidations(changes, options.revalidatePageIds)) {
      const capturedAt = deps.now().toISOString();
      try {
        const outcome = await syncPage(deps, options, pageId, capturedAt, cursor ?? "revalidate");
        revalidated += 1;
        if (outcome === "deleted") deleted += 1;
        else if (outcome === "unverifiable") unverifiable += 1;
        else {
          emitted += 1;
          chunksIndexed += outcome.chunks;
        }
      } catch {
        failures.push({ code: "emit_failed" });
        break;
      }
    }
  }

  return {
    processed,
    emitted,
    deleted,
    unverifiable,
    chunksIndexed,
    revalidated,
    cursor,
    failures,
  };
}

export function notionSourceId(pageId: string): string {
  return knowledgeSourceId(NOTION_PROVIDER, pageId);
}
