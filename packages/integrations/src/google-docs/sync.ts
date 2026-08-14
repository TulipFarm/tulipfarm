/** Indexes Docs as its own provider; link shares grant nothing without identity mappings. */

import { canonicalHash } from "@tulipfarm/schema";
import type {
  KnowledgeEmissionSink,
  KnowledgeIdentityMapPort,
  KnowledgeSourceEmission,
} from "../knowledge/source";
import { knowledgeSourceId } from "../knowledge/source";
import { mapExternalPrincipals, splitTextChunks } from "../knowledge/sync-helpers";
import type { GoogleDocsApiPort, GoogleDocsChange, GoogleDocsPermission } from "./ports";

export const GOOGLE_DOCS_PROVIDER = "google-docs";

export interface GoogleDocsKnowledgeSyncDeps {
  readonly api: GoogleDocsApiPort;
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

export interface GoogleDocsKnowledgeSyncOptions {
  readonly businessId: string;
  readonly integrationId: string;
  readonly externalTenantId: string;
  readonly pageLimit?: number;
  readonly defaultClassification?: readonly string[];
  readonly aclMaximumAgeSeconds?: number;
  readonly revalidateDocumentIds?: readonly string[];
}

export type GoogleDocsSyncFailureCode = "list_failed" | "emit_failed";

export interface GoogleDocsKnowledgeSyncResult {
  readonly processed: number;
  readonly emitted: number;
  readonly deleted: number;
  readonly unverifiable: number;
  readonly chunksIndexed: number;
  readonly revalidated: number;
  readonly cursor?: string;
  readonly failures: readonly { readonly code: GoogleDocsSyncFailureCode }[];
}

const DEFAULTS = {
  pageLimit: 100,
  classification: ["internal"] as readonly string[],
  aclMaximumAgeSeconds: 300,
  maxChunkChars: 1_800,
};

function permissionSubjects(permissions: readonly GoogleDocsPermission[]): readonly string[] {
  return permissions
    .filter((permission) => permission.type !== "anyone")
    .map((permission) => permission.externalSubject);
}

function deletionEmission(
  documentId: string,
  options: GoogleDocsKnowledgeSyncOptions,
  capturedAt: string,
  checkpoint: string
): KnowledgeSourceEmission {
  return {
    sourceId: knowledgeSourceId(GOOGLE_DOCS_PROVIDER, documentId),
    businessId: options.businessId,
    integrationId: options.integrationId,
    provider: GOOGLE_DOCS_PROVIDER,
    externalId: documentId,
    externalTenantId: options.externalTenantId,
    ownerExternalId: "",
    revision: checkpoint,
    classification: options.defaultClassification ?? DEFAULTS.classification,
    status: "deleted",
    verification: "unverifiable",
    accessControl: {
      mode: "snapshot",
      aclRevision: canonicalHash({ deleted: documentId, checkpoint }),
      maximumAgeSeconds: options.aclMaximumAgeSeconds ?? DEFAULTS.aclMaximumAgeSeconds,
    },
    provenance: { capturedAt, contentHash: canonicalHash({ deleted: documentId }), checkpoint },
    lastSyncedAt: capturedAt,
  };
}

async function syncDocument(
  deps: GoogleDocsKnowledgeSyncDeps,
  options: GoogleDocsKnowledgeSyncOptions,
  documentId: string,
  capturedAt: string,
  checkpoint: string
): Promise<"deleted" | "unverifiable" | { readonly chunks: number }> {
  const sourceId = knowledgeSourceId(GOOGLE_DOCS_PROVIDER, documentId);
  const document = await deps.api.getDocument(documentId);
  if (document === undefined || document.trashed) {
    await deps.sink.emitSource(deletionEmission(documentId, options, capturedAt, checkpoint));
    await deps.sink.removeSourceContent(options.businessId, sourceId);
    return "deleted";
  }

  const classification =
    document.classification ?? options.defaultClassification ?? DEFAULTS.classification;
  const common = {
    sourceId,
    businessId: options.businessId,
    integrationId: options.integrationId,
    provider: GOOGLE_DOCS_PROVIDER,
    externalId: document.id,
    externalTenantId: options.externalTenantId,
    ownerExternalId: document.ownerExternalId,
    revision: document.version,
    classification,
    status: "active" as const,
    provenance: { capturedAt, contentHash: document.contentHash, checkpoint },
    lastSyncedAt: capturedAt,
  } as const;

  const permissions = await deps.api.getDocumentPermissions(document.id);
  if (permissions === undefined) {
    await deps.sink.emitSource({
      ...common,
      verification: "unverifiable",
      accessControl: {
        mode: "snapshot",
        aclRevision: canonicalHash({ unreadableAcl: document.id, checkpoint }),
        maximumAgeSeconds: options.aclMaximumAgeSeconds ?? DEFAULTS.aclMaximumAgeSeconds,
      },
    });
    await deps.sink.removeSourceContent(options.businessId, sourceId);
    return "unverifiable";
  }

  const principals = await mapExternalPrincipals({
    subjects: permissionSubjects(permissions),
    identity: deps.identity,
    businessId: options.businessId,
    provider: GOOGLE_DOCS_PROVIDER,
  });
  const aclRevision = canonicalHash({ documentVersion: document.version, principals });
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
    document.title,
    document.text,
    DEFAULTS.maxChunkChars
  ).entries()) {
    await deps.sink.emitChunk({
      businessId: options.businessId,
      sourceId,
      chunkId: `${sourceId}#${index}`,
      revision: document.version,
      classification,
      digest: canonicalHash({ text }),
      text,
    });
    chunks += 1;
  }
  return { chunks };
}

function uniqueRevalidations(
  changes: readonly GoogleDocsChange[],
  revalidateDocumentIds: readonly string[] | undefined
): readonly string[] {
  const changed = new Set(changes.map((change) => change.documentId));
  return (revalidateDocumentIds ?? []).filter((documentId) => !changed.has(documentId));
}

export async function syncGoogleDocsKnowledge(
  deps: GoogleDocsKnowledgeSyncDeps,
  options: GoogleDocsKnowledgeSyncOptions
): Promise<GoogleDocsKnowledgeSyncResult> {
  const stored = await deps.checkpoints.load(options.integrationId);
  let cursor = stored?.cursor;
  const failures: { code: GoogleDocsSyncFailureCode }[] = [];
  let processed = 0;
  let emitted = 0;
  let deleted = 0;
  let unverifiable = 0;
  let chunksIndexed = 0;
  let revalidated = 0;

  let changes: readonly GoogleDocsChange[];
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
    const sourceId = knowledgeSourceId(GOOGLE_DOCS_PROVIDER, change.documentId);
    try {
      if (change.removed) {
        await deps.sink.emitSource(
          deletionEmission(change.documentId, options, capturedAt, change.cursor)
        );
        await deps.sink.removeSourceContent(options.businessId, sourceId);
        deleted += 1;
      } else {
        const outcome = await syncDocument(
          deps,
          options,
          change.documentId,
          capturedAt,
          change.cursor
        );
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
    for (const documentId of uniqueRevalidations(changes, options.revalidateDocumentIds)) {
      const capturedAt = deps.now().toISOString();
      try {
        const outcome = await syncDocument(
          deps,
          options,
          documentId,
          capturedAt,
          cursor ?? "revalidate"
        );
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

export function googleDocsSourceId(documentId: string): string {
  return knowledgeSourceId(GOOGLE_DOCS_PROVIDER, documentId);
}
