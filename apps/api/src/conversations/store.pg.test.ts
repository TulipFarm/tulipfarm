import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Queryable } from "../db";
import { makeMigratedPglite } from "../test/pglite";
import type { PersistedTurn } from "./service";
import { PgConversationStore } from "./store.pg";

const CONVERSATION_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const TURN_ID = "00000000-0000-4000-8000-000000000003";
const MESSAGE_ID = "00000000-0000-4000-8000-000000000004";
const RUN_ID = "00000000-0000-4000-8000-000000000005";
const REPLY_ID = "00000000-0000-4000-8000-000000000008";

const CREATED_AT = new Date("2026-07-26T00:00:00.000Z");

function turn(overrides: Partial<PersistedTurn> = {}): PersistedTurn {
  return {
    id: TURN_ID,
    businessId: DEPLOYMENT_BUSINESS_ID,
    conversationId: CONVERSATION_ID,
    idempotencyKey: "client-key-1",
    requestMessageId: MESSAGE_ID,
    status: "pending",
    attempt: 1,
    runId: null,
    cursor: 0,
    supersededRunIds: [],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

describe("PgConversationStore", () => {
  let database: PGlite;
  let store: PgConversationStore;

  beforeEach(async () => {
    database = await makeMigratedPglite();
    await database.query(
      "INSERT INTO conversations (id, user_id, created_at, updated_at) VALUES ($1, $2, $3, $3)",
      [CONVERSATION_ID, USER_ID, CREATED_AT]
    );
    store = new PgConversationStore(database as unknown as Queryable);
  });

  afterEach(async () => {
    await database.close();
  });

  it("round-trips a Turn and its request Message", async () => {
    await store.appendMessage({
      id: MESSAGE_ID,
      businessId: DEPLOYMENT_BUSINESS_ID,
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      role: "user",
      content: "hello",
      createdAt: CREATED_AT,
    });
    await store.saveTurn(turn());

    await expect(
      store.findTurnByIdempotencyKey(DEPLOYMENT_BUSINESS_ID, "client-key-1")
    ).resolves.toEqual(turn());
    await expect(store.findTurn(DEPLOYMENT_BUSINESS_ID, TURN_ID)).resolves.toEqual(turn());
    await expect(store.listMessages(DEPLOYMENT_BUSINESS_ID, CONVERSATION_ID)).resolves.toEqual([
      {
        id: MESSAGE_ID,
        businessId: DEPLOYMENT_BUSINESS_ID,
        conversationId: CONVERSATION_ID,
        turnId: TURN_ID,
        role: "user",
        content: "hello",
        createdAt: CREATED_AT,
      },
    ]);
  });

  it("updates a Turn in place once its Run is dispatched", async () => {
    await store.saveTurn(turn());
    const dispatched = turn({
      status: "running",
      runId: RUN_ID,
      supersededRunIds: [RUN_ID],
      cursor: 7,
      updatedAt: new Date("2026-07-26T00:00:05.000Z"),
    });
    await store.saveTurn(dispatched);

    await expect(store.findTurn(DEPLOYMENT_BUSINESS_ID, TURN_ID)).resolves.toEqual(dispatched);
    const count = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM conversation_turns"
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it("omits messages that belong to no Turn", async () => {
    // A row written by the pre-Turn chat path: real history, but not a Turn's request or reply.
    await database.query(
      `INSERT INTO messages (id, conversation_id, role, content, created_at)
       VALUES ($1, $2, 'user', $3::jsonb, $4)`,
      [
        "00000000-0000-4000-8000-000000000006",
        CONVERSATION_ID,
        JSON.stringify("legacy"),
        CREATED_AT,
      ]
    );

    await expect(store.listMessages(DEPLOYMENT_BUSINESS_ID, CONVERSATION_ID)).resolves.toEqual([]);
  });

  it("finds the Turn a Run is answering", async () => {
    await store.saveTurn(turn({ status: "running", runId: RUN_ID }));

    await expect(store.findTurnByRunId(DEPLOYMENT_BUSINESS_ID, RUN_ID)).resolves.toMatchObject({
      id: TURN_ID,
      runId: RUN_ID,
    });
    // A superseded Run no longer names the Turn, so its executor cannot reach it.
    await expect(
      store.findTurnByRunId(DEPLOYMENT_BUSINESS_ID, "00000000-0000-4000-8000-000000000009")
    ).resolves.toBeUndefined();
  });

  it("keeps the first outcome an attempt recorded", async () => {
    await store.saveTurn(turn());
    const completion = {
      businessId: DEPLOYMENT_BUSINESS_ID,
      turnId: TURN_ID,
      attempt: 1,
      status: "succeeded" as const,
      messageId: REPLY_ID,
      cursor: 4,
      createdAt: CREATED_AT,
    };
    await store.completeTurn({ completion: completion });
    // A redelivered job must not rewrite the answer the Turn already has.
    await store.completeTurn({
      completion: { ...completion, status: "failed", messageId: null, cursor: 9 },
    });

    await expect(store.findCompletion(DEPLOYMENT_BUSINESS_ID, TURN_ID, 1)).resolves.toEqual(
      completion
    );
    await expect(store.findCompletion(DEPLOYMENT_BUSINESS_ID, TURN_ID, 2)).resolves.toBeUndefined();
  });

  it("replays only the assistant Message that completed the Turn", async () => {
    await store.saveTurn(turn());
    // What a Worker killed after writing its reply leaves behind.
    await store.appendMessage({
      id: "00000000-0000-4000-8000-000000000007",
      businessId: DEPLOYMENT_BUSINESS_ID,
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      role: "assistant",
      content: "abandoned",
      attempt: 1,
      createdAt: CREATED_AT,
    });
    await store.appendMessage({
      id: REPLY_ID,
      businessId: DEPLOYMENT_BUSINESS_ID,
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      role: "assistant",
      content: "the answer",
      attempt: 2,
      createdAt: new Date("2026-07-26T00:00:05.000Z"),
    });
    await store.completeTurn({
      completion: {
        businessId: DEPLOYMENT_BUSINESS_ID,
        turnId: TURN_ID,
        attempt: 2,
        status: "succeeded",
        messageId: REPLY_ID,
        cursor: 4,
        createdAt: CREATED_AT,
      },
    });

    const messages = await store.listMessages(DEPLOYMENT_BUSINESS_ID, CONVERSATION_ID);
    expect(messages).toEqual([
      {
        id: REPLY_ID,
        businessId: DEPLOYMENT_BUSINESS_ID,
        conversationId: CONVERSATION_ID,
        turnId: TURN_ID,
        role: "assistant",
        content: "the answer",
        attempt: 2,
        createdAt: new Date("2026-07-26T00:00:05.000Z"),
      },
    ]);
  });

  it("round-trips assistant Message metadata without changing text content", async () => {
    await store.saveTurn(turn());
    await store.appendMessage({
      id: REPLY_ID,
      businessId: DEPLOYMENT_BUSINESS_ID,
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      role: "assistant",
      content: "the answer",
      metadata: {
        toolCalls: [
          {
            callId: "call-1",
            name: "record_create",
            argsDigest: "sha256:args",
            argsPreview: { json: '{"title":"x"}', bytes: 13 },
            outcome: "ok",
          },
        ],
      },
      attempt: 1,
      createdAt: CREATED_AT,
    });
    await store.completeTurn({
      completion: {
        businessId: DEPLOYMENT_BUSINESS_ID,
        turnId: TURN_ID,
        attempt: 1,
        status: "succeeded",
        messageId: REPLY_ID,
        cursor: 4,
        createdAt: CREATED_AT,
      },
    });

    await expect(store.listMessages(DEPLOYMENT_BUSINESS_ID, CONVERSATION_ID)).resolves.toEqual([
      {
        id: REPLY_ID,
        businessId: DEPLOYMENT_BUSINESS_ID,
        conversationId: CONVERSATION_ID,
        turnId: TURN_ID,
        role: "assistant",
        content: "the answer",
        metadata: {
          toolCalls: [
            {
              callId: "call-1",
              name: "record_create",
              argsDigest: "sha256:args",
              argsPreview: { json: '{"title":"x"}', bytes: 13 },
              outcome: "ok",
            },
          ],
        },
        attempt: 1,
        createdAt: CREATED_AT,
      },
    ]);
  });

  it("refuses a businessId this deployment does not own", async () => {
    await expect(store.findTurn("other-business", TURN_ID)).rejects.toThrow(
      "conversation_store_business_mismatch:other-business"
    );
  });

  describe("completeTurn", () => {
    const completion = {
      businessId: DEPLOYMENT_BUSINESS_ID,
      turnId: TURN_ID,
      attempt: 1,
      status: "succeeded" as const,
      messageId: null,
      cursor: 4,
      createdAt: CREATED_AT,
    };
    const work = {
      businessId: DEPLOYMENT_BUSINESS_ID,
      userId: USER_ID,
      reason: "turn_completed" as const,
      sourceKey: TURN_ID,
    };

    async function dueWork(): Promise<{ source_key: string; status: string }[]> {
      const rows = await database.query<{ source_key: string; status: string }>(
        "SELECT source_key, status FROM curator_user_work ORDER BY source_key"
      );
      return rows.rows;
    }

    beforeEach(async () => {
      await store.saveTurn(turn({ status: "running" }));
    });

    it("records the completion, the Turn and the Curator work in one call", async () => {
      await expect(
        store.completeTurn({
          completion,
          turn: turn({ status: "succeeded", cursor: 4 }),
          work,
        })
      ).resolves.toEqual({ completionInserted: true });

      await expect(store.findCompletion(DEPLOYMENT_BUSINESS_ID, TURN_ID, 1)).resolves.toMatchObject(
        { status: "succeeded" }
      );
      await expect(store.findTurn(DEPLOYMENT_BUSINESS_ID, TURN_ID)).resolves.toMatchObject({
        status: "succeeded",
        cursor: 4,
      });
      await expect(dueWork()).resolves.toEqual([{ source_key: TURN_ID, status: "due" }]);
    });

    // A redelivered completion must not re-raise work the Curator has already claimed or finished.
    it("raises work only for the writer that wins the completion insert", async () => {
      await store.completeTurn({ completion, work });
      await database.query("UPDATE curator_user_work SET status = 'done'");

      await expect(store.completeTurn({ completion, work })).resolves.toEqual({
        completionInserted: false,
      });

      await expect(dueWork()).resolves.toEqual([{ source_key: TURN_ID, status: "done" }]);
    });

    it("leaves no completion behind when the work insert fails", async () => {
      await expect(
        store.completeTurn({
          completion,
          work: { ...work, reason: "not_a_reason" as (typeof work)["reason"] },
        })
      ).rejects.toThrow();

      await expect(
        store.findCompletion(DEPLOYMENT_BUSINESS_ID, TURN_ID, 1)
      ).resolves.toBeUndefined();
      await expect(dueWork()).resolves.toEqual([]);
    });

    it("completes a Turn that earns no work", async () => {
      await expect(store.completeTurn({ completion })).resolves.toEqual({
        completionInserted: true,
      });
      await expect(dueWork()).resolves.toEqual([]);
    });
  });
});
