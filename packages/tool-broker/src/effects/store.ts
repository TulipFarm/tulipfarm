import type { Queryable, TransactionPort } from "@tulipfarm/storage";
import type { ToolIntent } from "../intent";
import {
  type EffectAttempt,
  EffectLedgerError,
  type EffectRecord,
  type FinishEffectAttemptInput,
  type ReserveEffectInput,
  type ReserveEffectResult,
  type TransitionEffectInput,
} from "./model";

export const EFFECT_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS tool_intents (
    business_id        text NOT NULL,
    intent_id          text NOT NULL,
    run_id             uuid NOT NULL,
    state_id           text NOT NULL,
    idempotency_key    text NOT NULL,
    intent_digest      text NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
    normalized_intent  jsonb NOT NULL CHECK (jsonb_typeof(normalized_intent) = 'object'),
    created_at         timestamptz NOT NULL,
    PRIMARY KEY (business_id, intent_id),
    UNIQUE (business_id, idempotency_key)
  )`,
  `CREATE TABLE IF NOT EXISTS effect_records (
    business_id            text NOT NULL,
    effect_id              uuid NOT NULL,
    intent_id              text NOT NULL,
    run_id                 uuid NOT NULL,
    state_id               text NOT NULL,
    logical_effect_ordinal integer NOT NULL CHECK (logical_effect_ordinal >= 0),
    idempotency_key        text NOT NULL,
    intent_digest          text NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
    guardrail_revision     text NOT NULL,
    approval_id            text,
    state                  text NOT NULL CHECK (state IN (
      'proposed', 'denied', 'awaiting_approval', 'authorized', 'dispatched', 'confirmed',
      'failed', 'ambiguous', 'compensating', 'compensated', 'reconciliation_required'
    )),
    parent_effect_id       uuid,
    created_at             timestamptz NOT NULL,
    updated_at             timestamptz NOT NULL,
    PRIMARY KEY (business_id, effect_id),
    UNIQUE (business_id, idempotency_key),
    UNIQUE (business_id, run_id, state_id, logical_effect_ordinal),
    FOREIGN KEY (business_id, intent_id) REFERENCES tool_intents(business_id, intent_id),
    FOREIGN KEY (business_id, parent_effect_id)
      REFERENCES effect_records(business_id, effect_id)
  )`,
  `CREATE INDEX IF NOT EXISTS effect_records_reconciliation_idx
    ON effect_records (business_id, state, updated_at)
    WHERE state IN ('ambiguous', 'reconciliation_required')`,
  `CREATE TABLE IF NOT EXISTS effect_attempts (
    business_id        text NOT NULL,
    effect_id          uuid NOT NULL,
    attempt            integer NOT NULL CHECK (attempt > 0),
    state              text NOT NULL CHECK (
      state IN ('prepared', 'dispatched', 'confirmed', 'failed', 'ambiguous')
    ),
    provider_request_id text,
    output_digest      text CHECK (output_digest IS NULL OR output_digest ~ '^[a-f0-9]{64}$'),
    error_code         text,
    started_at         timestamptz NOT NULL,
    finished_at        timestamptz,
    PRIMARY KEY (business_id, effect_id, attempt),
    FOREIGN KEY (business_id, effect_id)
      REFERENCES effect_records(business_id, effect_id)
  )`,
];

export interface EffectStore {
  reserve(input: ReserveEffectInput): Promise<ReserveEffectResult>;
  reserveCompensation(
    input: ReserveEffectInput,
    parentEffectId: string
  ): Promise<ReserveEffectResult>;
  get(businessId: string, effectId: string): Promise<EffectRecord | undefined>;
  list(businessId: string): Promise<EffectRecord[]>;
  transition(input: TransitionEffectInput): Promise<EffectRecord>;
  beginAttempt(businessId: string, effectId: string, startedAt: string): Promise<EffectAttempt>;
  finishAttempt(input: FinishEffectAttemptInput): Promise<EffectRecord>;
  listAttempts(businessId: string, effectId: string): Promise<EffectAttempt[]>;
}

function freezeIntent(intent: ToolIntent): ToolIntent {
  return Object.freeze({
    ...structuredClone(intent),
    targetRefs: Object.freeze(intent.targetRefs.map((target) => Object.freeze({ ...target }))),
  });
}

function effect(input: ReserveEffectInput): EffectRecord {
  return Object.freeze({
    ...input,
    intent: freezeIntent(input.intent),
    state: "authorized",
    updatedAt: input.createdAt,
  });
}

export class MemoryEffectStore implements EffectStore {
  private readonly records = new Map<string, EffectRecord>();
  private readonly attempts = new Map<string, EffectAttempt[]>();

  private key(businessId: string, idempotencyKey: string): string {
    return `${businessId}\u0000${idempotencyKey}`;
  }

  async reserve(input: ReserveEffectInput): Promise<ReserveEffectResult> {
    const key = this.key(input.businessId, input.idempotencyKey);
    const existing = this.records.get(key);
    if (existing !== undefined) {
      if (existing.intentDigest !== input.intentDigest) {
        throw new EffectLedgerError("idempotency_digest_mismatch", input.idempotencyKey);
      }
      return { outcome: "duplicate", effect: existing };
    }
    const created = effect(input);
    this.records.set(key, created);
    return { outcome: "created", effect: created };
  }

  async reserveCompensation(
    input: ReserveEffectInput,
    parentEffectId: string
  ): Promise<ReserveEffectResult> {
    const parent = await this.get(input.businessId, parentEffectId);
    if (parent === undefined) throw new EffectLedgerError("effect_not_found", parentEffectId);
    if (parent.state !== "confirmed") {
      throw new EffectLedgerError("effect_state_conflict", parentEffectId);
    }
    const result = await this.reserve({ ...input, parentEffectId });
    const parentKey = this.key(input.businessId, parent.idempotencyKey);
    this.records.set(
      parentKey,
      Object.freeze({ ...parent, state: "compensating", updatedAt: input.createdAt })
    );
    return result;
  }

  async get(businessId: string, effectId: string): Promise<EffectRecord | undefined> {
    return [...this.records.values()].find(
      (record) => record.businessId === businessId && record.effectId === effectId
    );
  }

  async list(businessId: string): Promise<EffectRecord[]> {
    return [...this.records.values()].filter((record) => record.businessId === businessId);
  }

  async transition(input: TransitionEffectInput): Promise<EffectRecord> {
    const record = await this.get(input.businessId, input.effectId);
    if (record === undefined) throw new EffectLedgerError("effect_not_found", input.effectId);
    if (!input.expectedStates.includes(record.state)) {
      throw new EffectLedgerError("effect_state_conflict", input.effectId);
    }
    const updated = Object.freeze({
      ...record,
      state: input.state,
      updatedAt: input.updatedAt,
    });
    this.records.set(this.key(input.businessId, record.idempotencyKey), updated);
    return updated;
  }

  async beginAttempt(
    businessId: string,
    effectId: string,
    startedAt: string
  ): Promise<EffectAttempt> {
    const record = await this.get(businessId, effectId);
    if (record === undefined) throw new EffectLedgerError("effect_not_found", effectId);
    if (record.state !== "authorized") {
      throw new EffectLedgerError("effect_state_conflict", effectId);
    }
    const key = this.key(businessId, record.idempotencyKey);
    this.records.set(key, Object.freeze({ ...record, state: "dispatched", updatedAt: startedAt }));
    const existing = this.attempts.get(key) ?? [];
    const attempt = Object.freeze({
      businessId,
      effectId,
      attempt: existing.length + 1,
      state: "dispatched" as const,
      startedAt,
    });
    this.attempts.set(key, [...existing, attempt]);
    return attempt;
  }

  async finishAttempt(input: FinishEffectAttemptInput): Promise<EffectRecord> {
    const record = await this.get(input.businessId, input.effectId);
    if (record === undefined) throw new EffectLedgerError("effect_not_found", input.effectId);
    const key = this.key(input.businessId, record.idempotencyKey);
    const attempts = this.attempts.get(key) ?? [];
    const index = attempts.findIndex((attempt) => attempt.attempt === input.attempt);
    if (index < 0) throw new EffectLedgerError("attempt_not_found", String(input.attempt));
    const completed = Object.freeze({
      ...attempts[index],
      state: input.attemptState,
      providerRequestId: input.providerRequestId,
      outputDigest: input.outputDigest,
      errorCode: input.errorCode,
      finishedAt: input.finishedAt,
    });
    this.attempts.set(
      key,
      attempts.map((attempt, attemptIndex) => (attemptIndex === index ? completed : attempt))
    );
    const updated = Object.freeze({
      ...record,
      state: input.effectState,
      updatedAt: input.finishedAt,
    });
    this.records.set(key, updated);
    return updated;
  }

  async listAttempts(businessId: string, effectId: string): Promise<EffectAttempt[]> {
    const record = await this.get(businessId, effectId);
    if (record === undefined) return [];
    return [...(this.attempts.get(this.key(businessId, record.idempotencyKey)) ?? [])];
  }
}

interface EffectRow {
  effect_id: string;
  business_id: string;
  run_id: string;
  state_id: string;
  logical_effect_ordinal: number;
  idempotency_key: string;
  intent_digest: string;
  normalized_intent: ToolIntent;
  guardrail_revision: string;
  approval_id: string | null;
  state: EffectRecord["state"];
  parent_effect_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface EffectAttemptRow {
  business_id: string;
  effect_id: string;
  attempt: number;
  state: EffectAttempt["state"];
  provider_request_id: string | null;
  output_digest: string | null;
  error_code: string | null;
  started_at: string | Date;
  finished_at: string | Date | null;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function fromRow(row: EffectRow): EffectRecord {
  return Object.freeze({
    effectId: row.effect_id,
    businessId: row.business_id,
    runId: row.run_id,
    stateId: row.state_id,
    logicalEffectOrdinal: row.logical_effect_ordinal,
    idempotencyKey: row.idempotency_key,
    intentDigest: row.intent_digest,
    intent: freezeIntent(row.normalized_intent),
    guardrailRevision: row.guardrail_revision,
    approvalId: row.approval_id ?? undefined,
    state: row.state,
    parentEffectId: row.parent_effect_id ?? undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function attemptFromRow(row: EffectAttemptRow): EffectAttempt {
  return Object.freeze({
    businessId: row.business_id,
    effectId: row.effect_id,
    attempt: row.attempt,
    state: row.state,
    providerRequestId: row.provider_request_id ?? undefined,
    outputDigest: row.output_digest ?? undefined,
    errorCode: row.error_code ?? undefined,
    startedAt: iso(row.started_at),
    finishedAt: row.finished_at === null ? undefined : iso(row.finished_at),
  });
}

async function findByKey(
  queryable: Queryable,
  businessId: string,
  idempotencyKey: string
): Promise<EffectRecord | undefined> {
  const result = await queryable.query<EffectRow>(
    `SELECT effects.*, intents.normalized_intent
       FROM effect_records effects
       JOIN tool_intents intents
         ON intents.business_id = effects.business_id AND intents.intent_id = effects.intent_id
      WHERE effects.business_id = $1 AND effects.idempotency_key = $2`,
    [businessId, idempotencyKey]
  );
  return result.rows[0] === undefined ? undefined : fromRow(result.rows[0]);
}

export class PgEffectStore implements EffectStore {
  constructor(private readonly transactions: TransactionPort) {}

  reserve(input: ReserveEffectInput): Promise<ReserveEffectResult> {
    return this.transactions.withTransaction((transaction) =>
      this.reserveWithin(transaction, input)
    );
  }

  reserveCompensation(
    input: ReserveEffectInput,
    parentEffectId: string
  ): Promise<ReserveEffectResult> {
    return this.transactions.withTransaction(async (transaction) => {
      const parent = await transaction.query<{ state: EffectRecord["state"] }>(
        `SELECT state FROM effect_records
          WHERE business_id = $1 AND effect_id = $2 FOR UPDATE`,
        [input.businessId, parentEffectId]
      );
      if (parent.rows[0] === undefined) {
        throw new EffectLedgerError("effect_not_found", parentEffectId);
      }
      if (parent.rows[0].state !== "confirmed") {
        throw new EffectLedgerError("effect_state_conflict", parentEffectId);
      }
      const result = await this.reserveWithin(transaction, { ...input, parentEffectId });
      await transaction.query(
        `UPDATE effect_records SET state = 'compensating', updated_at = $3
          WHERE business_id = $1 AND effect_id = $2`,
        [input.businessId, parentEffectId, input.createdAt]
      );
      return result;
    });
  }

  private async reserveWithin(
    transaction: Queryable,
    input: ReserveEffectInput
  ): Promise<ReserveEffectResult> {
    await transaction.query(
      `INSERT INTO tool_intents (
           business_id, intent_id, run_id, state_id, idempotency_key, intent_digest,
           normalized_intent, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         ON CONFLICT (business_id, idempotency_key) DO NOTHING`,
      [
        input.businessId,
        input.intent.intentId,
        input.runId,
        input.stateId,
        input.idempotencyKey,
        input.intentDigest,
        JSON.stringify(input.intent),
        input.createdAt,
      ]
    );
    const intents = await transaction.query<{ intent_id: string; intent_digest: string }>(
      `SELECT intent_id, intent_digest FROM tool_intents
          WHERE business_id = $1 AND idempotency_key = $2 FOR UPDATE`,
      [input.businessId, input.idempotencyKey]
    );
    const reservedIntent = intents.rows[0];
    if (reservedIntent === undefined) {
      throw new EffectLedgerError("effect_not_found", input.idempotencyKey);
    }
    if (reservedIntent.intent_digest !== input.intentDigest) {
      throw new EffectLedgerError("idempotency_digest_mismatch", input.idempotencyKey);
    }

    const inserted = await transaction.query<{ effect_id: string }>(
      `INSERT INTO effect_records (
           business_id, effect_id, intent_id, run_id, state_id, logical_effect_ordinal,
           idempotency_key, intent_digest, guardrail_revision, approval_id, state,
           parent_effect_id, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'authorized', $11, $12, $12)
         ON CONFLICT (business_id, idempotency_key) DO NOTHING
         RETURNING effect_id`,
      [
        input.businessId,
        input.effectId,
        reservedIntent.intent_id,
        input.runId,
        input.stateId,
        input.logicalEffectOrdinal,
        input.idempotencyKey,
        input.intentDigest,
        input.guardrailRevision,
        input.approvalId ?? null,
        input.parentEffectId ?? null,
        input.createdAt,
      ]
    );
    const stored = await findByKey(transaction, input.businessId, input.idempotencyKey);
    if (stored === undefined) {
      throw new EffectLedgerError("effect_not_found", input.idempotencyKey);
    }
    if (stored.intentDigest !== input.intentDigest) {
      throw new EffectLedgerError("idempotency_digest_mismatch", input.idempotencyKey);
    }
    return { outcome: inserted.rows.length === 1 ? "created" : "duplicate", effect: stored };
  }

  get(businessId: string, effectId: string): Promise<EffectRecord | undefined> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<EffectRow>(
        `SELECT effects.*, intents.normalized_intent
           FROM effect_records effects
           JOIN tool_intents intents
             ON intents.business_id = effects.business_id AND intents.intent_id = effects.intent_id
          WHERE effects.business_id = $1 AND effects.effect_id = $2`,
        [businessId, effectId]
      );
      return result.rows[0] === undefined ? undefined : fromRow(result.rows[0]);
    });
  }

  list(businessId: string): Promise<EffectRecord[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<EffectRow>(
        `SELECT effects.*, intents.normalized_intent
           FROM effect_records effects
           JOIN tool_intents intents
             ON intents.business_id = effects.business_id AND intents.intent_id = effects.intent_id
          WHERE effects.business_id = $1 ORDER BY effects.created_at, effects.effect_id`,
        [businessId]
      );
      return result.rows.map(fromRow);
    });
  }

  transition(input: TransitionEffectInput): Promise<EffectRecord> {
    return this.transactions.withTransaction(async (transaction) => {
      const updated = await transaction.query(
        `UPDATE effect_records SET state = $3, updated_at = $4
          WHERE business_id = $1 AND effect_id = $2 AND state = ANY($5::text[])
          RETURNING effect_id`,
        [input.businessId, input.effectId, input.state, input.updatedAt, [...input.expectedStates]]
      );
      if (updated.rows.length !== 1) {
        const existing = await this.findById(transaction, input.businessId, input.effectId);
        throw new EffectLedgerError(
          existing === undefined ? "effect_not_found" : "effect_state_conflict",
          input.effectId
        );
      }
      const effect = await this.findById(transaction, input.businessId, input.effectId);
      if (effect === undefined) throw new EffectLedgerError("effect_not_found", input.effectId);
      return effect;
    });
  }

  beginAttempt(businessId: string, effectId: string, startedAt: string): Promise<EffectAttempt> {
    return this.transactions.withTransaction(async (transaction) => {
      const current = await transaction.query<{ state: EffectRecord["state"] }>(
        `SELECT state FROM effect_records
          WHERE business_id = $1 AND effect_id = $2 FOR UPDATE`,
        [businessId, effectId]
      );
      if (current.rows[0] === undefined) {
        throw new EffectLedgerError("effect_not_found", effectId);
      }
      if (current.rows[0].state !== "authorized") {
        throw new EffectLedgerError("effect_state_conflict", effectId);
      }
      const number = await transaction.query<{ attempt: number }>(
        `SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM effect_attempts
          WHERE business_id = $1 AND effect_id = $2`,
        [businessId, effectId]
      );
      const attemptNumber = Number(number.rows[0]?.attempt ?? 1);
      const inserted = await transaction.query<EffectAttemptRow>(
        `INSERT INTO effect_attempts (
           business_id, effect_id, attempt, state, started_at
         ) VALUES ($1, $2, $3, 'dispatched', $4)
         RETURNING *`,
        [businessId, effectId, attemptNumber, startedAt]
      );
      await transaction.query(
        `UPDATE effect_records SET state = 'dispatched', updated_at = $3
          WHERE business_id = $1 AND effect_id = $2`,
        [businessId, effectId, startedAt]
      );
      const attempt = inserted.rows[0];
      if (attempt === undefined) {
        throw new EffectLedgerError("attempt_not_found", String(attemptNumber));
      }
      return attemptFromRow(attempt);
    });
  }

  finishAttempt(input: FinishEffectAttemptInput): Promise<EffectRecord> {
    return this.transactions.withTransaction(async (transaction) => {
      const completed = await transaction.query(
        `UPDATE effect_attempts
            SET state = $4, provider_request_id = $5, output_digest = $6,
                error_code = $7, finished_at = $8
          WHERE business_id = $1 AND effect_id = $2 AND attempt = $3
            AND state = 'dispatched'
          RETURNING attempt`,
        [
          input.businessId,
          input.effectId,
          input.attempt,
          input.attemptState,
          input.providerRequestId ?? null,
          input.outputDigest ?? null,
          input.errorCode ?? null,
          input.finishedAt,
        ]
      );
      if (completed.rows.length !== 1) {
        throw new EffectLedgerError("attempt_not_found", String(input.attempt));
      }
      await transaction.query(
        `UPDATE effect_records SET state = $3, updated_at = $4
          WHERE business_id = $1 AND effect_id = $2`,
        [input.businessId, input.effectId, input.effectState, input.finishedAt]
      );
      const updated = await this.findById(transaction, input.businessId, input.effectId);
      if (updated === undefined) throw new EffectLedgerError("effect_not_found", input.effectId);
      return updated;
    });
  }

  listAttempts(businessId: string, effectId: string): Promise<EffectAttempt[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<EffectAttemptRow>(
        `SELECT * FROM effect_attempts
          WHERE business_id = $1 AND effect_id = $2 ORDER BY attempt`,
        [businessId, effectId]
      );
      return result.rows.map(attemptFromRow);
    });
  }

  private async findById(
    queryable: Queryable,
    businessId: string,
    effectId: string
  ): Promise<EffectRecord | undefined> {
    const result = await queryable.query<EffectRow>(
      `SELECT effects.*, intents.normalized_intent
         FROM effect_records effects
         JOIN tool_intents intents
           ON intents.business_id = effects.business_id AND intents.intent_id = effects.intent_id
        WHERE effects.business_id = $1 AND effects.effect_id = $2`,
      [businessId, effectId]
    );
    return result.rows[0] === undefined ? undefined : fromRow(result.rows[0]);
  }
}

export class EffectLedger {
  constructor(private readonly store: EffectStore) {}

  reserve(input: ReserveEffectInput): Promise<ReserveEffectResult> {
    return this.store.reserve(input);
  }
}
