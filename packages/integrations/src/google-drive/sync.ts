/**
 * Google Drive/Docs Knowledge sync (SPEC §14.1, §15).
 *
 * One change at a time, checkpointed after each committed change. That is deliberately unbatched:
 * the checkpoint is the durability contract, and advancing it past a change whose emission failed
 * would silently drop a document — or worse, drop a *deletion* and leave revoked content readable.
 *
 * Fail-closed decisions this module makes:
 * - permissions unreadable -> `unverifiable` source (retrieval denies) rather than an open one;
 * - a permission holder with no Tulip identity mapping -> dropped, never an implicit grant;
 * - `anyone`/link sharing -> grants nothing, because it names no Tulip principal;
 * - sensitive classification -> `live` access control, so no cached ACL can outlive a change;
 * - removed or trashed file -> `deleted` source *and* immediate content removal;
 * - extraction denied by Guardrail -> source without indexed text, never text without a decision.
 *
 * Results carry counts and stable failure codes. File names, provider errors, and ACL contents
 * never appear in a result, so a sync report cannot become a disclosure channel.
 */

import type { GuardrailRule } from "@tulipfarm/authz";
import { canonicalHash } from "@tulipfarm/schema";
import type {
  EmittedPrincipalRef,
  KnowledgeEmissionSink,
  KnowledgeIdentityMapPort,
  KnowledgeSourceEmission,
} from "../knowledge/source";
import { knowledgeSourceId } from "../knowledge/source";
import { decideDriveExtraction } from "./extract";
import type { DriveApiPort, DriveFile, DrivePermission, DriveSyncCheckpointStore } from "./ports";

export const DRIVE_PROVIDER = "google-drive";

export interface DriveKnowledgeSyncDeps {
  readonly api: DriveApiPort;
  readonly checkpoints: DriveSyncCheckpointStore;
  readonly sink: KnowledgeEmissionSink;
  readonly identity: KnowledgeIdentityMapPort;
  readonly now: () => Date;
}

export interface DriveKnowledgeSyncOptions {
  readonly businessId: string;
  readonly integrationId: string;
  readonly externalTenantId: string;
  readonly pageLimit?: number;
  readonly defaultClassification?: readonly string[];
  /** Classifications that force live provider revalidation instead of a snapshot ACL. */
  readonly sensitiveClassifications?: readonly string[];
  readonly aclMaximumAgeSeconds?: number;
  readonly liveMaximumAgeSeconds?: number;
  readonly extraction: { readonly rules: readonly GuardrailRule[] };
}

export type DriveSyncFailureCode = "list_failed" | "emit_failed";

export interface DriveKnowledgeSyncResult {
  readonly processed: number;
  readonly emitted: number;
  readonly deleted: number;
  readonly unverifiable: number;
  readonly extractionDenied: number;
  readonly cursor?: string;
  readonly failures: readonly { readonly code: DriveSyncFailureCode }[];
}

const DEFAULTS = {
  pageLimit: 100,
  classification: ["internal"] as readonly string[],
  sensitive: ["restricted"] as readonly string[],
  aclMaximumAgeSeconds: 300,
  liveMaximumAgeSeconds: 60,
};

