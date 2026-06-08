import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeCursor } from "../pagination";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { type MessageDoc, type MessagePart, PgMessageRepo } from "./messages";

const CONV_ID = "33333333-3333-3333-3333-333333333333";

async function seedConversation(db: PGlite, id = CONV_ID): Promise<void> {
  await db.query(
    "INSERT INTO conversations (id, user_id, created_at, updated_at) VALUES ($1, gen_random_uuid(), now(), now())",
    [id]
  );
}

function msg(overrides: Partial<MessageDoc> = {}): MessageDoc {
  return {
    _id: randomUUID(),
    conversationId: CONV_ID,
    role: "user",
    content: "hello",
    createdAt: new Date(),
    ...overrides,
  };
}

describe("PgMessageRepo", () => {
  let db: PGlite;
  let repo: PgMessageRepo;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    await seedConversation(db);
    repo = new PgMessageRepo(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("round-trips string content through jsonb", async () => {
    await repo.create(msg({ role: "user", content: "plain text" }));
    const { items } = await repo.listByConversation(CONV_ID, 10);
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe("plain text");
    expect(typeof items[0].content).toBe("string");
  });

  it("round-trips array (tool) content and metadata through jsonb", async () => {
    const parts: MessagePart[] = [
      { type: "tool-result", toolCallId: "c1", toolName: "search", result: { hits: 3 } },
    ];
    await repo.create(msg({ role: "tool", content: parts, metadata: { tokens: 42 } }));
    const { items } = await repo.listByConversation(CONV_ID, 10);
    expect(Array.isArray(items[0].content)).toBe(true);
    expect(items[0].content).toEqual(parts);
    expect(items[0].metadata).toEqual({ tokens: 42 });
  });

  it("round-trips assistant parts (text + tool-call) through jsonb", async () => {
    const parts: MessagePart[] = [
      { type: "text", text: "let me check" },
      { type: "tool-call", toolCallId: "c1", toolName: "search", args: { q: "x" } },
    ];
    await repo.create(msg({ role: "assistant", content: parts }));
    const { items } = await repo.listByConversation(CONV_ID, 10);
    expect(items[0].content).toEqual(parts);
  });

  it("rejects content that violates the role contract", async () => {
    await expect(repo.create(msg({ role: "user", content: [] }))).rejects.toThrow();
  });

  it("paginates by keyset in created order", async () => {
    const base = Date.now();
    for (let i = 0; i < 3; i++) {
      await repo.create(msg({ content: `m${i}`, createdAt: new Date(base + i * 1000) }));
    }
    const page1 = await repo.listByConversation(CONV_ID, 2);
    expect(page1.items.map((m) => m.content)).toEqual(["m0", "m1"]);

    const after = decodeCursor(page1.nextCursor as string);
    const page2 = await repo.listByConversation(CONV_ID, 2, after ?? undefined);
    expect(page2.items.map((m) => m.content)).toEqual(["m2"]);
    expect(page2.nextCursor).toBeNull();
  });
});
