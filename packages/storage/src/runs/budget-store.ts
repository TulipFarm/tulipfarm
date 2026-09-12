import type { TransactionPort } from "../ports";

/** SPEC §9.1 exhaustion disposition: take the declared failure path or park for an operator. */
export type BudgetExhaustionPolicy = "failure_path" | "attention_required";

export type BudgetConsumeOutcome = "allowed" | "exhausted" | "unbounded";

export interface BudgetConsumeResult {
  readonly outcome: BudgetConsumeOutcome;
  readonly consumed: number;
  readonly limit: number | null;
  readonly exhaustionPolicy: BudgetExhaustionPolicy | null;
}

export interface OpenBudgetInput {
  readonly businessId: string;
  readonly runId: string;
  /** Resolved narrowest-wins ceilings keyed by limit key; an absent key stays unbounded. */
  readonly limits: Readonly<Record<string, number>>;
  readonly exhaustionPolicy: BudgetExhaustionPolicy;
}

export interface PersistedBudget {
  readonly key: string;
  readonly limit: number;
  readonly consumed: number;
  readonly exhaustionPolicy: BudgetExhaustionPolicy;
}

export type BudgetReservationResult =
  | { readonly outcome: "allowed" | "unbounded" | "duplicate" }
  | { readonly outcome: "exhausted"; readonly key: string };

const EXHAUSTION_POLICY_SQL = "'failure_path', 'attention_required'";

