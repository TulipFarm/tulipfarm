import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";
import {
  type ConversationDoc,
  ConversationOwnerlessError,
  PgConversationRepo,
} from "./conversations";

function makeConv(overrides: Partial<ConversationDoc> = {}): ConversationDoc {
  const now = new Date();
  return { _id: randomUUID(), userId: randomUUID(), createdAt: now, updatedAt: now, ...overrides };
}

describe("PgConversationRepo", () => {
  let db: PGlite;
  let repo: PgConversationRepo;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    repo = new PgConversationRepo(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("creates a user-owned conversation and reads it back", async () => {
    const conv = makeConv({ model: "quick" });
    await repo.create(conv);
    const found = await repo.findById(conv._id);
    expect(found?.userId).toBe(conv.userId);
    expect(found?.agentId).toBeUndefined();
    expect(found?.model).toBe("quick");
  });

  it("creates an agent-owned conversation (no userId)", async () => {
    const conv = makeConv({ userId: undefined, agentId: "agent-1" });
    await repo.create(conv);
    const found = await repo.findById(conv._id);
    expect(found?.agentId).toBe("agent-1");
    expect(found?.userId).toBeUndefined();
  });

  it("rejects an ownerless conversation", async () => {
    const conv = makeConv({ userId: undefined, agentId: undefined });
    await expect(repo.create(conv)).rejects.toBeInstanceOf(ConversationOwnerlessError);
  });

  it("touch advances updated_at", async () => {
    const old = new Date("2020-01-01T00:00:00.000Z");
    const conv = makeConv({ createdAt: old, updatedAt: old });
    await repo.create(conv);
    await repo.touch(conv._id);
    const found = await repo.findById(conv._id);
    expect(found?.updatedAt.getTime()).toBeGreaterThan(old.getTime());
  });

  it("returns null for an unknown id", async () => {
    expect(await repo.findById(randomUUID())).toBeNull();
  });

  it("setTitle persists the title without bumping updated_at", async () => {
    const old = new Date("2020-01-01T00:00:00.000Z");
    const conv = makeConv({ createdAt: old, updatedAt: old });
    await repo.create(conv);
    await repo.setTitle(conv._id, "Inventory Planning");
    const found = await repo.findById(conv._id);
    expect(found?.title).toBe("Inventory Planning");
    expect(found?.updatedAt.getTime()).toBe(old.getTime());
  });

  it("setTitleIfUnset names an untitled conversation but never overwrites a rename", async () => {
    const untitled = makeConv();
    await repo.create(untitled);
    await repo.setTitleIfUnset(untitled._id, "Generated Name");
    expect((await repo.findById(untitled._id))?.title).toBe("Generated Name");

    // The async titler can land after the user has renamed from the top bar; it must lose that race.
    const renamed = makeConv();
    await repo.create(renamed);
    await repo.setTitle(renamed._id, "What I Called It");
    await repo.setTitleIfUnset(renamed._id, "Generated Name");
    expect((await repo.findById(renamed._id))?.title).toBe("What I Called It");
  });

  it("list returns a user's conversations newest-first, scoped to that user", async () => {
    const userId = randomUUID();
    const older = makeConv({ userId, updatedAt: new Date("2021-01-01T00:00:00.000Z") });
    const newer = makeConv({ userId, updatedAt: new Date("2022-01-01T00:00:00.000Z") });
    const other = makeConv({ userId: randomUUID() });
    await repo.create(older);
    await repo.create(newer);
    await repo.create(other);

    const list = await repo.list(userId, 10);
    expect(list.map((c) => c._id)).toEqual([newer._id, older._id]);
  });

  it("list honors the limit", async () => {
    const userId = randomUUID();
    for (let i = 0; i < 3; i++) {
      await repo.create(makeConv({ userId, updatedAt: new Date(2020 + i, 0, 1) }));
    }
    expect(await repo.list(userId, 2)).toHaveLength(2);
  });

  it("defaults starred to false and setStarred toggles it without bumping updated_at", async () => {
    const old = new Date("2020-01-01T00:00:00.000Z");
    const conv = makeConv({ createdAt: old, updatedAt: old });
    await repo.create(conv);
    expect((await repo.findById(conv._id))?.starred).toBe(false);

    await repo.setStarred(conv._id, true);
    const found = await repo.findById(conv._id);
    expect(found?.starred).toBe(true);
    expect(found?.updatedAt.getTime()).toBe(old.getTime());

    await repo.setStarred(conv._id, false);
    expect((await repo.findById(conv._id))?.starred).toBe(false);
  });

  it("list filters by title (case-insensitive substring) when q is given, excluding null titles", async () => {
    const userId = randomUUID();
    const match = makeConv({ userId, updatedAt: new Date("2022-01-01") });
    const noMatch = makeConv({ userId, updatedAt: new Date("2021-01-01") });
    const untitled = makeConv({ userId, updatedAt: new Date("2023-01-01") });
    await repo.create(match);
    await repo.create(noMatch);
    await repo.create(untitled);
    await repo.setTitle(match._id, "Budget Review Q3");
    await repo.setTitle(noMatch._id, "Inventory Planning");
    // `untitled` keeps a null title.

    const list = await repo.list(userId, 10, "budget");
    expect(list.map((c) => c._id)).toEqual([match._id]);
  });

  it("deletes an owned settled conversation and cascades its persisted Chat data", async () => {
    const conv = makeConv();
    const messageId = randomUUID();
    const turnId = randomUUID();
    await repo.create(conv);
    await db.query(
      `INSERT INTO messages (id, conversation_id, role, content, created_at)
       VALUES ($1, $2, 'user', '"hello"'::jsonb, now())`,
      [messageId, conv._id]
    );
    await db.query(
      `INSERT INTO message_feedback
         (id, message_id, conversation_id, user_id, rating, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 1, now(), now())`,
      [randomUUID(), messageId, conv._id, conv.userId]
    );
    await db.query(
      `INSERT INTO pending_interactions
         (id, conversation_id, tool_call_id, tool_name, awaited_schema, created_at)
       VALUES ($1, $2, 'call-1', 'test', '{}'::jsonb, now())`,
      [randomUUID(), conv._id]
    );
    await db.query(
      `INSERT INTO conversation_turns
         (id, conversation_id, idempotency_key, request_message_id, status, attempt,
          cursor, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'succeeded', 1, 0, now(), now())`,
      [turnId, conv._id, `turn-${turnId}`, messageId]
    );
    await db.query(
      `INSERT INTO turn_completions
         (turn_id, attempt, status, message_id, cursor, created_at)
       VALUES ($1, 1, 'succeeded', $2, 0, now())`,
      [turnId, messageId]
    );
    await db.query(
      `INSERT INTO surface_actions
         (handle, artifact_id, revision, event, payload, input_schema, audience, target,
          destination, conversation_id, guardrail_revision, expires_at)
       VALUES ($1, 'artifact-1', 1, 'submit', '{}'::jsonb, '{}'::jsonb, ARRAY['web'],
               '{}'::jsonb, 'web', $2, 'guardrail-1', now() + interval '1 hour')`,
      [`action-${conv._id}`, conv._id]
    );

    await expect(repo.deleteOwned(conv._id, conv.userId ?? "")).resolves.toBe("deleted");

    for (const table of [
      "conversations",
      "messages",
      "message_feedback",
      "pending_interactions",
      "conversation_turns",
      "turn_completions",
      "surface_actions",
    ]) {
      const result = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table}`
      );
      expect(result.rows[0]?.count, table).toBe("0");
    }
  });

  it("refuses deletion while an owned Turn is pending or running", async () => {
    const conv = makeConv();
    await repo.create(conv);
    await db.query(
      `INSERT INTO conversation_turns
         (id, conversation_id, idempotency_key, request_message_id, status, attempt,
          cursor, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'running', 1, 0, now(), now())`,
      [randomUUID(), conv._id, `turn-${conv._id}`, randomUUID()]
    );

    await expect(repo.deleteOwned(conv._id, conv.userId ?? "")).resolves.toBe("active_turn");
    expect(await repo.findById(conv._id)).not.toBeNull();
  });

  it("does not reveal or delete another user's conversation", async () => {
    const conv = makeConv();
    await repo.create(conv);

    await expect(repo.deleteOwned(conv._id, randomUUID())).resolves.toBe("not_found");
    expect(await repo.findById(conv._id)).not.toBeNull();
  });
});
