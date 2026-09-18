import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it, vi } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { addSlackDeliveryLeases } from "./20260917-slack-delivery-leases";

describe("20260917 Slack delivery lease migration", () => {
  it("repairs a database that applied Knowledge v132 before Slack v125 landed", async () => {
    const db = new PGlite();
    try {
      await db.exec(`CREATE TABLE schema_version (
        id boolean PRIMARY KEY DEFAULT true, version integer NOT NULL
      );
      INSERT INTO schema_version VALUES (true, 132);
      CREATE TABLE channel_run_deliveries (
        business_id text, run_id text, status text, updated_at timestamptz
      );
      INSERT INTO channel_run_deliveries VALUES
        ('business-1', 'run-1', 'delivering', '2026-09-17T12:00:00Z');`);
      const exit = vi.fn();
      await runPgMigrations(db, exit, () => {});
      expect(exit).not.toHaveBeenCalled();
      const columns = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'channel_run_deliveries'
           AND column_name IN ('lease_generation', 'lease_expires_at', 'next_attempt_at')
         ORDER BY column_name`
      );
      expect(columns.rows).toEqual([
        { column_name: "lease_expires_at" },
        { column_name: "lease_generation" },
        { column_name: "next_attempt_at" },
      ]);
      await db.exec(`UPDATE channel_run_deliveries
        SET lease_generation = 2, lease_expires_at = '2026-09-17T12:02:00Z'`);
      await runPgMigrations(db, exit, () => {});
      expect(exit).not.toHaveBeenCalled();
      expect(
        (
          await db.query(`SELECT lease_generation FROM channel_run_deliveries
            WHERE lease_expires_at = '2026-09-17T12:02:00Z'`)
        ).rows
      ).toEqual([{ lease_generation: 2 }]);
    } finally {
      await db.close();
    }
  });

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
