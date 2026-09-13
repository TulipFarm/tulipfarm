import type { Queryable, TransactionPort } from "../ports";
import type {
  BindVerifiedConnectionExternalIdentity,
  VerifiedConnectionExternalIdentity,
} from "./connection-external-identity-store";
import { bindVerifiedConnectionExternalIdentity } from "./connection-external-identity-store";
import type { VerifiedWebhookDeliveryInput } from "./webhook-inbox-store";
import { recordVerifiedWebhookDelivery } from "./webhook-inbox-store";

export type WebhookRegistrationState =
  | "pending_registration"
  | "registering"
  | "registration_uncertain"
  | "active"
  | "pending_removal"
  | "removing"
  | "cleanup_failed"
  | "removed";

export interface WebhookRegistrationKey {
  readonly businessId: string;
  readonly connectionId: string;
  readonly integrationId: string;
  readonly integrationMajorVersion: number;
}

export interface WebhookRegistrationTarget {
  readonly integrationKey: string;
  readonly manifestDigest: string;
  readonly stepId: string;
  readonly callbackUrl: string;
  readonly operationId: string;
  readonly unregisterOperationId: string;
  readonly secretSlot: string;
}

export interface ActiveWebhookRegistration extends WebhookRegistrationTarget {
  readonly subscriptionId: string;
  readonly secretRef: `secret://${string}`;
}

export interface PersistedWebhookRegistration extends WebhookRegistrationKey {
  readonly desiredState: "active" | "removed";
  readonly state: WebhookRegistrationState;
  readonly target: WebhookRegistrationTarget;
  readonly active: ActiveWebhookRegistration | null;
  readonly stagedSecretRef: `secret://${string}` | null;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly lastError: string | null;
  readonly generation: number;
  readonly revision: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type WebhookRegistrationAttemptState =
  | "unresolved"
  | "cleanup_pending"
  | "cleanup_failed"
  | "adopted"
  | "absent"
  | "removed";

export interface SettledWebhookRegistrationAbsenceEvidence {
  readonly proofDigest: string;
  readonly verifiedAt: string;
  readonly verifiedBy: string;
}

export interface PersistedWebhookRegistrationAttempt extends WebhookRegistrationKey {
  readonly attemptId: string;
  readonly generation: number;
  readonly target: WebhookRegistrationTarget;
  readonly idempotencyKey: string;
  readonly state: WebhookRegistrationAttemptState;
  readonly secretRef: `secret://${string}`;
  readonly subscriptionId: string | null;
  readonly verifiedIdentity: BindVerifiedConnectionExternalIdentity | null;
  readonly settledAbsenceEvidence: SettledWebhookRegistrationAbsenceEvidence | null;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WebhookRegistrationAttemptClaim extends PersistedWebhookRegistrationAttempt {
  readonly action: "reconcile" | "remove";
}

export interface WebhookRegistrationClaim extends PersistedWebhookRegistration {
  readonly action: "register" | "remove";
  readonly authStepRevision: number | null;
}

export type CompleteWebhookRegistrationResult =
  | { readonly kind: "active"; readonly registration: PersistedWebhookRegistration }
  | {
      readonly kind: "cleanup_required";
      readonly attempt: PersistedWebhookRegistrationAttempt;
    }
  | { readonly kind: "stale" };

export const WEBHOOK_REGISTRATION_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS oim_webhook_registrations (
    business_id                  text NOT NULL,
    connection_id                text NOT NULL,
    integration_id               text NOT NULL,
    integration_major_version    integer NOT NULL CHECK (integration_major_version >= 0),
    desired_state                text NOT NULL CHECK (desired_state IN ('active', 'removed')),
    state                        text NOT NULL CHECK (
      state IN (
        'pending_registration', 'registering', 'registration_uncertain', 'active', 'pending_removal',
        'removing', 'cleanup_failed', 'removed'
      )
    ),
    target                       jsonb NOT NULL CHECK (jsonb_typeof(target) = 'object'),
    active_registration          jsonb
      CHECK (active_registration IS NULL OR jsonb_typeof(active_registration) = 'object'),
    staged_secret_ref            text CHECK (
      staged_secret_ref IS NULL OR staged_secret_ref LIKE 'secret://%'
    ),
    attempts                     integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at              timestamptz NOT NULL DEFAULT now(),
    lease_token                  text,
    lease_expires_at             timestamptz,
    last_error                   text,
    generation                   bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
    revision                     bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at                   timestamptz NOT NULL DEFAULT now(),
    updated_at                   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, connection_id),
    FOREIGN KEY (
      business_id, connection_id, integration_id, integration_major_version
    ) REFERENCES connections (
      business_id, id, integration_id, integration_major_version
    ) ON DELETE CASCADE,
    CHECK (
      (lease_token IS NULL AND lease_expires_at IS NULL)
      OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    )
  )`,
  `CREATE INDEX IF NOT EXISTS oim_webhook_registrations_due_idx
     ON oim_webhook_registrations (state, next_attempt_at, lease_expires_at)
     WHERE state IN (
       'pending_registration', 'pending_removal', 'cleanup_failed',
       'registering', 'registration_uncertain', 'removing'
     )`,
  `CREATE TABLE IF NOT EXISTS oim_webhook_registration_attempts (
    attempt_id                    text PRIMARY KEY,
    business_id                   text NOT NULL,
    connection_id                 text NOT NULL,
    integration_id                text NOT NULL,
    integration_major_version     integer NOT NULL CHECK (integration_major_version >= 0),
    generation                    bigint NOT NULL CHECK (generation > 0),
    target                        jsonb NOT NULL CHECK (jsonb_typeof(target) = 'object'),
    idempotency_key               text NOT NULL,
    state                         text NOT NULL CHECK (
      state IN (
        'unresolved', 'cleanup_pending', 'cleanup_failed', 'adopted', 'absent', 'removed'
      )
    ),
    secret_ref                    text NOT NULL CHECK (secret_ref LIKE 'secret://%'),
    subscription_id               text,
    verified_identity             jsonb
      CHECK (verified_identity IS NULL OR jsonb_typeof(verified_identity) = 'object'),
    settled_absence_evidence      jsonb
      CHECK (
        settled_absence_evidence IS NULL
        OR jsonb_typeof(settled_absence_evidence) = 'object'
      ),
    attempts                      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at               timestamptz NOT NULL DEFAULT now(),
    lease_token                   text,
    lease_expires_at              timestamptz,
    last_error                    text,
    created_at                    timestamptz NOT NULL DEFAULT now(),
    updated_at                    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, connection_id, generation),
    UNIQUE (business_id, connection_id, idempotency_key),
    FOREIGN KEY (business_id, connection_id)
      REFERENCES oim_webhook_registrations(business_id, connection_id) ON DELETE CASCADE,
    CHECK (
      (lease_token IS NULL AND lease_expires_at IS NULL)
      OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    ),
    CHECK (
      (subscription_id IS NULL AND verified_identity IS NULL)
      OR (subscription_id IS NOT NULL AND verified_identity IS NOT NULL)
    )
  )`,
  `CREATE INDEX IF NOT EXISTS oim_webhook_registration_attempts_due_idx
     ON oim_webhook_registration_attempts (state, next_attempt_at, lease_expires_at)
     WHERE state IN ('unresolved', 'cleanup_pending', 'cleanup_failed')`,
];

interface RegistrationRow {
  business_id: string;
  connection_id: string;
  integration_id: string;
  integration_major_version: number;
  desired_state: "active" | "removed";
  state: WebhookRegistrationState;
  target: WebhookRegistrationTarget;
  active_registration: ActiveWebhookRegistration | null;
  staged_secret_ref: `secret://${string}` | null;
  attempts: number;
  next_attempt_at: Date;
  lease_token: string | null;
  lease_expires_at: Date | null;
  last_error: string | null;
  generation: number;
  revision: number;
  created_at: Date;
  updated_at: Date;
}

