import type { TransactionPort } from "../ports";

interface OimRateLimitBaseScope {
  readonly businessId: string;
  readonly integrationId: string;
  readonly integrationMajorVersion: number;
}

export type OimRateLimitStoreScope =
  | (OimRateLimitBaseScope & {
      readonly connectionId: string;
      readonly scope: "connection";
    })
  | (OimRateLimitBaseScope & {
      readonly connectionId?: string;
      readonly scope: "operation";
      readonly operationId: string;
    });

export interface OimRateLimitQuota {
  readonly requests: number;
  readonly perSeconds: number;
}

export type OimRateLimitAdmission =
  | { readonly outcome: "admitted" }
  | { readonly outcome: "limited"; readonly retryAt: string };

export interface AdmitOimRateLimitInput {
  readonly scope: OimRateLimitStoreScope;
  readonly quota?: OimRateLimitQuota;
  readonly now?: Date;
}

export interface ImposeOimRateLimitCooldownInput {
  readonly scope: OimRateLimitStoreScope;
  readonly retryAt: Date;
  readonly now?: Date;
}

export const OIM_RATE_LIMIT_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS oim_rate_limits (
    business_id                text NOT NULL,
    integration_id             text NOT NULL,
    integration_major_version  integer NOT NULL CHECK (integration_major_version >= 0),
    connection_id              text NOT NULL,
    scope                      text NOT NULL CHECK (scope IN ('connection', 'operation')),
    operation_id               text NOT NULL,
    window_started_at          timestamptz NOT NULL,
    admitted_requests          bigint NOT NULL DEFAULT 0 CHECK (admitted_requests >= 0),
    cooldown_until             timestamptz,
    updated_at                 timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (
      business_id,
      integration_id,
      integration_major_version,
      connection_id,
      scope,
      operation_id
    ),
    CHECK (
      (scope = 'connection' AND length(connection_id) > 0 AND operation_id = '')
      OR (scope = 'operation' AND length(operation_id) > 0)
    )
  )`,
];

interface RateLimitRow {
  window_started_at: Date | string;
  admitted_requests: number | string;
  cooldown_until: Date | string | null;
}

function timestamp(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function operationId(scope: OimRateLimitStoreScope): string {
  return scope.scope === "operation" ? scope.operationId : "";
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`invalid_oim_rate_limit_${field}`);
  }
}

function params(scope: OimRateLimitStoreScope): readonly unknown[] {
  return [
    scope.businessId,
    scope.integrationId,
    scope.integrationMajorVersion,
    scope.connectionId ?? "",
    scope.scope,
    operationId(scope),
  ];
}

/** Atomic fixed-window admission and provider cooldowns shared by every API replica. */
export class OimRateLimitStore {
  constructor(private readonly transactions: TransactionPort) {}

  async admit(input: AdmitOimRateLimitInput): Promise<OimRateLimitAdmission> {
    if (input.quota !== undefined) {
      assertPositiveInteger(input.quota.requests, "requests");
      assertPositiveInteger(input.quota.perSeconds, "per_seconds");
    }
    const now = input.now ?? new Date();
    const key = params(input.scope);

    return this.transactions.withTransaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO oim_rate_limits (
           business_id, integration_id, integration_major_version, connection_id,
           scope, operation_id, window_started_at, admitted_requests
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0)
         ON CONFLICT (
           business_id, integration_id, integration_major_version, connection_id,
           scope, operation_id
         ) DO NOTHING`,
        [...key, now]
      );

      if (input.quota === undefined) {
        const current = await transaction.query<RateLimitRow>(
          `SELECT window_started_at, admitted_requests, cooldown_until
             FROM oim_rate_limits
            WHERE business_id = $1
              AND integration_id = $2
              AND integration_major_version = $3
              AND connection_id = $4
              AND scope = $5
              AND operation_id = $6
            FOR UPDATE`,
          key
        );
        const row = current.rows[0];
        if (row === undefined) throw new Error("oim_rate_limit_state_missing");
        const cooldownRetryAt =
          row.cooldown_until === null ? undefined : new Date(timestamp(row.cooldown_until));
        if (cooldownRetryAt !== undefined && cooldownRetryAt > now) {
          return { outcome: "limited", retryAt: cooldownRetryAt.toISOString() };
        }
        if (cooldownRetryAt !== undefined) {
          await transaction.query(
            `UPDATE oim_rate_limits
                SET cooldown_until = NULL,
                    updated_at = $7
              WHERE business_id = $1
                AND integration_id = $2
                AND integration_major_version = $3
                AND connection_id = $4
                AND scope = $5
                AND operation_id = $6`,
            [...key, now]
          );
        }
        return { outcome: "admitted" };
      }

      const admitted = await transaction.query(
        `UPDATE oim_rate_limits
            SET window_started_at = CASE
                  WHEN window_started_at + make_interval(secs => $9) <= $7
                    THEN $7
                  ELSE window_started_at
                END,
                admitted_requests = CASE
                  WHEN window_started_at + make_interval(secs => $9) <= $7
                    THEN 1
                  ELSE admitted_requests + 1
                END,
                cooldown_until = CASE
                  WHEN cooldown_until <= $7 THEN NULL
                  ELSE cooldown_until
                END,
                updated_at = $7
          WHERE business_id = $1
            AND integration_id = $2
            AND integration_major_version = $3
            AND connection_id = $4
            AND scope = $5
            AND operation_id = $6
            AND (cooldown_until IS NULL OR cooldown_until <= $7)
            AND (
              window_started_at + make_interval(secs => $9) <= $7
              OR admitted_requests < $8
            )
          RETURNING operation_id`,
        [...key, now, input.quota.requests, input.quota.perSeconds]
      );
      if (admitted.rows.length === 1) return { outcome: "admitted" };

      const current = await transaction.query<RateLimitRow>(
        `SELECT window_started_at, admitted_requests, cooldown_until
           FROM oim_rate_limits
          WHERE business_id = $1
            AND integration_id = $2
            AND integration_major_version = $3
            AND connection_id = $4
            AND scope = $5
            AND operation_id = $6
          FOR UPDATE`,
        key
      );
      const row = current.rows[0];
      if (row === undefined) throw new Error("oim_rate_limit_state_missing");
      const cooldownRetryAt =
        row.cooldown_until === null ? undefined : new Date(timestamp(row.cooldown_until));
      if (cooldownRetryAt !== undefined && cooldownRetryAt > now) {
        return { outcome: "limited", retryAt: cooldownRetryAt.toISOString() };
      }
      if (Number(row.admitted_requests) < input.quota.requests) {
        throw new Error("oim_rate_limit_admission_conflict");
      }
      const windowRetryAt = new Date(
        new Date(timestamp(row.window_started_at)).getTime() + input.quota.perSeconds * 1000
      );
      return { outcome: "limited", retryAt: windowRetryAt.toISOString() };
    });
  }

  async imposeCooldown(input: ImposeOimRateLimitCooldownInput): Promise<void> {
    const now = input.now ?? new Date();
    if (!Number.isFinite(input.retryAt.getTime()) || input.retryAt <= now) {
      throw new Error("invalid_oim_rate_limit_retry_at");
    }
    const key = params(input.scope);
    await this.transactions.withTransaction((transaction) =>
      transaction.query(
        `INSERT INTO oim_rate_limits (
           business_id, integration_id, integration_major_version, connection_id,
           scope, operation_id, window_started_at, admitted_requests, cooldown_until, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $7)
         ON CONFLICT (
           business_id, integration_id, integration_major_version, connection_id,
           scope, operation_id
         ) DO UPDATE SET
           cooldown_until = GREATEST(oim_rate_limits.cooldown_until, EXCLUDED.cooldown_until),
           updated_at = EXCLUDED.updated_at`,
        [...key, now, input.retryAt]
      )
    );
  }
}
