import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";
import { FeedbackRepo } from "./repo";

describe("FeedbackRepo (PGlite)", () => {
  let db: PGlite;
  let repo: FeedbackRepo;
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const conversationId = randomUUID();
  const messageId = randomUUID();

  async function seedMessage(id: string): Promise<void> {
    await db.query(
      "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ($1, $2, 'assistant', $3::jsonb, now())",
      [id, conversationId, JSON.stringify("hi there")]
    );
  }

  beforeEach(async () => {
    db = await makeMigratedPglite();
    await db.query(
      "INSERT INTO conversations (id, user_id, created_at, updated_at) VALUES ($1, $2, now(), now())",
      [conversationId, userId]
    );
    await seedMessage(messageId);
    repo = new FeedbackRepo(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("upserts a new vote and lists it for the same user", async () => {
    const ok = await repo.upsert({ id: randomUUID(), messageId, userId, rating: "up", note: null });
    expect(ok).toBe(true);

    const rows = await repo.listByConversation(conversationId, userId);
    expect(rows).toEqual([{ messageId, rating: "up", note: null }]);
  });

  it("re-voting upserts in place (one row per message/user) and keeps the note", async () => {
    await repo.upsert({ id: randomUUID(), messageId, userId, rating: "up", note: null });
    const ok = await repo.upsert({
      id: randomUUID(),
      messageId,
      userId,
      rating: "down",
      note: "too long",
    });
    expect(ok).toBe(true);

    const rows = await repo.listByConversation(conversationId, userId);
    expect(rows).toEqual([{ messageId, rating: "down", note: "too long" }]);
  });

  it("returns false (and writes nothing) for a missing message", async () => {
    const ok = await repo.upsert({
      id: randomUUID(),
      messageId: randomUUID(),
      userId,
      rating: "down",
      note: null,
    });
    expect(ok).toBe(false);
    expect(await repo.listByConversation(conversationId, userId)).toEqual([]);
  });

  it("clear removes the caller's vote and is idempotent", async () => {
    await repo.upsert({ id: randomUUID(), messageId, userId, rating: "up", note: null });
    await repo.clear(messageId, userId);
    await repo.clear(messageId, userId); // no-op the second time
    expect(await repo.listByConversation(conversationId, userId)).toEqual([]);
  });

  it("scopes votes per user", async () => {
    await repo.upsert({ id: randomUUID(), messageId, userId, rating: "up", note: null });
    await repo.upsert({
      id: randomUUID(),
      messageId,
      userId: otherUserId,
      rating: "down",
      note: null,
    });

    expect(await repo.listByConversation(conversationId, userId)).toEqual([
      { messageId, rating: "up", note: null },
    ]);
    expect(await repo.listByConversation(conversationId, otherUserId)).toEqual([
      { messageId, rating: "down", note: null },
    ]);
  });
});
