import type {
  SoulBundleActivationRecord,
  SoulDefinitionProjection,
  SoulPublicationOutboxMessage,
  SoulPublicationRecord,
  SoulPublicationStage,
} from "./publication-store";

export interface PublicationRow {
  readonly changeset_id: string;
  readonly business_id: string;
  readonly commit_sha: string;
  readonly digest: string;
  readonly stage: SoulPublicationStage;
  readonly publication_sequence: string | number;
  readonly actor_principal_id: string;
  readonly created_at: string | Date;
  readonly attempts: number;
  readonly next_attempt_at: string | Date;
  readonly failure_code: string | null;
  readonly dead_lettered_at: string | Date | null;
  readonly dead_letter_reason: string | null;
}

export interface ProjectionRow {
  readonly business_id: string;
  readonly digest: string;
  readonly kind: string;
  readonly definition_id: string;
  readonly slug: string;
  readonly authored_version: number;
  readonly hash: string;
}

export interface OutboxRow {
  readonly id: string;
  readonly business_id: string;
  readonly changeset_id: string;
  readonly topic: string;
  readonly consumed_by: string | null;
  readonly consumed_at: string | Date | null;
  readonly claimed_by: string | null;
  readonly claimed_at: string | Date | null;
  readonly claim_lease_expires_at: string | Date | null;
  readonly created_at: string | Date;
}

export interface ActivationRow {
  readonly business_id: string;
  readonly activation_sequence: string | number;
  readonly digest: string;
  readonly changeset_id: string;
  readonly activated_at: string | Date;
  readonly activated_by_principal_id: string;
}

export function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function publication(row: PublicationRow): SoulPublicationRecord {
  return {
    changesetId: row.changeset_id,
    businessId: row.business_id,
    commitSha: row.commit_sha,
    digest: row.digest,
    stage: row.stage,
    publicationSequence: Number(row.publication_sequence),
    actorPrincipalId: row.actor_principal_id,
    createdAt: iso(row.created_at),
    attempts: Number(row.attempts),
    nextAttemptAt: iso(row.next_attempt_at),
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
    ...(row.dead_lettered_at === null ? {} : { deadLetteredAt: iso(row.dead_lettered_at) }),
    ...(row.dead_letter_reason === null ? {} : { deadLetterReason: row.dead_letter_reason }),
  };
}

export function projection(row: ProjectionRow): SoulDefinitionProjection {
  return {
    businessId: row.business_id,
    digest: row.digest,
    kind: row.kind,
    id: row.definition_id,
    slug: row.slug,
    authoredVersion: Number(row.authored_version),
    hash: row.hash,
  };
}

export function outbox(row: OutboxRow): SoulPublicationOutboxMessage {
  return {
    id: row.id,
    businessId: row.business_id,
    changesetId: row.changeset_id,
    topic: row.topic,
    createdAt: iso(row.created_at),
    ...(row.consumed_by === null ? {} : { consumedBy: row.consumed_by }),
    ...(row.consumed_at === null ? {} : { consumedAt: iso(row.consumed_at) }),
    ...(row.claimed_by === null ? {} : { claimedBy: row.claimed_by }),
    ...(row.claimed_at === null ? {} : { claimedAt: iso(row.claimed_at) }),
    ...(row.claim_lease_expires_at === null
      ? {}
      : { claimLeaseExpiresAt: iso(row.claim_lease_expires_at) }),
  };
}

export function activation(row: ActivationRow): SoulBundleActivationRecord {
  return {
    businessId: row.business_id,
    activationSequence: Number(row.activation_sequence),
    digest: row.digest,
    changesetId: row.changeset_id,
    activatedAt: iso(row.activated_at),
    activatedByPrincipalId: row.activated_by_principal_id,
  };
}

export function publicationSelect(): string {
  return `SELECT changeset_id, business_id, commit_sha, digest, stage, publication_sequence,
                 actor_principal_id, created_at, attempts, next_attempt_at, failure_code,
                 dead_lettered_at, dead_letter_reason
            FROM soul_publications`;
}

export function outboxSelect(): string {
  return `SELECT id, business_id, changeset_id, topic, consumed_by, consumed_at, claimed_by,
                 claimed_at, claim_lease_expires_at, created_at
            FROM soul_publication_outbox`;
}