export const BUDGET_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS run_budgets (
    business_id           text NOT NULL,
    run_id                uuid NOT NULL,
    limit_key             text NOT NULL CHECK (length(limit_key) > 0),
    limit_value           bigint NOT NULL CHECK (limit_value >= 0),
    consumed              bigint NOT NULL DEFAULT 0 CHECK (consumed >= 0),
    reserved              bigint NOT NULL DEFAULT 0 CHECK (reserved >= 0),
    exhaustion_policy     text NOT NULL CHECK (exhaustion_policy IN (${EXHAUSTION_POLICY_SQL})),
    opened_at             timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, run_id, limit_key),
    CONSTRAINT run_budgets_balance_check CHECK (consumed + reserved <= limit_value),
    FOREIGN KEY (business_id, run_id) REFERENCES runs(business_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS run_budget_reservations (
    business_id       text NOT NULL,
    run_id            uuid NOT NULL,
    reservation_id    text NOT NULL CHECK (length(reservation_id) > 0),
    limit_key         text NOT NULL,
    reserved_amount   bigint NOT NULL CHECK (reserved_amount > 0),
    settled_amount    bigint CHECK (settled_amount >= 0),
    created_at        timestamptz NOT NULL DEFAULT now(),
    settled_at        timestamptz,
    PRIMARY KEY (business_id, run_id, reservation_id, limit_key),
    FOREIGN KEY (business_id, run_id, limit_key)
      REFERENCES run_budgets(business_id, run_id, limit_key) ON DELETE CASCADE
  )`,
  `CREATE OR REPLACE FUNCTION reject_run_budget_limit_change()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.limit_value IS DISTINCT FROM NEW.limit_value
        OR OLD.limit_key IS DISTINCT FROM NEW.limit_key
        OR OLD.exhaustion_policy IS DISTINCT FROM NEW.exhaustion_policy THEN
        RAISE EXCEPTION 'run_budget_limit_immutable';
      END IF;
      IF NEW.consumed < OLD.consumed THEN
        RAISE EXCEPTION 'run_budget_consumption_append_only';
      END IF;
      RETURN NEW;
    END;
    $$`,
  "DROP TRIGGER IF EXISTS run_budgets_limit_immutable ON run_budgets",
  `CREATE TRIGGER run_budgets_limit_immutable
    BEFORE UPDATE ON run_budgets
    FOR EACH ROW EXECUTE FUNCTION reject_run_budget_limit_change()`,
  `CREATE INDEX IF NOT EXISTS run_budgets_run_idx ON run_budgets (business_id, run_id)`,
  `CREATE INDEX IF NOT EXISTS run_budget_reservations_run_idx
    ON run_budget_reservations (business_id, run_id, reservation_id)`,
];

export const BUDGET_RESERVATION_STORAGE_STATEMENTS: readonly string[] = [
  "ALTER TABLE run_budgets ADD COLUMN IF NOT EXISTS reserved bigint NOT NULL DEFAULT 0 CHECK (reserved >= 0)",
  "ALTER TABLE run_budgets DROP CONSTRAINT IF EXISTS run_budgets_check",
  "ALTER TABLE run_budgets DROP CONSTRAINT IF EXISTS run_budgets_balance_check",
  `ALTER TABLE run_budgets
    ADD CONSTRAINT run_budgets_balance_check CHECK (consumed + reserved <= limit_value)`,
  `CREATE TABLE IF NOT EXISTS run_budget_reservations (
    business_id       text NOT NULL,
    run_id            uuid NOT NULL,
    reservation_id    text NOT NULL CHECK (length(reservation_id) > 0),
    limit_key         text NOT NULL,
    reserved_amount   bigint NOT NULL CHECK (reserved_amount > 0),
    settled_amount    bigint CHECK (settled_amount >= 0),
    created_at        timestamptz NOT NULL DEFAULT now(),
    settled_at        timestamptz,
    PRIMARY KEY (business_id, run_id, reservation_id, limit_key),
    FOREIGN KEY (business_id, run_id, limit_key)
      REFERENCES run_budgets(business_id, run_id, limit_key) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS run_budget_reservations_run_idx
    ON run_budget_reservations (business_id, run_id, reservation_id)`,
];

interface BudgetRow {
  limit_key: string;
  limit_value: string | number;
  consumed: string | number;
  exhaustion_policy: BudgetExhaustionPolicy;
}

interface ReservationRow {
  limit_key: string;
  reserved_amount: string | number;
  settled_amount: string | number | null;
}

function persistedBudget(row: BudgetRow): PersistedBudget {
  return {
    key: row.limit_key,
    limit: Number(row.limit_value),
    consumed: Number(row.consumed),
    exhaustionPolicy: row.exhaustion_policy,
  };
}

/** Run budget ceilings are write-once; overdraw is made unrepresentable by storage checks. */
export class BudgetStore {
  constructor(private readonly transactions: TransactionPort) {}

  /** Opens the bounded budgets for a Run. Re-opening keeps the ceilings already committed. */
  async open(input: OpenBudgetInput): Promise<void> {
    const entries = Object.entries(input.limits);
    if (entries.length === 0) return;
    await this.transactions.withTransaction(async (transaction) => {
      for (const [key, limit] of entries) {
        await transaction.query(
          `INSERT INTO run_budgets (business_id, run_id, limit_key, limit_value, exhaustion_policy)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (business_id, run_id, limit_key) DO NOTHING`,
          [input.businessId, input.runId, key, limit, input.exhaustionPolicy]
        );
      }
    });
  }

  /**
   * Charges a budget in one conditional update: the row moves only when the charge fits, so a
   * concurrent worker can never push consumption past the ceiling.
   */
  async consume(
    businessId: string,
    runId: string,
    key: string,
    amount: number
  ): Promise<BudgetConsumeResult> {
    return this.transactions.withTransaction(async (transaction) => {
      const charged = await transaction.query<BudgetRow>(
        `UPDATE run_budgets
            SET consumed = consumed + $4
          WHERE business_id = $1
            AND run_id = $2
            AND limit_key = $3
            AND consumed + reserved + $4 <= limit_value
          RETURNING limit_key, limit_value, consumed, exhaustion_policy`,
        [businessId, runId, key, amount]
      );
      const chargedRow = charged.rows[0];
      if (chargedRow) {
        const budget = persistedBudget(chargedRow);
        return {
          outcome: "allowed",
          consumed: budget.consumed,
          limit: budget.limit,
          exhaustionPolicy: budget.exhaustionPolicy,
        };
      }

      const existing = await transaction.query<BudgetRow>(
        `SELECT limit_key, limit_value, consumed, exhaustion_policy
           FROM run_budgets
          WHERE business_id = $1 AND run_id = $2 AND limit_key = $3`,
        [businessId, runId, key]
      );
      const row = existing.rows[0];
      if (!row) {
        return { outcome: "unbounded", consumed: 0, limit: null, exhaustionPolicy: null };
      }
      const budget = persistedBudget(row);
      return {
        outcome: "exhausted",
        consumed: budget.consumed,
        limit: budget.limit,
        exhaustionPolicy: budget.exhaustionPolicy,
      };
    });
  }

  async reserve(
    businessId: string,
    runId: string,
    reservationId: string,
    amounts: Readonly<Record<string, number>>
  ): Promise<BudgetReservationResult> {
    const entries = positiveAmounts(amounts);
    if (entries.length === 0) return { outcome: "unbounded" };
    return this.transactions.withTransaction(async (transaction) => {
      const existing = await transaction.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM run_budget_reservations
            WHERE business_id = $1 AND run_id = $2 AND reservation_id = $3
         ) AS present`,
        [businessId, runId, reservationId]
      );
      if (existing.rows[0]?.present) return { outcome: "duplicate" };

      const bounded: Array<[string, number]> = [];
      for (const [key, amount] of entries) {
        const locked = await transaction.query<BudgetRow & { reserved: string | number }>(
          `SELECT limit_key, limit_value, consumed, reserved, exhaustion_policy
             FROM run_budgets
            WHERE business_id = $1 AND run_id = $2 AND limit_key = $3
            FOR UPDATE`,
          [businessId, runId, key]
        );
        const row = locked.rows[0];
        if (row === undefined) continue;
        if (Number(row.consumed) + Number(row.reserved) + amount > Number(row.limit_value)) {
          return { outcome: "exhausted", key };
        }
        bounded.push([key, amount]);
      }
      if (bounded.length === 0) return { outcome: "unbounded" };
      const duplicate = await transaction.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM run_budget_reservations
            WHERE business_id = $1 AND run_id = $2 AND reservation_id = $3
         ) AS present`,
        [businessId, runId, reservationId]
      );
      if (duplicate.rows[0]?.present) return { outcome: "duplicate" };

      for (const [key, amount] of bounded) {
        await transaction.query(
          `INSERT INTO run_budget_reservations (
             business_id, run_id, reservation_id, limit_key, reserved_amount
           ) VALUES ($1, $2, $3, $4, $5)`,
          [businessId, runId, reservationId, key, amount]
        );
        await transaction.query(
          `UPDATE run_budgets
              SET reserved = reserved + $4
            WHERE business_id = $1 AND run_id = $2 AND limit_key = $3`,
          [businessId, runId, key, amount]
        );
      }
      return { outcome: "allowed" };
    });
  }

  async settle(
    businessId: string,
    runId: string,
    reservationId: string,
    amounts: Readonly<Record<string, number>>,
    consumeReservation = false
  ): Promise<
    { readonly outcome: "allowed" } | { readonly outcome: "exhausted"; readonly key: string }
  > {
    const actual = new Map(positiveAmounts(amounts));
    return this.transactions.withTransaction(async (transaction) => {
      const reservations = await transaction.query<ReservationRow>(
        `SELECT limit_key, reserved_amount, settled_amount
           FROM run_budget_reservations
          WHERE business_id = $1 AND run_id = $2 AND reservation_id = $3
          ORDER BY limit_key
          FOR UPDATE`,
        [businessId, runId, reservationId]
      );
      let exhaustedKey: string | undefined;
      for (const reservation of reservations.rows) {
        if (reservation.settled_amount !== null) continue;
        const reserved = Number(reservation.reserved_amount);
        const amount = actual.get(reservation.limit_key) ?? (consumeReservation ? reserved : 0);
        const updated = await transaction.query(
          `UPDATE run_budgets
              SET reserved = reserved - $4,
                  consumed = consumed + $5
            WHERE business_id = $1
              AND run_id = $2
              AND limit_key = $3
              AND consumed + reserved - $4 + $5 <= limit_value
          RETURNING limit_key`,
          [businessId, runId, reservation.limit_key, reserved, amount]
        );
        if (updated.rows.length === 0) {
          exhaustedKey ??= reservation.limit_key;
          await transaction.query(
            `UPDATE run_budgets
                SET reserved = reserved - $4,
                    consumed = limit_value
              WHERE business_id = $1 AND run_id = $2 AND limit_key = $3`,
            [businessId, runId, reservation.limit_key, reserved]
          );
        }
        await transaction.query(
          `UPDATE run_budget_reservations
              SET settled_amount = $4, settled_at = now()
            WHERE business_id = $1
              AND run_id = $2
              AND reservation_id = $3
              AND limit_key = $5`,
          [businessId, runId, reservationId, amount, reservation.limit_key]
        );
      }
      return exhaustedKey === undefined
        ? { outcome: "allowed" }
        : { outcome: "exhausted", key: exhaustedKey };
    });
  }

  async usage(businessId: string, runId: string): Promise<readonly PersistedBudget[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<BudgetRow>(
        `SELECT limit_key, limit_value, consumed, exhaustion_policy
           FROM run_budgets
          WHERE business_id = $1 AND run_id = $2
          ORDER BY limit_key`,
        [businessId, runId]
      );
      return result.rows.map(persistedBudget);
    });
  }
}

function positiveAmounts(amounts: Readonly<Record<string, number>>): Array<[string, number]> {
  return Object.entries(amounts)
    .filter(([, amount]) => {
      if (!Number.isSafeInteger(amount) || amount < 0) {
        throw new Error("invalid_budget_reservation");
      }
      return amount > 0;
    })
    .sort(([left], [right]) => left.localeCompare(right));
}
