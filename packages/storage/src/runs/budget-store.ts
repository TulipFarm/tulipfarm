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

const EXHAUSTION_POLICY_SQL = "'failure_path', 'attention_required'";

export const BUDGET_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS run_budgets (
    business_id           text NOT NULL,
    run_id                uuid NOT NULL,
    limit_key             text NOT NULL CHECK (length(limit_key) > 0),
    limit_value           bigint NOT NULL CHECK (limit_value >= 0),
    consumed              bigint NOT NULL DEFAULT 0 CHECK (consumed >= 0),
    exhaustion_policy     text NOT NULL CHECK (exhaustion_policy IN (${EXHAUSTION_POLICY_SQL})),
    opened_at             timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, run_id, limit_key),
    CHECK (consumed <= limit_value),
    FOREIGN KEY (business_id, run_id) REFERENCES runs(business_id, id)
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
];

interface BudgetRow {
  limit_key: string;
  limit_value: string | number;
  consumed: string | number;
  exhaustion_policy: BudgetExhaustionPolicy;
}

function persistedBudget(row: BudgetRow): PersistedBudget {
  return {
    key: row.limit_key,
    limit: Number(row.limit_value),
    consumed: Number(row.consumed),
    exhaustionPolicy: row.exhaustion_policy,
  };
}

/**
 * PostgreSQL ledger for per-Run budgets (SPEC §9.1). A ceiling is write-once — the trigger rejects
 * any later change — so neither a restart nor an Agent proposal can raise a limit, and the row
 * CHECK makes an overdrawn budget unrepresentable rather than merely unlikely.
 */
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
            AND consumed + $4 <= limit_value
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
