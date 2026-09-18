import type { ProductTelemetryState, ProductTelemetryStateStore } from "@tulipfarm/observability";
import type { Queryable, TransactionPort } from "../ports";

export const PRODUCT_TELEMETRY_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS deployment_product_telemetry (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object')
  )`,
];

export class ProductTelemetryStore implements ProductTelemetryStateStore {
  constructor(
    private readonly queryable: Queryable,
    private readonly transactions: TransactionPort
  ) {}

  async initialize(initial: ProductTelemetryState): Promise<void> {
    await this.queryable.query(
      `INSERT INTO deployment_product_telemetry (singleton, state) VALUES (true, $1::jsonb) ON CONFLICT (singleton) DO NOTHING`,
      [JSON.stringify(initial)]
    );
  }

  async locked<T>(fn: (state: ProductTelemetryState) => Promise<T>): Promise<T> {
    return this.transactions.withTransaction(async (tx) => {
      const result = await tx.query<{ state: ProductTelemetryState }>(
        `SELECT state FROM deployment_product_telemetry WHERE singleton = true FOR UPDATE`
      );
      const state = result.rows[0]?.state;
      if (!state) throw new Error("Product telemetry state unavailable");
      const before = JSON.stringify(state);
      const value = await fn(state);
      const after = JSON.stringify(state);
      if (after !== before)
        await tx.query(
          `UPDATE deployment_product_telemetry SET state = $1::jsonb WHERE singleton = true`,
          [after]
        );
      return value;
    });
  }
}
