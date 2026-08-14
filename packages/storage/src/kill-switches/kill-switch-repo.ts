import type { KillSwitch, KillSwitchScopeKind, KillSwitchStore } from "@tulipfarm/observability";
import type { TransactionPort } from "../ports";

/** Every scope kind storage accepts, mirroring `KillSwitchScopeKind` for the SQL `CHECK`. */
export const KILL_SWITCH_SCOPE_KINDS: readonly KillSwitchScopeKind[] = [
  "agent",
  "routine",
  "tool",
  "provider",
  "integration",
  "destination",
  "model",
  "data_class",
  "all_mutations",
];

export interface EnableKillSwitchInput {
  readonly businessId: string;
  readonly id: string;
  readonly scope: { readonly kind: KillSwitchScopeKind; readonly value?: string };
  readonly reasonCode: string;
  readonly enabledBy: string;
}

/** A stored switch: an enabled one plus the two fields only a disabled one carries. */
export interface KillSwitchRecord extends KillSwitch {
  readonly disabledAt?: string;
  readonly disabledBy?: string;
}

export type KillSwitchStoreErrorCode = "not_found" | "already_disabled" | "invalid_scope";

export class KillSwitchStoreError extends Error {
  constructor(
    readonly code: KillSwitchStoreErrorCode,
    message: string
  ) {
    super(message);
    this.name = "KillSwitchStoreError";
  }
}

const SCOPE_KINDS_SQL = KILL_SWITCH_SCOPE_KINDS.map((kind) => `'${kind}'`).join(", ");

const COLUMNS = `id, business_id, scope_kind, scope_value, reason_code,
  enabled_at, enabled_by, disabled_at, disabled_by`;