async function mapPrincipals(
  permissions: readonly DrivePermission[],
  identity: KnowledgeIdentityMapPort,
  businessId: string
): Promise<EmittedPrincipalRef[]> {
  const principals: EmittedPrincipalRef[] = [];
  const seen = new Set<string>();
  for (const permission of permissions) {
    // Link sharing names no principal, so it grants no principal. A Drive document shared with
    // "anyone with the link" is reachable in Drive but not through Tulip Knowledge until someone
    // is actually granted.
    if (permission.type === "anyone") continue;
    const resolved = await identity.resolve({
      businessId,
      provider: DRIVE_PROVIDER,
      externalSubject: permission.externalSubject,
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

function deletionEmission(
  fileId: string,
  options: DriveKnowledgeSyncOptions,
  capturedAt: string,
  checkpoint: string
): KnowledgeSourceEmission {
  return {
    sourceId: knowledgeSourceId(DRIVE_PROVIDER, fileId),
    businessId: options.businessId,
    integrationId: options.integrationId,
    provider: DRIVE_PROVIDER,
    externalId: fileId,
    externalTenantId: options.externalTenantId,
    ownerExternalId: "",
    revision: checkpoint,
    classification: options.defaultClassification ?? DEFAULTS.classification,
    status: "deleted",
    verification: "unverifiable",
    accessControl: {
      mode: "live",
      maximumAgeSeconds: options.liveMaximumAgeSeconds ?? DEFAULTS.liveMaximumAgeSeconds,
    },
    provenance: { capturedAt, contentHash: canonicalHash({ deleted: fileId }), checkpoint },
    lastSyncedAt: capturedAt,
  };
}

/**
 * Sync one Drive Integration forward from its stored checkpoint. Returns after the first failed
 * change so the checkpoint stays on the last change that actually committed; the next run retries
 * from exactly there.
 */
export async function syncDriveKnowledge(
  deps: DriveKnowledgeSyncDeps,
  options: DriveKnowledgeSyncOptions
): Promise<DriveKnowledgeSyncResult> {
  const stored = await deps.checkpoints.load(options.integrationId);
  let cursor = stored?.cursor;
  const failures: { code: DriveSyncFailureCode }[] = [];
  let processed = 0;
  let emitted = 0;
  let deleted = 0;
  let unverifiable = 0;
  let extractionDenied = 0;

  let changes: Awaited<ReturnType<DriveApiPort["listChanges"]>>["changes"];
  try {
    ({ changes } = await deps.api.listChanges({
      ...(cursor === undefined ? {} : { cursor }),
      pageLimit: options.pageLimit ?? DEFAULTS.pageLimit,
    }));
  } catch {
    // The provider error text routinely embeds the document title that caused it.
    return {
      processed,
      emitted,
      deleted,
      unverifiable,
      extractionDenied,
      cursor,
      failures: [{ code: "list_failed" }],
    };
  }

  for (const change of changes) {
    const capturedAt = deps.now().toISOString();
    const sourceId = knowledgeSourceId(DRIVE_PROVIDER, change.fileId);
    try {
      const file = change.removed ? undefined : await deps.api.getFile(change.fileId);
      if (file === undefined || file.trashed) {
        await deps.sink.emitSource(
          deletionEmission(change.fileId, options, capturedAt, change.cursor)
        );
        // Content is removed in the same step as the deletion marker: a crash between the two
        // would otherwise leave indexed text behind an unreachable source record.
        await deps.sink.removeSourceContent(options.businessId, sourceId);
        deleted += 1;
      } else {
        const outcome = await syncFile(deps, options, file, capturedAt, change.cursor);
        if (outcome === "unverifiable") unverifiable += 1;
        else emitted += 1;
        if (outcome === "extraction_denied") extractionDenied += 1;
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

  return { processed, emitted, deleted, unverifiable, extractionDenied, cursor, failures };
}

type FileOutcome = "unverifiable" | "indexed" | "extraction_denied";

async function syncFile(
  deps: DriveKnowledgeSyncDeps,
  options: DriveKnowledgeSyncOptions,
  file: DriveFile,
  capturedAt: string,
  checkpoint: string
): Promise<FileOutcome> {
  const sourceId = knowledgeSourceId(DRIVE_PROVIDER, file.id);
  const classification =
    file.classification ?? options.defaultClassification ?? DEFAULTS.classification;
  const sensitive = (options.sensitiveClassifications ?? DEFAULTS.sensitive).some((label) =>
    classification.includes(label)
  );
  const permissions = await deps.api.getPermissions(file.id);

  const common = {
    sourceId,
    businessId: options.businessId,
    integrationId: options.integrationId,
    provider: DRIVE_PROVIDER,
    externalId: file.id,
    externalTenantId: options.externalTenantId,
    ownerExternalId: file.ownerExternalId,
    revision: file.version,
    classification,
    status: "active",
    provenance: { capturedAt, contentHash: file.contentHash, checkpoint },
    lastSyncedAt: capturedAt,
  } as const;

  if (permissions === undefined) {
    // Unreadable permissions are not "no permissions". The source is recorded so it stays
    // citable and invalidatable, but it carries no content and denies on retrieval.
    await deps.sink.emitSource({
      ...common,
      verification: "unverifiable",
      accessControl: {
        mode: "live",
        maximumAgeSeconds: options.liveMaximumAgeSeconds ?? DEFAULTS.liveMaximumAgeSeconds,
      },
    });
    await deps.sink.removeSourceContent(options.businessId, sourceId);
    return "unverifiable";
  }

  const principals = await mapPrincipals(permissions, deps.identity, options.businessId);
  const aclRevision = canonicalHash({ fileVersion: file.version, principals });

  await deps.sink.emitSource({
    ...common,
    verification: "verified",
    ...(sensitive
      ? {
          accessControl: {
            mode: "live" as const,
            maximumAgeSeconds: options.liveMaximumAgeSeconds ?? DEFAULTS.liveMaximumAgeSeconds,
          },
        }
      : {
          accessControl: {
            mode: "snapshot" as const,
            aclRevision,
            maximumAgeSeconds: options.aclMaximumAgeSeconds ?? DEFAULTS.aclMaximumAgeSeconds,
          },
          acl: { aclRevision, capturedAt, principals },
        }),
  });

  const extraction = decideDriveExtraction(options.extraction.rules, {
    classification,
    requiresOcr: file.requiresOcr ?? false,
  });
  if (!extraction.allowed) {
    await deps.sink.removeSourceContent(options.businessId, sourceId);
    return "extraction_denied";
  }

  const exported = await deps.api.exportText(file.id);
  if (exported === undefined) return "indexed";
  await deps.sink.emitChunk({
    businessId: options.businessId,
    sourceId,
    chunkId: `${sourceId}#0`,
    revision: file.version,
    // Extracted text inherits the source classification; it is the same protected content.
    classification,
    digest: canonicalHash({ text: exported.text }),
    text: exported.text,
  });
  return "indexed";
}