interface RegistrationAttemptRow {
  attempt_id: string;
  business_id: string;
  connection_id: string;
  integration_id: string;
  integration_major_version: number;
  generation: number;
  target: WebhookRegistrationTarget;
  idempotency_key: string;
  state: WebhookRegistrationAttemptState;
  secret_ref: `secret://${string}`;
  subscription_id: string | null;
  verified_identity: BindVerifiedConnectionExternalIdentity | null;
  settled_absence_evidence: SettledWebhookRegistrationAbsenceEvidence | null;
  attempts: number;
  next_attempt_at: Date;
  lease_token: string | null;
  lease_expires_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

const SELECT_REGISTRATION = "SELECT * FROM oim_webhook_registrations";

function fromRow(row: RegistrationRow): PersistedWebhookRegistration {
  return {
    businessId: row.business_id,
    connectionId: row.connection_id,
    integrationId: row.integration_id,
    integrationMajorVersion: row.integration_major_version,
    desiredState: row.desired_state,
    state: row.state,
    target: row.target,
    active: row.active_registration,
    stagedSecretRef: row.staged_secret_ref,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    lastError: row.last_error,
    generation: row.generation,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function attemptFromRow(row: RegistrationAttemptRow): PersistedWebhookRegistrationAttempt {
  return {
    attemptId: row.attempt_id,
    businessId: row.business_id,
    connectionId: row.connection_id,
    integrationId: row.integration_id,
    integrationMajorVersion: row.integration_major_version,
    generation: row.generation,
    target: row.target,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    secretRef: row.secret_ref,
    subscriptionId: row.subscription_id,
    verifiedIdentity: row.verified_identity,
    settledAbsenceEvidence: row.settled_absence_evidence,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function targetMatches(
  active: ActiveWebhookRegistration,
  target: WebhookRegistrationTarget
): boolean {
  return (
    active.integrationKey === target.integrationKey &&
    active.manifestDigest === target.manifestDigest &&
    active.stepId === target.stepId &&
    active.callbackUrl === target.callbackUrl &&
    active.operationId === target.operationId &&
    active.unregisterOperationId === target.unregisterOperationId &&
    active.secretSlot === target.secretSlot
  );
}

function sameTarget(left: WebhookRegistrationTarget, right: WebhookRegistrationTarget): boolean {
  return (
    left.integrationKey === right.integrationKey &&
    left.manifestDigest === right.manifestDigest &&
    left.stepId === right.stepId &&
    left.callbackUrl === right.callbackUrl &&
    left.operationId === right.operationId &&
    left.unregisterOperationId === right.unregisterOperationId &&
    left.secretSlot === right.secretSlot
  );
}

function assertKey(key: WebhookRegistrationKey): void {
  if (
    key.businessId.length === 0 ||
    key.connectionId.length === 0 ||
    key.integrationId.length === 0 ||
    !Number.isSafeInteger(key.integrationMajorVersion) ||
    key.integrationMajorVersion < 0
  ) {
    throw new Error("invalid_webhook_registration_key");
  }
}

export class WebhookRegistrationStore {
  constructor(private readonly transactions: TransactionPort) {}

  async requestRegistration(
    key: WebhookRegistrationKey,
    target: WebhookRegistrationTarget,
    now = new Date()
  ): Promise<PersistedWebhookRegistration> {
    assertKey(key);
    return this.transactions.withTransaction(async (transaction) => {
      const connection = await transaction.query<{ id: string }>(
        `SELECT id FROM connections
          WHERE business_id = $1 AND id = $2
            AND integration_id = $3 AND integration_major_version = $4
          FOR UPDATE`,
        [key.businessId, key.connectionId, key.integrationId, key.integrationMajorVersion]
      );
      if (connection.rows.length !== 1) throw new Error("webhook_connection_unavailable");
      const available = await transaction.query(
        `SELECT 1 FROM connections
          WHERE business_id = $1 AND id = $2
            AND integration_id = $3 AND integration_major_version = $4
            AND status = 'active'
            AND NOT EXISTS (
              SELECT 1 FROM oim_ingress_teardowns
               WHERE business_id = $1 AND connection_id = $2
            )`,
        [key.businessId, key.connectionId, key.integrationId, key.integrationMajorVersion]
      );
      if (available.rows.length !== 1) throw new Error("webhook_connection_unavailable");

      const current = await transaction.query<RegistrationRow>(
        `${SELECT_REGISTRATION}
          WHERE business_id = $1 AND connection_id = $2
          FOR UPDATE`,
        [key.businessId, key.connectionId]
      );
      const row = current.rows[0];
      if (row === undefined) {
        const inserted = await transaction.query<RegistrationRow>(
          `INSERT INTO oim_webhook_registrations (
             business_id, connection_id, integration_id, integration_major_version,
             desired_state, state, target, next_attempt_at
           ) VALUES ($1, $2, $3, $4, 'active', 'pending_registration', $5::jsonb, $6)
           RETURNING *`,
          [
            key.businessId,
            key.connectionId,
            key.integrationId,
            key.integrationMajorVersion,
            JSON.stringify(target),
            now,
          ]
        );
        const created = inserted.rows[0];
        if (created === undefined) throw new Error("webhook_registration_not_persisted");
        return fromRow(created);
      }
      if (
        row.integration_id !== key.integrationId ||
        row.integration_major_version !== key.integrationMajorVersion
      ) {
        throw new Error("webhook_registration_identity_conflict");
      }

      const targetChanged = !sameTarget(row.target, target);
      const state = targetChanged
        ? row.active_registration === null
          ? "pending_registration"
          : "pending_removal"
        : row.state === "registering" || row.state === "removing"
          ? row.state
          : row.active_registration !== null && targetMatches(row.active_registration, target)
            ? "active"
            : row.active_registration === null
              ? "pending_registration"
              : "pending_removal";
      const updated = await transaction.query<RegistrationRow>(
        `UPDATE oim_webhook_registrations
            SET desired_state = 'active', state = $3, target = $4::jsonb,
                next_attempt_at = $5, last_error = NULL,
                generation = generation + CASE
                  WHEN desired_state = 'removed' OR $6 THEN 1 ELSE 0
                END,
                staged_secret_ref = CASE WHEN $6 THEN NULL ELSE staged_secret_ref END,
                lease_token = CASE WHEN $6 THEN NULL ELSE lease_token END,
                lease_expires_at = CASE WHEN $6 THEN NULL ELSE lease_expires_at END,
                revision = revision + 1, updated_at = now()
          WHERE business_id = $1 AND connection_id = $2
          RETURNING *`,
        [key.businessId, key.connectionId, state, JSON.stringify(target), now, targetChanged]
      );
      const next = updated.rows[0];
      if (next === undefined) throw new Error("webhook_registration_not_persisted");
      return fromRow(next);
    });
  }

  async requestRemoval(
    key: WebhookRegistrationKey,
    now = new Date()
  ): Promise<PersistedWebhookRegistration | null> {
    assertKey(key);
    return this.transactions.withTransaction(async (transaction) => {
      const connection = await transaction.query(
        `SELECT id FROM connections
          WHERE business_id = $1 AND id = $2
            AND integration_id = $3 AND integration_major_version = $4
          FOR UPDATE`,
        [key.businessId, key.connectionId, key.integrationId, key.integrationMajorVersion]
      );
      if (connection.rows.length !== 1) return null;
      const current = await transaction.query<RegistrationRow>(
        `${SELECT_REGISTRATION}
          WHERE business_id = $1 AND connection_id = $2
            AND integration_id = $3 AND integration_major_version = $4
          FOR UPDATE`,
        [key.businessId, key.connectionId, key.integrationId, key.integrationMajorVersion]
      );
      const row = current.rows[0];
      if (row === undefined) return null;
      const unresolved = await transaction.query(
        `SELECT 1 FROM oim_webhook_registration_attempts
          WHERE business_id = $1 AND connection_id = $2
            AND state IN ('unresolved', 'cleanup_pending', 'cleanup_failed')
          LIMIT 1`,
        [key.businessId, key.connectionId]
      );

      const nextState =
        row.state === "registering" || row.state === "removing"
          ? row.state
          : row.active_registration === null
            ? unresolved.rows.length === 0
              ? "removed"
              : "cleanup_failed"
            : "pending_removal";
      const updated = await transaction.query<RegistrationRow>(
        `UPDATE oim_webhook_registrations
            SET desired_state = 'removed', state = $3, next_attempt_at = $4,
                lease_token = CASE WHEN state IN ('registering', 'removing') THEN lease_token ELSE NULL END,
                lease_expires_at =
                  CASE WHEN state IN ('registering', 'removing') THEN lease_expires_at ELSE NULL END,
                revision = revision + 1, updated_at = now()
          WHERE business_id = $1 AND connection_id = $2
          RETURNING *`,
        [key.businessId, key.connectionId, nextState, now]
      );
      await transaction.query(
        `UPDATE connections
            SET webhook_registration = NULL,
                health_status = CASE
                  WHEN status = 'active' THEN 'action_required'
                  ELSE health_status
                END,
                health_checked_at = $5,
                updated_at = now()
          WHERE business_id = $1 AND id = $2
            AND integration_id = $3 AND integration_major_version = $4`,
        [key.businessId, key.connectionId, key.integrationId, key.integrationMajorVersion, now]
      );
      await transaction.query(
        `UPDATE connection_auth_steps
            SET status = CASE WHEN status = 'revoked' THEN status ELSE 'action_required' END,
                revision = revision + 1, health_checked_at = $3, updated_at = now()
          WHERE business_id = $1 AND connection_id = $2
            AND step_id = ($4::jsonb ->> 'stepId')`,
        [key.businessId, key.connectionId, now, JSON.stringify(row.target)]
      );
      return updated.rows[0] === undefined ? null : fromRow(updated.rows[0]);
    });
  }

  async claim(
    key: WebhookRegistrationKey,
    leaseToken: string,
    leaseSeconds: number,
    now = new Date()
  ): Promise<WebhookRegistrationClaim | null> {
    assertKey(key);
    return this.transactions.withTransaction(async (transaction) =>
      this.claimWhere(
        transaction,
        `business_id = $1 AND connection_id = $2
         AND integration_id = $3 AND integration_major_version = $4`,
        [key.businessId, key.connectionId, key.integrationId, key.integrationMajorVersion],
        leaseToken,
        leaseSeconds,
        now
      )
    );
  }

  async claimNext(
    leaseToken: string,
    leaseSeconds: number,
    now = new Date()
  ): Promise<WebhookRegistrationClaim | null> {
    return this.transactions.withTransaction(async (transaction) =>
      this.claimWhere(transaction, "TRUE", [], leaseToken, leaseSeconds, now)
    );
  }

  private async claimWhere(
    transaction: Queryable,
    predicate: string,
    parameters: readonly unknown[],
    leaseToken: string,
    leaseSeconds: number,
    now: Date
  ): Promise<WebhookRegistrationClaim | null> {
    const offset = parameters.length;
    const candidate = await transaction.query<RegistrationRow>(
      `${SELECT_REGISTRATION}
        WHERE ${predicate}
          AND state IN (
            'pending_registration', 'pending_removal', 'cleanup_failed',
            'registering', 'removing'
          )
          AND NOT (
            active_registration IS NULL
            AND EXISTS (
              SELECT 1 FROM oim_webhook_registration_attempts attempt
               WHERE attempt.business_id = oim_webhook_registrations.business_id
                 AND attempt.connection_id = oim_webhook_registrations.connection_id
                 AND attempt.state IN ('unresolved', 'cleanup_pending', 'cleanup_failed')
            )
          )
          AND next_attempt_at <= $${offset + 1}
          AND (lease_expires_at IS NULL OR lease_expires_at <= $${offset + 1})
        ORDER BY next_attempt_at, updated_at
        LIMIT 1`,
      [...parameters, now]
    );
    const candidateRow = candidate.rows[0];
    if (candidateRow === undefined) return null;
    const connection = await transaction.query(
      `SELECT id FROM connections
        WHERE business_id = $1 AND id = $2
          AND integration_id = $3 AND integration_major_version = $4
        FOR SHARE`,
      [
        candidateRow.business_id,
        candidateRow.connection_id,
        candidateRow.integration_id,
        candidateRow.integration_major_version,
      ]
    );
    if (connection.rows.length !== 1) return null;
    const selected = await transaction.query<RegistrationRow>(
      `${SELECT_REGISTRATION}
        WHERE business_id = $1 AND connection_id = $2
          AND state IN (
            'pending_registration', 'pending_removal', 'cleanup_failed',
            'registering', 'removing'
          )
          AND NOT (
            active_registration IS NULL
            AND EXISTS (
              SELECT 1 FROM oim_webhook_registration_attempts attempt
               WHERE attempt.business_id = oim_webhook_registrations.business_id
                 AND attempt.connection_id = oim_webhook_registrations.connection_id
                 AND attempt.state IN ('unresolved', 'cleanup_pending', 'cleanup_failed')
            )
          )
          AND next_attempt_at <= $3
          AND (lease_expires_at IS NULL OR lease_expires_at <= $3)
          AND (
            desired_state = 'removed'
            OR NOT EXISTS (
              SELECT 1 FROM oim_ingress_teardowns
               WHERE business_id = $1 AND connection_id = $2
            )
          )
        FOR UPDATE SKIP LOCKED`,
      [candidateRow.business_id, candidateRow.connection_id, now]
    );
    const row = selected.rows[0];
    if (row === undefined) return null;
    const action =
      row.desired_state === "removed" || row.active_registration !== null ? "remove" : "register";
    const state = action === "register" ? "registering" : "removing";
    const updated = await transaction.query<RegistrationRow>(
      `UPDATE oim_webhook_registrations
          SET state = $3, lease_token = $4,
              lease_expires_at = $5::timestamptz + make_interval(secs => $6),
              attempts = attempts + 1, updated_at = now()
        WHERE business_id = $1 AND connection_id = $2
        RETURNING *`,
      [row.business_id, row.connection_id, state, leaseToken, now, leaseSeconds]
    );
    const claimed = updated.rows[0];
    if (claimed === undefined) return null;
    let authStepRevision: number | null = null;
    if (action === "register") {
      const step = await transaction.query<{ revision: number }>(
        `SELECT revision FROM connection_auth_steps
          WHERE business_id = $1 AND connection_id = $2
            AND step_id = $3 AND status <> 'revoked'`,
        [row.business_id, row.connection_id, row.target.stepId]
      );
      authStepRevision = step.rows[0]?.revision ?? null;
    }
    return { ...fromRow(claimed), action, authStepRevision };
  }

  async stageSecret(
    key: WebhookRegistrationKey,
    leaseToken: string,
    secretRef: `secret://${string}`
  ): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `UPDATE oim_webhook_registrations
            SET staged_secret_ref = $4, updated_at = now()
          WHERE business_id = $1 AND connection_id = $2
            AND lease_token = $3 AND state = 'registering'
          RETURNING connection_id`,
        [key.businessId, key.connectionId, leaseToken, secretRef]
      );
      return result.rows.length === 1;
    });
  }

  async recordDispatchedAttempt(
    claim: WebhookRegistrationClaim,
    input: {
      readonly attemptId: string;
      readonly idempotencyKey: string;
      readonly secretRef: `secret://${string}`;
      readonly now?: Date;
    }
  ): Promise<PersistedWebhookRegistrationAttempt | null> {
    const now = input.now ?? new Date();
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<RegistrationAttemptRow>(
        `INSERT INTO oim_webhook_registration_attempts (
           attempt_id, business_id, connection_id, integration_id,
           integration_major_version, generation, target, idempotency_key,
           state, secret_ref, next_attempt_at, created_at, updated_at
         )
         SELECT $4, business_id, connection_id, integration_id,
                integration_major_version, generation, target, $5,
                'unresolved', $6, $7, $7, $7
           FROM oim_webhook_registrations
          WHERE business_id = $1 AND connection_id = $2
            AND lease_token = $3 AND state = 'registering'
            AND generation = $8 AND staged_secret_ref = $6
         ON CONFLICT (attempt_id) DO UPDATE
           SET updated_at = EXCLUDED.updated_at
         WHERE oim_webhook_registration_attempts.business_id = EXCLUDED.business_id
           AND oim_webhook_registration_attempts.connection_id = EXCLUDED.connection_id
           AND oim_webhook_registration_attempts.integration_id = EXCLUDED.integration_id
           AND oim_webhook_registration_attempts.integration_major_version =
               EXCLUDED.integration_major_version
           AND oim_webhook_registration_attempts.generation = EXCLUDED.generation
           AND oim_webhook_registration_attempts.target = EXCLUDED.target
           AND oim_webhook_registration_attempts.idempotency_key = EXCLUDED.idempotency_key
           AND oim_webhook_registration_attempts.secret_ref = EXCLUDED.secret_ref
           AND oim_webhook_registration_attempts.state = 'unresolved'
         RETURNING *`,
        [
          claim.businessId,
          claim.connectionId,
          claim.leaseToken,
          input.attemptId,
          input.idempotencyKey,
          input.secretRef,
          now,
          claim.generation,
        ]
      );
      return result.rows[0] === undefined ? null : attemptFromRow(result.rows[0]);
    });
  }

  async recordAttemptSuccess(
    attemptId: string,
    output: {
      readonly subscriptionId: string;
      readonly verifiedIdentity: BindVerifiedConnectionExternalIdentity;
      readonly now?: Date;
    }
  ): Promise<PersistedWebhookRegistrationAttempt | null> {
    const now = output.now ?? new Date();
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<RegistrationAttemptRow>(
        `UPDATE oim_webhook_registration_attempts
            SET state = 'cleanup_pending', subscription_id = $2,
                verified_identity = $3::jsonb, last_error = NULL,
                settled_absence_evidence = NULL,
                next_attempt_at = $4, updated_at = now()
          WHERE attempt_id = $1
            AND business_id = $5 AND connection_id = $6
            AND integration_id = $7 AND integration_major_version = $8
            AND state IN (
              'unresolved', 'cleanup_pending', 'cleanup_failed', 'absent', 'removed'
            )
          RETURNING *`,
        [
          attemptId,
          output.subscriptionId,
          JSON.stringify(output.verifiedIdentity),
          now,
          output.verifiedIdentity.businessId,
          output.verifiedIdentity.connectionId,
          output.verifiedIdentity.integrationId,
          output.verifiedIdentity.integrationMajorVersion,
        ]
      );
      return result.rows[0] === undefined ? null : attemptFromRow(result.rows[0]);
    });
  }

  async markRegistrationUncertain(
    claim: WebhookRegistrationClaim,
    error: string,
    retryAfterSeconds: number,
    now = new Date()
  ): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `UPDATE oim_webhook_registrations
            SET state = 'registration_uncertain', last_error = $4,
                next_attempt_at = $5::timestamptz + make_interval(secs => $6),
                lease_token = NULL, lease_expires_at = NULL,
                revision = revision + 1, updated_at = now()
          WHERE business_id = $1 AND connection_id = $2 AND lease_token = $3
            AND state = 'registering'
          RETURNING connection_id`,
        [
          claim.businessId,
          claim.connectionId,
          claim.leaseToken,
          error.slice(0, 1_024),
          now,
          retryAfterSeconds,
        ]
      );
      return result.rows.length === 1;
    });
  }

  async completeRegistration(
    claim: WebhookRegistrationClaim,
    output: {
      readonly attemptId: string;
      readonly subscriptionId: string;
      readonly secretRef: `secret://${string}`;
      readonly verifiedIdentity: BindVerifiedConnectionExternalIdentity;
      readonly now?: Date;
    }
  ): Promise<CompleteWebhookRegistrationResult> {
    const now = output.now ?? new Date();
    return this.transactions.withTransaction(async (transaction) => {
      const connectionLock = await transaction.query(
        `SELECT id FROM connections
          WHERE business_id = $1 AND id = $2
            AND integration_id = $3 AND integration_major_version = $4
          FOR UPDATE`,
        [claim.businessId, claim.connectionId, claim.integrationId, claim.integrationMajorVersion]
      );
      if (connectionLock.rows.length !== 1) return { kind: "stale" };
      const current = await transaction.query<RegistrationRow>(
        `${SELECT_REGISTRATION}
          WHERE business_id = $1 AND connection_id = $2
          FOR UPDATE`,
        [claim.businessId, claim.connectionId]
      );
      const row = current.rows[0];
      const attemptResult = await transaction.query<RegistrationAttemptRow>(
        `SELECT * FROM oim_webhook_registration_attempts
          WHERE attempt_id = $1
          FOR UPDATE`,
        [output.attemptId]
      );
      const attempt = attemptResult.rows[0];
      if (
        row === undefined ||
        attempt === undefined ||
        attempt.business_id !== claim.businessId ||
        attempt.connection_id !== claim.connectionId ||
        attempt.generation !== claim.generation ||
        !sameTarget(attempt.target, claim.target) ||
        attempt.secret_ref !== output.secretRef ||
        attempt.subscription_id !== output.subscriptionId
      ) {
        return { kind: "stale" };
      }
      if (attempt.lease_token !== null) {
        return { kind: "cleanup_required", attempt: attemptFromRow(attempt) };
      }
      const active: ActiveWebhookRegistration = {
        ...row.target,
        subscriptionId: output.subscriptionId,
        secretRef: output.secretRef,
      };
      if (
        row.generation !== claim.generation ||
        !sameTarget(row.target, claim.target) ||
        row.staged_secret_ref !== output.secretRef ||
        row.lease_token !== claim.leaseToken ||
        row.state !== "registering" ||
        row.desired_state === "removed" ||
        claim.authStepRevision === null
      ) {
        return {
          kind: "cleanup_required",
          attempt: await this.queueAttemptCleanup(transaction, attempt, now),
        };
      }
      if (
        output.verifiedIdentity.businessId !== row.business_id ||
        output.verifiedIdentity.connectionId !== row.connection_id ||
        output.verifiedIdentity.integrationId !== row.integration_id ||
        output.verifiedIdentity.integrationMajorVersion !== row.integration_major_version
      ) {
        throw new Error("webhook_registration_verified_identity_mismatch");
      }
      const connectionFence = await transaction.query(
        `SELECT 1 FROM connections
          WHERE business_id = $1 AND id = $2
            AND integration_id = $3 AND integration_major_version = $4
            AND status = 'active'
            AND NOT EXISTS (
              SELECT 1 FROM oim_ingress_teardowns
               WHERE business_id = $1 AND connection_id = $2
            )`,
        [row.business_id, row.connection_id, row.integration_id, row.integration_major_version]
      );
      if (connectionFence.rows.length !== 1) {
        return {
          kind: "cleanup_required",
          attempt: await this.queueAttemptCleanup(transaction, attempt, now),
        };
      }

      const step = await transaction.query(
        `UPDATE connection_auth_steps
            SET status = 'active', access_slot = $5, access_secret_ref = $6,
                refresh_slot = NULL, refresh_secret_ref = NULL,
                external_identity = NULL, expires_at = NULL,
                health_checked_at = $7, revision = revision + 1, updated_at = now()
          WHERE business_id = $1 AND connection_id = $2 AND step_id = $3
            AND revision = $4 AND status <> 'revoked'
          RETURNING step_id`,
        [
          row.business_id,
          row.connection_id,
          row.target.stepId,
          claim.authStepRevision,
          row.target.secretSlot,
          output.secretRef,
          now,
        ]
      );
      if (step.rows.length !== 1) {
        return {
          kind: "cleanup_required",
          attempt: await this.queueAttemptCleanup(transaction, attempt, now),
        };
      }

      await bindVerifiedConnectionExternalIdentity(transaction, output.verifiedIdentity);
      const aggregate = await transaction.query<{ healthy: boolean; expires_at: Date | null }>(
        `SELECT bool_and(status = 'active') AS healthy, min(expires_at) AS expires_at
           FROM connection_auth_steps
          WHERE business_id = $1 AND connection_id = $2`,
        [row.business_id, row.connection_id]
      );
      const published = await transaction.query(
        `UPDATE connections
            SET secret_bindings = secret_bindings || $5::jsonb,
                webhook_registration = $6::jsonb,
                health_status = CASE WHEN $7 THEN 'healthy' ELSE 'action_required' END,
                health_checked_at = $8,
                expires_at = $9,
                updated_at = now()
          WHERE business_id = $1 AND id = $2
            AND integration_id = $3 AND integration_major_version = $4
            AND status = 'active'
            AND NOT EXISTS (
              SELECT 1 FROM oim_ingress_teardowns
               WHERE business_id = $1 AND connection_id = $2
            )
          RETURNING id`,
        [
          row.business_id,
          row.connection_id,
          row.integration_id,
          row.integration_major_version,
          JSON.stringify({ [row.target.secretSlot]: output.secretRef }),
          JSON.stringify({
            ingressUrl: row.target.callbackUrl,
            subscriptionId: output.subscriptionId,
            operationId: row.target.operationId,
            unregisterOperationId: row.target.unregisterOperationId,
            secretSlot: row.target.secretSlot,
          }),
          aggregate.rows[0]?.healthy === true,
          now,
          aggregate.rows[0]?.expires_at ?? null,
        ]
      );
      if (published.rows.length !== 1) {
        throw new Error("webhook_registration_connection_publication_lost");
      }
      await transaction.query(
        `UPDATE oim_webhook_registration_attempts
            SET state = 'adopted', lease_token = NULL, lease_expires_at = NULL,
                last_error = NULL, updated_at = now()
          WHERE attempt_id = $1`,
        [attempt.attempt_id]
      );

      const completed = await transaction.query<RegistrationRow>(
        `UPDATE oim_webhook_registrations
            SET state = 'active', active_registration = $4::jsonb,
                staged_secret_ref = NULL, lease_token = NULL, lease_expires_at = NULL,
                last_error = NULL, next_attempt_at = $5,
                revision = revision + 1, updated_at = now()
          WHERE business_id = $1 AND connection_id = $2 AND lease_token = $3
          RETURNING *`,
        [row.business_id, row.connection_id, claim.leaseToken, JSON.stringify(active), now]
      );
      const completedRow = completed.rows[0];
      return completedRow === undefined
        ? { kind: "stale" }
        : { kind: "active", registration: fromRow(completedRow) };
    });
  }

  private async queueAttemptCleanup(
    transaction: Queryable,
    attempt: RegistrationAttemptRow,
    now: Date
  ): Promise<PersistedWebhookRegistrationAttempt> {
    const result = await transaction.query<RegistrationAttemptRow>(
      `UPDATE oim_webhook_registration_attempts
          SET state = 'cleanup_pending', lease_token = NULL, lease_expires_at = NULL,
              next_attempt_at = $2, updated_at = now()
        WHERE attempt_id = $1
        RETURNING *`,
      [attempt.attempt_id, now]
    );
    const cleanup = result.rows[0];
    if (cleanup === undefined) throw new Error("webhook_cleanup_not_persisted");
    await transaction.query(
      `UPDATE oim_webhook_registrations
          SET state = CASE
                WHEN desired_state = 'removed' THEN 'cleanup_failed'
                ELSE 'pending_registration'
              END,
              staged_secret_ref = NULL, lease_token = NULL, lease_expires_at = NULL,
              next_attempt_at = $4, revision = revision + 1, updated_at = now()
        WHERE business_id = $1 AND connection_id = $2
          AND generation = $3 AND active_registration IS NULL
          AND staged_secret_ref = $5`,
      [attempt.business_id, attempt.connection_id, attempt.generation, now, attempt.secret_ref]
    );
    return attemptFromRow(cleanup);
  }

  async failClaim(
    claim: WebhookRegistrationClaim,
    error: string,
    retryAfterSeconds: number,
    now = new Date()
  ): Promise<boolean> {
    const state =
      claim.action === "remove"
        ? "cleanup_failed"
        : claim.desiredState === "removed"
          ? "removed"
          : "pending_registration";
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `UPDATE oim_webhook_registrations
            SET state = $4, last_error = $5,
                next_attempt_at = $6::timestamptz + make_interval(secs => $7),
                lease_token = NULL, lease_expires_at = NULL,
                revision = revision + 1, updated_at = now()
          WHERE business_id = $1 AND connection_id = $2 AND lease_token = $3
            AND state = $8
          RETURNING connection_id`,
        [
          claim.businessId,
          claim.connectionId,
          claim.leaseToken,
          state,
          error.slice(0, 1_024),
          now,
          retryAfterSeconds,
          claim.action === "remove" ? "removing" : "registering",
        ]
      );
      return result.rows.length === 1;
    });
  }

  async claimAttempt(
    key: WebhookRegistrationKey,
    leaseToken: string,
    leaseSeconds: number,
    now = new Date()
  ): Promise<WebhookRegistrationAttemptClaim | null> {
    return this.transactions.withTransaction((transaction) =>
      this.claimAttemptWhere(
        transaction,
        `business_id = $1 AND connection_id = $2
         AND integration_id = $3 AND integration_major_version = $4`,
        [key.businessId, key.connectionId, key.integrationId, key.integrationMajorVersion],
        leaseToken,
        leaseSeconds,
        now
      )
    );
  }

  async claimNextAttempt(
    leaseToken: string,
    leaseSeconds: number,
    now = new Date()
  ): Promise<WebhookRegistrationAttemptClaim | null> {
    return this.transactions.withTransaction((transaction) =>
      this.claimAttemptWhere(transaction, "TRUE", [], leaseToken, leaseSeconds, now)
    );
  }

  private async claimAttemptWhere(
    transaction: Queryable,
    predicate: string,
    parameters: readonly unknown[],
    leaseToken: string,
    leaseSeconds: number,
    now: Date
  ): Promise<WebhookRegistrationAttemptClaim | null> {
    const offset = parameters.length;
    const selected = await transaction.query<RegistrationAttemptRow>(
      `SELECT * FROM oim_webhook_registration_attempts
        WHERE ${predicate}
          AND state IN ('unresolved', 'cleanup_pending', 'cleanup_failed')
          AND next_attempt_at <= $${offset + 1}
          AND (lease_expires_at IS NULL OR lease_expires_at <= $${offset + 1})
          AND NOT EXISTS (
            SELECT 1 FROM oim_webhook_registrations registration
             WHERE registration.business_id =
                   oim_webhook_registration_attempts.business_id
               AND registration.connection_id =
                   oim_webhook_registration_attempts.connection_id
               AND registration.generation = oim_webhook_registration_attempts.generation
               AND registration.state = 'registering'
               AND registration.lease_token IS NOT NULL
               AND registration.lease_expires_at > $${offset + 1}
          )
        ORDER BY next_attempt_at, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
      [...parameters, now]
    );
    const row = selected.rows[0];
    if (row === undefined) return null;
    const updated = await transaction.query<RegistrationAttemptRow>(
      `UPDATE oim_webhook_registration_attempts
          SET lease_token = $2,
              lease_expires_at = $3::timestamptz + make_interval(secs => $4),
              attempts = attempts + 1, updated_at = now()
        WHERE attempt_id = $1
        RETURNING *`,
      [row.attempt_id, leaseToken, now, leaseSeconds]
    );
    const claimed = updated.rows[0];
    return claimed === undefined
      ? null
      : {
          ...attemptFromRow(claimed),
          action: claimed.subscription_id === null ? "reconcile" : "remove",
        };
  }

  async failAttempt(
    claim: WebhookRegistrationAttemptClaim,
    error: string,
    retryAfterSeconds: number,
    now = new Date()
  ): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `UPDATE oim_webhook_registration_attempts
            SET state = CASE
                  WHEN subscription_id IS NULL THEN 'unresolved'
                  ELSE 'cleanup_failed'
                END,
                last_error = $3,
                next_attempt_at = $4::timestamptz + make_interval(secs => $5),
                lease_token = NULL, lease_expires_at = NULL, updated_at = now()
          WHERE attempt_id = $1 AND lease_token = $2
          RETURNING attempt_id`,
        [claim.attemptId, claim.leaseToken, error.slice(0, 1_024), now, retryAfterSeconds]
      );
      return result.rows.length === 1;
    });
  }

  async completeAttemptAbsent(
    claim: WebhookRegistrationAttemptClaim,
    evidence: SettledWebhookRegistrationAbsenceEvidence,
    now = new Date()
  ): Promise<boolean> {
    if (
      !/^[0-9a-f]{64}$/.test(evidence.proofDigest) ||
      evidence.verifiedBy.length === 0 ||
      !Number.isFinite(Date.parse(evidence.verifiedAt))
    ) {
      throw new Error("invalid_webhook_registration_absence_evidence");
    }
    return this.completeAttempt(claim, "absent", now, evidence);
  }

  async completeAttemptRemoval(
    claim: WebhookRegistrationAttemptClaim,
    now = new Date()
  ): Promise<boolean> {
    return this.completeAttempt(claim, "removed", now, null);
  }

  private async completeAttempt(
    claim: WebhookRegistrationAttemptClaim,
    state: "absent" | "removed",
    now: Date,
    absenceEvidence: SettledWebhookRegistrationAbsenceEvidence | null
  ): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const connection = await transaction.query(
        `SELECT id FROM connections
          WHERE business_id = $1 AND id = $2
            AND integration_id = $3 AND integration_major_version = $4
          FOR UPDATE`,
        [claim.businessId, claim.connectionId, claim.integrationId, claim.integrationMajorVersion]
      );
      if (connection.rows.length !== 1) return false;
      await transaction.query(
        `${SELECT_REGISTRATION}
          WHERE business_id = $1 AND connection_id = $2
          FOR UPDATE`,
        [claim.businessId, claim.connectionId]
      );
      const completed = await transaction.query<RegistrationAttemptRow>(
        `UPDATE oim_webhook_registration_attempts
            SET state = $3, last_error = NULL, lease_token = NULL,
                lease_expires_at = NULL,
                settled_absence_evidence = $5::jsonb,
                updated_at = now()
          WHERE attempt_id = $1 AND lease_token = $2
            AND (
              ($3 = 'absent' AND state = 'unresolved' AND subscription_id IS NULL)
              OR (
                $3 = 'removed'
                AND state IN ('cleanup_pending', 'cleanup_failed')
                AND subscription_id = $4
              )
            )
          RETURNING *`,
        [
          claim.attemptId,
          claim.leaseToken,
          state,
          claim.subscriptionId,
          absenceEvidence === null ? null : JSON.stringify(absenceEvidence),
        ]
      );
      const attempt = completed.rows[0];
      if (attempt === undefined) return false;
      const unresolved = await transaction.query(
        `SELECT 1 FROM oim_webhook_registration_attempts
          WHERE business_id = $1 AND connection_id = $2
            AND state IN ('unresolved', 'cleanup_pending', 'cleanup_failed')
          LIMIT 1`,
        [attempt.business_id, attempt.connection_id]
      );
      if (unresolved.rows.length !== 0) return true;
      await transaction.query(
        `UPDATE oim_webhook_registrations
            SET state = CASE
                  WHEN desired_state = 'removed' THEN 'removed'
                  ELSE 'pending_registration'
                END,
                generation = generation + CASE
                  WHEN desired_state = 'active' AND generation = $3 THEN 1 ELSE 0
                END,
                staged_secret_ref = NULL, lease_token = NULL, lease_expires_at = NULL,
                last_error = NULL, next_attempt_at = $4,
                revision = revision + 1, updated_at = now()
          WHERE business_id = $1 AND connection_id = $2
            AND active_registration IS NULL
          RETURNING connection_id`,
        [attempt.business_id, attempt.connection_id, attempt.generation, now]
      );
      return true;
    });
  }

  async hasUnresolvedAttempts(key: WebhookRegistrationKey): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `SELECT 1 FROM oim_webhook_registration_attempts
          WHERE business_id = $1 AND connection_id = $2
            AND integration_id = $3 AND integration_major_version = $4
            AND state IN ('unresolved', 'cleanup_pending', 'cleanup_failed')
          LIMIT 1`,
        [key.businessId, key.connectionId, key.integrationId, key.integrationMajorVersion]
      );
      return result.rows.length === 1;
    });
  }

  async completeRemoval(
    claim: WebhookRegistrationClaim,
    now = new Date()
  ): Promise<PersistedWebhookRegistration | null> {
    if (claim.action !== "remove") return null;
    return this.transactions.withTransaction(async (transaction) => {
      const connection = await transaction.query(
        `SELECT id FROM connections
          WHERE business_id = $1 AND id = $2
            AND integration_id = $3 AND integration_major_version = $4
          FOR UPDATE`,
        [claim.businessId, claim.connectionId, claim.integrationId, claim.integrationMajorVersion]
      );
      if (connection.rows.length !== 1) return null;
      const current = await transaction.query<RegistrationRow>(
        `${SELECT_REGISTRATION}
          WHERE business_id = $1 AND connection_id = $2
            AND lease_token = $3 AND state = 'removing'
          FOR UPDATE`,
        [claim.businessId, claim.connectionId, claim.leaseToken]
      );
      const row = current.rows[0];
      if (row === undefined) return null;
      const active = claim.active;
      if (active === null) {
        if (row.active_registration !== null || row.staged_secret_ref !== claim.stagedSecretRef) {
          return null;
        }
        const completed = await transaction.query<RegistrationRow>(
          `UPDATE oim_webhook_registrations
              SET state = CASE
                    WHEN desired_state = 'active' THEN 'pending_registration'
                    ELSE 'removed'
                  END,
                  staged_secret_ref = NULL, lease_token = NULL, lease_expires_at = NULL,
                  last_error = NULL, next_attempt_at = $4,
                  revision = revision + 1, updated_at = now()
            WHERE business_id = $1 AND connection_id = $2 AND lease_token = $3
              AND NOT EXISTS (
                SELECT 1 FROM oim_webhook_registration_attempts
                 WHERE business_id = $1 AND connection_id = $2
                   AND state IN ('unresolved', 'cleanup_pending', 'cleanup_failed')
              )
            RETURNING *`,
          [row.business_id, row.connection_id, claim.leaseToken, now]
        );
        return completed.rows[0] === undefined ? null : fromRow(completed.rows[0]);
      }
      if (row.active_registration?.subscriptionId !== active.subscriptionId) {
        return null;
      }
      await transaction.query(
        `UPDATE connections
            SET secret_bindings = secret_bindings - $5,
                webhook_registration = NULL,
                updated_at = now()
          WHERE business_id = $1 AND id = $2
            AND integration_id = $3 AND integration_major_version = $4
            AND secret_bindings ->> $5 = $6`,
        [
          row.business_id,
          row.connection_id,
          row.integration_id,
          row.integration_major_version,
          active.secretSlot,
          active.secretRef,
        ]
      );
      await transaction.query(
        `UPDATE oim_webhook_registration_attempts
            SET state = 'removed', last_error = NULL, updated_at = now()
          WHERE business_id = $1 AND connection_id = $2
            AND state = 'adopted'
            AND subscription_id = $3 AND secret_ref = $4`,
        [row.business_id, row.connection_id, active.subscriptionId, active.secretRef]
      );
      const state = row.desired_state === "active" ? "pending_registration" : "removed";
      const completed = await transaction.query<RegistrationRow>(
        `UPDATE oim_webhook_registrations
            SET state = $4, active_registration = NULL, staged_secret_ref = NULL,
                lease_token = NULL, lease_expires_at = NULL, last_error = NULL,
                next_attempt_at = $5, revision = revision + 1, updated_at = now()
          WHERE business_id = $1 AND connection_id = $2 AND lease_token = $3
          RETURNING *`,
        [row.business_id, row.connection_id, claim.leaseToken, state, now]
      );
      return completed.rows[0] === undefined ? null : fromRow(completed.rows[0]);
    });
  }

  async findActive(
    key: WebhookRegistrationKey,
    integrationKey?: string
  ): Promise<PersistedWebhookRegistration | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<RegistrationRow>(
        `${SELECT_REGISTRATION} registration
          JOIN connections connection
            ON connection.business_id = registration.business_id
           AND connection.id = registration.connection_id
           AND connection.integration_id = registration.integration_id
           AND connection.integration_major_version = registration.integration_major_version
          WHERE registration.business_id = $1 AND registration.connection_id = $2
            AND registration.integration_id = $3
            AND registration.integration_major_version = $4
            AND registration.desired_state = 'active'
            AND registration.state = 'active'
            AND registration.active_registration IS NOT NULL
            AND connection.status = 'active'
            AND NOT EXISTS (
              SELECT 1 FROM oim_ingress_teardowns teardown
               WHERE teardown.business_id = registration.business_id
                 AND teardown.connection_id = registration.connection_id
            )
            AND ($5::text IS NULL OR registration.active_registration ->> 'integrationKey' = $5)`,
        [
          key.businessId,
          key.connectionId,
          key.integrationId,
          key.integrationMajorVersion,
          integrationKey ?? null,
        ]
      );
      return result.rows[0] === undefined ? null : fromRow(result.rows[0]);
    });
  }

  async recordVerifiedIfActive(
    key: WebhookRegistrationKey,
    expectedRevision: number,
    input: VerifiedWebhookDeliveryInput
  ) {
    return this.transactions.withTransaction(async (transaction) => {
      const connectionLock = await transaction.query(
        `SELECT id FROM connections
          WHERE business_id = $1 AND id = $2
            AND integration_id = $3 AND integration_major_version = $4
          FOR SHARE`,
        [key.businessId, key.connectionId, key.integrationId, key.integrationMajorVersion]
      );
      if (connectionLock.rows.length !== 1) throw new Error("webhook_registration_inactive");
      const active = await transaction.query<{ revision: number }>(
        `SELECT registration.revision
           FROM oim_webhook_registrations registration
           JOIN connections connection
             ON connection.business_id = registration.business_id
            AND connection.id = registration.connection_id
            AND connection.integration_id = registration.integration_id
            AND connection.integration_major_version = registration.integration_major_version
          WHERE registration.business_id = $1 AND registration.connection_id = $2
            AND registration.integration_id = $3
            AND registration.integration_major_version = $4
            AND registration.revision = $5
            AND registration.desired_state = 'active'
            AND registration.state = 'active'
            AND connection.status = 'active'
            AND NOT EXISTS (
              SELECT 1 FROM oim_ingress_teardowns teardown
               WHERE teardown.business_id = registration.business_id
                 AND teardown.connection_id = registration.connection_id
            )
          FOR SHARE OF registration`,
        [
          key.businessId,
          key.connectionId,
          key.integrationId,
          key.integrationMajorVersion,
          expectedRevision,
        ]
      );
      if (active.rows.length !== 1) throw new Error("webhook_registration_inactive");
      return recordVerifiedWebhookDelivery(transaction, key.businessId, input);
    });
  }

  async findVerifiedIdentity(
    key: Pick<WebhookRegistrationKey, "businessId" | "connectionId">
  ): Promise<VerifiedConnectionExternalIdentity | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<{
        business_id: string;
        connection_id: string;
        integration_id: string;
        integration_major_version: number;
        external_tenant_id: string;
        external_account_id: string;
        proof_kind: "auth" | "health";
        proof_digest: string;
        verified_at: Date;
        verified_by: string;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT * FROM connection_external_identities
          WHERE business_id = $1 AND connection_id = $2`,
        [key.businessId, key.connectionId]
      );
      const row = result.rows[0];
      return row === undefined
        ? null
        : {
            businessId: row.business_id,
            connectionId: row.connection_id,
            integrationId: row.integration_id,
            integrationMajorVersion: row.integration_major_version,
            externalTenantId: row.external_tenant_id,
            externalAccountId: row.external_account_id,
            proofKind: row.proof_kind,
            proofDigest: row.proof_digest,
            verifiedAt: row.verified_at.toISOString(),
            verifiedBy: row.verified_by,
            createdAt: row.created_at.toISOString(),
            updatedAt: row.updated_at.toISOString(),
          };
    });
  }
}
