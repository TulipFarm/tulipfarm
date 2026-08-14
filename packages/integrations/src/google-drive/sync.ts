/**
 * Drive sync fails closed: unreadable ACLs, link shares, unmapped subjects, deletes, and denied
 * extraction never leak indexed text; checkpoints advance only after each committed change.
 */

import type { GuardrailRule } from "@tulipfarm/authz";
import { canonicalHash } from "@tulipfarm/schema";
import type {
  KnowledgeEmissionSink,
  KnowledgeIdentityMapPort,
  KnowledgeSourceEmission,
} from "../knowledge/source";
import { knowledgeSourceId } from "../knowledge/source";
import { mapExternalPrincipals } from "../knowledge/sync-helpers";
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
  readonly revalidateFileIds?: readonly string[];
}

export type DriveSyncFailureCode = "list_failed" | "emit_failed";

export interface DriveKnowledgeSyncResult {
  readonly processed: number;
  readonly emitted: number;
  readonly deleted: number;
  readonly unverifiable: number;
  readonly extractionDenied: number;
  readonly revalidated: number;
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
): ReturnType<typeof mapExternalPrincipals> {
  // Link sharing names no principal, so it grants no principal. A Drive document shared with
  // "anyone with the link" is reachable in Drive but not through Tulip Knowledge until someone
  // is actually granted.
  return mapExternalPrincipals({
    subjects: permissions
      .filter((permission) => permission.type !== "anyone")
      .map((permission) => permission.externalSubject),
    identity,
    businessId,
    provider: DRIVE_PROVIDER,
  });
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

/** Stop on first failed change so the checkpoint remains at the last committed change. */
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
  let revalidated = 0;

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
      revalidated,
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

  if (failures.length === 0) {
    const changed = new Set(changes.map((change) => change.fileId));
    for (const fileId of (options.revalidateFileIds ?? []).filter((id) => !changed.has(id))) {
      const capturedAt = deps.now().toISOString();
      try {
        const file = await deps.api.getFile(fileId);
        if (file === undefined || file.trashed) {
          await deps.sink.emitSource(
            deletionEmission(fileId, options, capturedAt, cursor ?? "revalidate")
          );
          await deps.sink.removeSourceContent(
            options.businessId,
            knowledgeSourceId(DRIVE_PROVIDER, fileId)
          );
          deleted += 1;
        } else {
          const outcome = await syncFile(deps, options, file, capturedAt, cursor ?? "revalidate");
          if (outcome === "unverifiable") unverifiable += 1;
          else emitted += 1;
          if (outcome === "extraction_denied") extractionDenied += 1;
        }
        revalidated += 1;
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
    extractionDenied,
    revalidated,
    cursor,
    failures,
  };
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