export const KILL_SWITCH_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS kill_switches (
    business_id   text NOT NULL,
    id            text NOT NULL CHECK (length(id) > 0),
    scope_kind    text NOT NULL CHECK (scope_kind IN (${SCOPE_KINDS_SQL})),
    scope_value   text CHECK (scope_value IS NULL OR length(scope_value) > 0),
    reason_code   text NOT NULL CHECK (length(reason_code) > 0),
    enabled_at    timestamptz NOT NULL DEFAULT now(),
    enabled_by    text NOT NULL CHECK (length(enabled_by) > 0),
    disabled_at   timestamptz,
    disabled_by   text,
    PRIMARY KEY (business_id, id),
    CHECK ((scope_kind = 'all_mutations') = (scope_value IS NULL)),
    CHECK ((disabled_at IS NULL) = (disabled_by IS NULL))
  )`,
  // COALESCE because a plain unique index treats two NULL scope_values as distinct, which would
  // let `all_mutations` be enabled many times over and leave `disable` no single row to clear.
  `CREATE UNIQUE INDEX IF NOT EXISTS kill_switches_live_scope_idx
    ON kill_switches (business_id, scope_kind, COALESCE(scope_value, ''))
    WHERE disabled_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS kill_switches_enabled_idx
    ON kill_switches (business_id) WHERE disabled_at IS NULL`,
  `CREATE OR REPLACE FUNCTION reject_kill_switch_rewrite()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.scope_kind IS DISTINCT FROM NEW.scope_kind
        OR OLD.scope_value IS DISTINCT FROM NEW.scope_value
        OR OLD.reason_code IS DISTINCT FROM NEW.reason_code
        OR OLD.enabled_at IS DISTINCT FROM NEW.enabled_at
        OR OLD.enabled_by IS DISTINCT FROM NEW.enabled_by THEN
        RAISE EXCEPTION 'kill_switch_immutable';
      END IF;
      IF OLD.disabled_at IS NOT NULL AND NEW.disabled_at IS NULL THEN
        RAISE EXCEPTION 'kill_switch_reenable_forbidden';
      END IF;
      RETURN NEW;
    END;
    $$`,
  "DROP TRIGGER IF EXISTS kill_switches_immutable ON kill_switches",
  `CREATE TRIGGER kill_switches_immutable
    BEFORE UPDATE ON kill_switches
    FOR EACH ROW EXECUTE FUNCTION reject_kill_switch_rewrite()`,
];

interface KillSwitchRow {
  id: string;
  business_id: string;
  scope_kind: KillSwitchScopeKind;
  scope_value: string | null;
  reason_code: string;
  enabled_at: Date | string;
  enabled_by: string;
  disabled_at: Date | string | null;
  disabled_by: string | null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function killSwitchRecord(row: KillSwitchRow): KillSwitchRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    scope:
      row.scope_value === null
        ? { kind: row.scope_kind }
        : { kind: row.scope_kind, value: row.scope_value },
    reasonCode: row.reason_code,
    enabledAt: iso(row.enabled_at),
    enabledBy: row.enabled_by,
    ...(row.disabled_at === null ? {} : { disabledAt: iso(row.disabled_at) }),
    ...(row.disabled_by === null ? {} : { disabledBy: row.disabled_by }),
  };
}

/**
 * Durable emergency stops. Rows are never deleted: whether a switch was live at a given instant is
 * exactly what an incident review has to answer, so disabling only stamps `disabled_at`.
 */
export class KillSwitchRepo implements KillSwitchStore {
  constructor(private readonly transactions: TransactionPort) {}

  /**
   * The live switches guarding one business. Read on every mutating effect and deliberately not
   * cached — a stop an operator has already flipped must not be one TTL away from taking effect.
   */
  async listEnabled(businessId: string): Promise<readonly KillSwitch[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<KillSwitchRow>(
        `SELECT ${COLUMNS} FROM kill_switches
          WHERE business_id = $1 AND disabled_at IS NULL
          ORDER BY enabled_at DESC, id`,
        [businessId]
      );
      return result.rows.map(killSwitchRecord);
    });
  }

  /** Every switch ever flipped, newest first — the incident-review history. */
  async list(businessId: string): Promise<readonly KillSwitchRecord[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<KillSwitchRow>(
        `SELECT ${COLUMNS} FROM kill_switches
          WHERE business_id = $1
          ORDER BY enabled_at DESC, id`,
        [businessId]
      );
      return result.rows.map(killSwitchRecord);
    });
  }

  /** Idempotent: re-flipping a scope already live returns the switch that already holds it. */
  async enable(input: EnableKillSwitchInput): Promise<KillSwitchRecord> {
    const hasValue = input.scope.value !== undefined && input.scope.value.length > 0;
    if ((input.scope.kind === "all_mutations") === hasValue) {
      throw new KillSwitchStoreError(
        "invalid_scope",
        input.scope.kind === "all_mutations"
          ? "all_mutations takes no scope value"
          : `${input.scope.kind} requires a scope value`
      );
    }
    const value = hasValue ? input.scope.value : null;
    return this.transactions.withTransaction(async (transaction) => {
      const inserted = await transaction.query<KillSwitchRow>(
        `INSERT INTO kill_switches
           (business_id, id, scope_kind, scope_value, reason_code, enabled_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (business_id, scope_kind, COALESCE(scope_value, ''))
           WHERE disabled_at IS NULL DO NOTHING
         RETURNING ${COLUMNS}`,
        [input.businessId, input.id, input.scope.kind, value, input.reasonCode, input.enabledBy]
      );
      const insertedRow = inserted.rows[0];
      if (insertedRow) return killSwitchRecord(insertedRow);

      const existing = await transaction.query<KillSwitchRow>(
        `SELECT ${COLUMNS} FROM kill_switches
          WHERE business_id = $1
            AND scope_kind = $2
            AND COALESCE(scope_value, '') = COALESCE($3, '')
            AND disabled_at IS NULL`,
        [input.businessId, input.scope.kind, value]
      );
      const existingRow = existing.rows[0];
      if (!existingRow) {
        throw new KillSwitchStoreError("not_found", "kill switch vanished between insert and read");
      }
      return killSwitchRecord(existingRow);
    });
  }

  async disable(businessId: string, id: string, disabledBy: string): Promise<KillSwitchRecord> {
    return this.transactions.withTransaction(async (transaction) => {
      const updated = await transaction.query<KillSwitchRow>(
        `UPDATE kill_switches
            SET disabled_at = now(), disabled_by = $3
          WHERE business_id = $1 AND id = $2 AND disabled_at IS NULL
          RETURNING ${COLUMNS}`,
        [businessId, id, disabledBy]
      );
      const row = updated.rows[0];
      if (row) return killSwitchRecord(row);

      const existing = await transaction.query<{ id: string }>(
        "SELECT id FROM kill_switches WHERE business_id = $1 AND id = $2",
        [businessId, id]
      );
      throw existing.rows[0]
        ? new KillSwitchStoreError("already_disabled", `kill switch ${id} is already disabled`)
        : new KillSwitchStoreError("not_found", `kill switch ${id} does not exist`);
    });
  }
}
