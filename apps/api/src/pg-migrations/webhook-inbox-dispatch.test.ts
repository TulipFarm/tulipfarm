import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WEBHOOK_INBOX_DISPATCH_MIGRATION_STATEMENTS } from "./webhook-inbox-dispatch";

describe("webhook inbox dispatch migration", () => {
  let database: PGlite;

  beforeAll(async () => {
    database = new PGlite();
    await database.exec(`
      CREATE TABLE webhook_deliveries (
        business_id text NOT NULL,
        id text NOT NULL,
        state text NOT NULL CHECK (state IN ('accepted', 'normalized', 'dead_letter')),
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (business_id, id)
      );
      CREATE INDEX webhook_deliveries_claim_idx
        ON webhook_deliveries (state, next_attempt_at)
        WHERE state = 'accepted';
      INSERT INTO webhook_deliveries (business_id, id, state)
        VALUES ('business-1', 'delivery-1', 'normalized');
    `);
    for (const statement of WEBHOOK_INBOX_DISPATCH_MIGRATION_STATEMENTS) {
      await database.exec(statement);
    }
  });

  afterAll(async () => {
    await database.close();
  });

  it("allows a normalized delivery to finish dispatch", async () => {
    await database.query(
      "UPDATE webhook_deliveries SET state = 'dispatched' WHERE business_id = $1 AND id = $2",
      ["business-1", "delivery-1"]
    );

    const { rows } = await database.query<{ state: string }>(
      "SELECT state FROM webhook_deliveries WHERE business_id = $1 AND id = $2",
      ["business-1", "delivery-1"]
    );
    expect(rows[0]?.state).toBe("dispatched");
  });

  it("makes normalized rows eligible for the durable claim index", async () => {
    const { rows } = await database.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'webhook_deliveries_claim_idx'"
    );

    expect(rows[0]?.indexdef).toContain("state = ANY");
    expect(rows[0]?.indexdef).toContain("'normalized'");
  });
});
