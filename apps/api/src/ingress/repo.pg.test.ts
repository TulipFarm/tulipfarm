import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";
import { IngressDeliveriesRepo, IntegrationConversationsRepo, IntegrationEventsRepo } from "./repo";

describe("ingress repos (PGlite)", () => {
  let db: PGlite;
  let userId: string;
  let conversationId: string;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    userId = randomUUID();
    conversationId = randomUUID();
    await db.query(
      "INSERT INTO users (id, email, password_hash, role, created_at) VALUES ($1, $2, 'x', 'admin', now())",
      [userId, `${userId}@example.com`]
    );
    await db.query(
      "INSERT INTO conversations (id, user_id, created_at, updated_at) VALUES ($1, $2, now(), now())",
      [conversationId, userId]
    );
  });

  afterEach(async () => {
    await db.close();
  });

  describe("IntegrationConversationsRepo", () => {
    it("inserts and finds a mapping by slug + external key", async () => {
      const repo = new IntegrationConversationsRepo(db);
      await repo.insert({
        integrationSlug: "slack",
        externalKey: "T1/C1/171234.5678",
        conversationId,
        userId,
      });
      const found = await repo.find("slack", "T1/C1/171234.5678");
      expect(found?.conversationId).toBe(conversationId);
      expect(found?.userId).toBe(userId);
      expect(await repo.exists("slack", "T1/C1/171234.5678")).toBe(true);
      expect(await repo.exists("slack", "T1/C1/other")).toBe(false);
      expect(await repo.find("github", "T1/C1/171234.5678")).toBeNull();
    });

    it("keeps the first mapping on duplicate insert (ON CONFLICT DO NOTHING)", async () => {
      const repo = new IntegrationConversationsRepo(db);
      const otherConvo = randomUUID();
      await db.query(
        "INSERT INTO conversations (id, user_id, created_at, updated_at) VALUES ($1, $2, now(), now())",
        [otherConvo, userId]
      );
      await repo.insert({ integrationSlug: "slack", externalKey: "k", conversationId, userId });
      await repo.insert({
        integrationSlug: "slack",
        externalKey: "k",
        conversationId: otherConvo,
        userId,
      });
      const found = await repo.find("slack", "k");
      expect(found?.conversationId).toBe(conversationId);
    });
  });

  describe("IntegrationEventsRepo", () => {
    it("persists an event row with payload round-trip", async () => {
      const repo = new IntegrationEventsRepo(db);
      const event = await repo.insert({
        integrationSlug: "slack",
        protocol: "slack",
        eventType: "member_joined_channel",
        externalId: "Ev123",
        payload: { channel: "C1", user: "U1" },
      });
      const r = await db.query("SELECT * FROM integration_events WHERE id = $1", [event.id]);
      const row = r.rows[0] as {
        event_type: string;
        external_id: string;
        payload: { channel: string };
      };
      expect(row.event_type).toBe("member_joined_channel");
      expect(row.external_id).toBe("Ev123");
      expect(row.payload.channel).toBe("C1");
    });

    it("allows a missing external id", async () => {
      const repo = new IntegrationEventsRepo(db);
      const event = await repo.insert({
        integrationSlug: "slack",
        protocol: "slack",
        eventType: "reaction_added",
        payload: {},
      });
      const r = await db.query("SELECT external_id FROM integration_events WHERE id = $1", [
        event.id,
      ]);
      expect((r.rows[0] as { external_id: string | null }).external_id).toBeNull();
    });
  });

  describe("IngressDeliveriesRepo", () => {
    it("returns true on first delivery and false on a duplicate", async () => {
      const repo = new IngressDeliveriesRepo(db);
      expect(await repo.recordDelivery("slack", "Ev1")).toBe(true);
      expect(await repo.recordDelivery("slack", "Ev1")).toBe(false);
      // Same key under a different integration is a distinct delivery.
      expect(await repo.recordDelivery("github", "Ev1")).toBe(true);
    });

    it("stays race-safe under concurrent duplicate inserts", async () => {
      const repo = new IngressDeliveriesRepo(db);
      const results = await Promise.all([
        repo.recordDelivery("slack", "EvRace"),
        repo.recordDelivery("slack", "EvRace"),
        repo.recordDelivery("slack", "EvRace"),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });
});
