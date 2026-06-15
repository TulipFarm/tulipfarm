import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { type PendingInteraction, PgPendingInteractionRepo } from "./pending-interactions";

describe("PgPendingInteractionRepo", () => {
  let db: PGlite;
  let repo: PgPendingInteractionRepo;
  let conversationId: string;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    repo = new PgPendingInteractionRepo(db);
    conversationId = randomUUID();
    // FK: pending_interactions.conversation_id references conversations(id).
    await db.query(
      "INSERT INTO conversations (id, user_id, created_at, updated_at) VALUES ($1, $2, now(), now())",
      [conversationId, randomUUID()]
    );
  });

  afterEach(async () => {
    await db.close();
  });

  const row = (overrides: Partial<PendingInteraction> = {}): PendingInteraction => ({
    id: randomUUID(),
    conversationId,
    toolCallId: "call-1",
    toolName: "ask_user",
    awaitedSchema: { type: "object" },
    surfaceId: "s1",
    createdAt: new Date(),
    resolvedAt: null,
    ...overrides,
  });

  it("creates and finds the open interaction for a conversation", async () => {
    const r = row();
    await repo.create(r);
    const found = await repo.findOpenByConversation(conversationId);
    expect(found).toMatchObject({
      id: r.id,
      toolCallId: "call-1",
      toolName: "ask_user",
      surfaceId: "s1",
    });
    expect(found?.awaitedSchema).toEqual({ type: "object" });
    expect(found?.resolvedAt).toBeNull();
  });

  it("returns null when there is no open interaction", async () => {
    expect(await repo.findOpenByConversation(conversationId)).toBeNull();
  });

  it("resolve() marks it resolved so it is no longer found open", async () => {
    const r = row();
    await repo.create(r);
    await repo.resolve(r.id);
    expect(await repo.findOpenByConversation(conversationId)).toBeNull();
  });

  it("returns the most recent open interaction", async () => {
    await repo.create(row({ createdAt: new Date(Date.now() - 1000), toolCallId: "old" }));
    await repo.create(row({ createdAt: new Date(), toolCallId: "new" }));
    const found = await repo.findOpenByConversation(conversationId);
    expect(found?.toolCallId).toBe("new");
  });
});
