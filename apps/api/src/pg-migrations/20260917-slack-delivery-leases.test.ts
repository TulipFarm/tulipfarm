import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { addSlackDeliveryLeases } from "./20260917-slack-delivery-leases";

describe("20260917 Slack delivery lease migration", () => {
  it("recovers legacy delivering rows and is safe to replay without resetting a live lease", async () => {
    const db = new PGlite();
    try {
      await db.exec(`CREATE TABLE channel_run_deliveries (
        business_id text, run_id text, status text, updated_at timestamptz
      );
      INSERT INTO channel_run_deliveries VALUES
        ('business-1', 'run-1', 'delivering', '2026-09-17T12:00:00Z'),
        ('business-1', 'run-2', 'done', '2026-09-17T12:00:00Z');`);
      await addSlackDeliveryLeases(db);
      expect(
        (
          await db.query(`SELECT run_id FROM channel_run_deliveries
        WHERE status = 'delivering' AND lease_expires_at <= '2026-09-17T12:01:00Z'`)
        ).rows
      ).toEqual([{ run_id: "run-1" }]);
      await db.exec(`UPDATE channel_run_deliveries
        SET lease_generation = 1, lease_expires_at = '2026-09-17T12:02:00Z'
        WHERE run_id = 'run-1'`);
      await addSlackDeliveryLeases(db);
      expect(
        (
          await db.query(`SELECT lease_generation FROM channel_run_deliveries
        WHERE run_id = 'run-1' AND lease_expires_at = '2026-09-17T12:02:00Z'`)
        ).rows
      ).toEqual([{ lease_generation: 1 }]);
    } finally {
      await db.close();
    }
  });
});
