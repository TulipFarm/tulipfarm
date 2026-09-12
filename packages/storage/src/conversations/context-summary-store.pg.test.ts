import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CONVERSATION_CONTEXT_SUMMARY_STORAGE_STATEMENTS,
  ConversationContextSummaryStore,
} from "./context-summary-store";

const BUSINESS = "business-1";
const CONVERSATION = "00000000-0000-4000-8000-000000000001";
const FIRST = "00000000-0000-4000-8000-000000000002";
const SECOND = "00000000-0000-4000-8000-000000000003";

describe("ConversationContextSummaryStore", () => {
  let database: PGlite;
  let store: ConversationContextSummaryStore;

  beforeAll(async () => {
    database = new PGlite();
    await database.exec(`
      CREATE TABLE conversations (id uuid PRIMARY KEY);
      CREATE TABLE messages (
        id uuid PRIMARY KEY,
        conversation_id uuid NOT NULL REFERENCES conversations(id),
        created_at timestamptz NOT NULL
      );
      INSERT INTO conversations (id) VALUES ('${CONVERSATION}');
      INSERT INTO messages (id, conversation_id, created_at) VALUES
        ('${FIRST}', '${CONVERSATION}', '2026-09-12T10:00:00Z'),
        ('${SECOND}', '${CONVERSATION}', '2026-09-12T10:01:00Z');
    `);
    for (const sql of CONVERSATION_CONTEXT_SUMMARY_STORAGE_STATEMENTS) {
      await database.exec(sql);
    }
    store = new ConversationContextSummaryStore(database);
  });

  afterAll(async () => {
    await database.close();
  });

  it("advances monotonically and only serves a summary valid for the requested cutoff", async () => {
    await store.save({
      businessId: BUSINESS,
      conversationId: CONVERSATION,
      throughMessageId: SECOND,
      summary: "newer summary",
    });
    await store.save({
      businessId: BUSINESS,
      conversationId: CONVERSATION,
      throughMessageId: FIRST,
      summary: "stale summary",
    });

    await expect(store.find(BUSINESS, CONVERSATION, FIRST)).resolves.toBeUndefined();
    await expect(store.find(BUSINESS, CONVERSATION, SECOND)).resolves.toEqual({
      throughMessageId: SECOND,
      summary: "newer summary",
    });
  });
});
