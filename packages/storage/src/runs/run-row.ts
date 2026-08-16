import type {
  PersistedRun,
  PersistedRunStatus,
  RunBounds,
  RunBundle,
  RunIdentity,
} from "./run-store";
import { optionalTimestamp, timestamp } from "./timestamps";

export interface RunRow {
  id: string;
  business_id: string;
  source: string;
  bundle: RunBundle;
  identity: RunIdentity;
  bounds: RunBounds;
  status: PersistedRunStatus;
  version: number;
  created_at: string | Date;
  started_at: string | Date | null;
  finished_at: string | Date | null;
  result_artifact_id: string | null;
  error_evidence_ref: string | null;
  lease_owner: string | null;
  lease_expires_at: string | Date | null;
}

export function persistedRun(row: RunRow): PersistedRun {
  return {
    id: row.id,
    businessId: row.business_id,
    source: row.source,
    bundle: row.bundle,
    identity: row.identity,
    bounds: row.bounds,
    status: row.status,
    version: row.version,
    createdAt: timestamp(row.created_at),
    startedAt: optionalTimestamp(row.started_at),
    finishedAt: optionalTimestamp(row.finished_at),
    resultArtifactId: row.result_artifact_id,
    errorEvidenceRef: row.error_evidence_ref,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: optionalTimestamp(row.lease_expires_at),
  };
}
