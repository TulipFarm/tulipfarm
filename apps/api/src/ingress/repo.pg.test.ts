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

    it("keeps the first mapping on duplicate insert and returns the winner", async () => {
      const repo = new IntegrationConversationsRepo(db);
      const otherConvo = randomUUID();
      await db.query(
        "INSERT INTO conversations (id, user_id, created_at, updated_at) VALUES ($1, $2, now(), now())",
        [otherConvo, userId]
      );
      const first = await repo.insert({
        integrationSlug: "slack",
        externalKey: "k",
        conversationId,
        userId,
      });
      const loser = await repo.insert({
        integrationSlug: "slack",
        externalKey: "k",
        conversationId: otherConvo,
        userId,
      });
      expect(first.conversationId).toBe(conversationId);
      // The loser is told the winning conversation, not the id it tried to write.
      expect(loser.conversationId).toBe(conversationId);
      const found = await repo.find("slack", "k");
      expect(found?.conversationId).toBe(conversationId);
    });

    it("returns one shared winner under concurrent first inserts", async () => {
      const repo = new IntegrationConversationsRepo(db);
      const convoB = randomUUID();
      await db.query(
        "INSERT INTO conversations (id, user_id, created_at, updated_at) VALUES ($1, $2, now(), now())",
        [convoB, userId]
      );
      const [a, b] = await Promise.all([
        repo.insert({ integrationSlug: "slack", externalKey: "race", conversationId, userId }),
        repo.insert({
          integrationSlug: "slack",
          externalKey: "race",
          conversationId: convoB,
          userId,
        }),
      ]);
      expect(a.conversationId).toBe(b.conversationId);
      const stored = await repo.find("slack", "race");
      expect(stored?.conversationId).toBe(a.conversationId);
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

    it("returns the first event's id when the provider replays the same event", async () => {
      const repo = new IntegrationEventsRepo(db);
      const doc = {
        integrationSlug: "slack",
        protocol: "slack",
        eventType: "member_joined_channel",
        externalId: "Ev123",
        payload: { channel: "C1" },
      };

      const first = await repo.insert(doc);
      const replay = await repo.insert(doc);

      // The id becomes the Trigger envelope's deduplication key, so a fresh one per delivery
      // would start a second Run for one provider event.
      expect(replay.id).toBe(first.id);
      const rows = await db.query(
        "SELECT id FROM integration_events WHERE integration_slug = $1 AND external_id = $2",
        ["slack", "Ev123"]
      );
      expect(rows.rows).toHaveLength(1);
    });

    it("keeps distinct event types on one external id apart", async () => {
      const repo = new IntegrationEventsRepo(db);
      const base = {
        integrationSlug: "slack",
        protocol: "slack",
        externalId: "Ev123",
        payload: {},
      };

      const joined = await repo.insert({ ...base, eventType: "member_joined_channel" });
      const left = await repo.insert({ ...base, eventType: "member_left_channel" });

      expect(left.id).not.toBe(joined.id);
    });

    it("does not dedupe across integrations", async () => {
      const repo = new IntegrationEventsRepo(db);
      const base = { protocol: "webhook", eventType: "push", externalId: "Ev123", payload: {} };

      const slack = await repo.insert({ ...base, integrationSlug: "slack" });
      const github = await repo.insert({ ...base, integrationSlug: "github" });

      expect(github.id).not.toBe(slack.id);
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

    it("still inserts every event that has no external id to dedupe on", async () => {
      const repo = new IntegrationEventsRepo(db);
      const doc = {
        integrationSlug: "slack",
        protocol: "slack",
        eventType: "reaction_added",
        payload: {},
      };

      const first = await repo.insert(doc);
      const second = await repo.insert(doc);

      expect(second.id).not.toBe(first.id);
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
