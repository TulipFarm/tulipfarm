import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it, vi } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makeMigratedPglite } from "../test/pglite";
import { addSlackDeliveryLeases } from "./20260917-slack-delivery-leases";

describe("20260917 Slack delivery lease migration", () => {
  it("repairs a database that applied Knowledge v132 before Slack v125 landed", async () => {
    const db = await makeMigratedPglite(132);
    try {
      // The alternate branch reached Knowledge v132 without ever applying Slack v125.
      await db.exec(`
        DROP INDEX channel_run_deliveries_recovery_idx;
        ALTER TABLE channel_run_deliveries
          DROP COLUMN lease_generation,
          DROP COLUMN lease_expires_at,
          DROP COLUMN next_attempt_at;
        INSERT INTO channel_run_deliveries (
          business_id, run_id, integration_id, route_id, provider, destination,
          agent_id, principal_id, idempotency_key, status, created_at, updated_at
        ) VALUES (
          'business-1', 'run-1', 'slack-1', 'route-1', 'slack', 'channel-1',
          'agent-1', 'principal-1', 'delivery-1', 'delivering',
          '2026-09-17T12:00:00Z', '2026-09-17T12:00:00Z'
        );
      `);
      const leaseColumns = `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'channel_run_deliveries'
          AND column_name IN ('lease_generation', 'lease_expires_at', 'next_attempt_at')
        ORDER BY column_name`;
      const recoveryIndex =
        "SELECT to_regclass('channel_run_deliveries_recovery_idx') IS NOT NULL AS present";
      expect((await db.query("SELECT version FROM schema_version")).rows).toEqual([
        { version: 132 },
      ]);
      expect((await db.query(leaseColumns)).rows).toEqual([]);
      expect((await db.query(recoveryIndex)).rows).toEqual([{ present: false }]);
      const exit = vi.fn();
      await runPgMigrations(db, exit, () => {});
      expect(exit).not.toHaveBeenCalled();
      const columns = await db.query<{ column_name: string }>(leaseColumns);
      expect(columns.rows).toEqual([
        { column_name: "lease_expires_at" },
        { column_name: "lease_generation" },
        { column_name: "next_attempt_at" },
      ]);
      expect((await db.query(recoveryIndex)).rows).toEqual([{ present: true }]);
      expect(
        (
          await db.query(`SELECT lease_generation, lease_expires_at = updated_at AS recovered,
            next_attempt_at FROM channel_run_deliveries
            WHERE business_id = 'business-1' AND run_id = 'run-1'`)
        ).rows
      ).toEqual([{ lease_generation: 0, recovered: true, next_attempt_at: null }]);
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
