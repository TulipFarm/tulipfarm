/**
 * Preserves effective Confluence ACLs; unreadable permissions or deletes remove indexed text.
 */

import { canonicalHash } from "@tulipfarm/schema";
import type {
  KnowledgeEmissionSink,
  KnowledgeIdentityMapPort,
  KnowledgeSourceEmission,
} from "../knowledge/source";
import { knowledgeSourceId } from "../knowledge/source";
import { mapExternalPrincipals, splitTextChunks } from "../knowledge/sync-helpers";
import type { ConfluenceApiPort, ConfluenceChange } from "./ports";

export const CONFLUENCE_PROVIDER = "confluence";

export interface ConfluenceKnowledgeSyncDeps {
  readonly api: ConfluenceApiPort;
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

export interface ConfluenceKnowledgeSyncOptions {
  readonly businessId: string;
  readonly integrationId: string;
  readonly externalTenantId: string;
  readonly pageLimit?: number;
  readonly defaultClassification?: readonly string[];
  readonly aclMaximumAgeSeconds?: number;
  /**
   * Source-local page ids to re-fetch even if the change feed does not mention them. The API
   * schedule fills this with stale ACLs so permission-only changes converge.
   */
  readonly revalidatePageIds?: readonly string[];
}

export type ConfluenceSyncFailureCode = "list_failed" | "emit_failed";

export interface ConfluenceKnowledgeSyncResult {
  readonly processed: number;
  readonly emitted: number;
  readonly deleted: number;
  readonly unverifiable: number;
  readonly chunksIndexed: number;
  readonly revalidated: number;
  readonly cursor?: string;
  readonly failures: readonly { readonly code: ConfluenceSyncFailureCode }[];
}

const DEFAULTS = {
  pageLimit: 100,
  classification: ["internal"] as readonly string[],
  aclMaximumAgeSeconds: 300,
  maxChunkChars: 1_800,
};

function deletionEmission(
  pageId: string,
  options: ConfluenceKnowledgeSyncOptions,
  capturedAt: string,
  checkpoint: string
): KnowledgeSourceEmission {
  return {
    sourceId: knowledgeSourceId(CONFLUENCE_PROVIDER, pageId),
    businessId: options.businessId,
    integrationId: options.integrationId,
    provider: CONFLUENCE_PROVIDER,
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
  deps: ConfluenceKnowledgeSyncDeps,
  options: ConfluenceKnowledgeSyncOptions,
  pageId: string,
  capturedAt: string,
  checkpoint: string
): Promise<"deleted" | "unverifiable" | { readonly chunks: number }> {
  const sourceId = knowledgeSourceId(CONFLUENCE_PROVIDER, pageId);
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
    provider: CONFLUENCE_PROVIDER,
    externalId: page.id,
    externalTenantId: options.externalTenantId,
    ownerExternalId: page.ownerAccountId,
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
    subjects: permissions.map((permission) => permission.accountId),
    identity: deps.identity,
    businessId: options.businessId,
    provider: CONFLUENCE_PROVIDER,
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
  changes: readonly ConfluenceChange[],
  revalidatePageIds: readonly string[] | undefined
): readonly string[] {
  const changed = new Set(changes.map((change) => change.pageId));
  return (revalidatePageIds ?? []).filter((pageId) => !changed.has(pageId));
}

export async function syncConfluenceKnowledge(
  deps: ConfluenceKnowledgeSyncDeps,
  options: ConfluenceKnowledgeSyncOptions
): Promise<ConfluenceKnowledgeSyncResult> {
  const stored = await deps.checkpoints.load(options.integrationId);
  let cursor = stored?.cursor;
  const failures: { code: ConfluenceSyncFailureCode }[] = [];
  let processed = 0;
  let emitted = 0;
  let deleted = 0;
  let unverifiable = 0;
  let chunksIndexed = 0;
  let revalidated = 0;

  let changes: readonly ConfluenceChange[];
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
    const sourceId = knowledgeSourceId(CONFLUENCE_PROVIDER, change.pageId);
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

export function confluenceSourceId(pageId: string): string {
  return knowledgeSourceId(CONFLUENCE_PROVIDER, pageId);
}
