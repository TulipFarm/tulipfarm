import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Queryable } from "../db";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import type { PersistedTurn } from "./service";
import { PgConversationStore } from "./store.pg";

const CONVERSATION_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const TURN_ID = "00000000-0000-4000-8000-000000000003";
const MESSAGE_ID = "00000000-0000-4000-8000-000000000004";
const RUN_ID = "00000000-0000-4000-8000-000000000005";

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
    database = await makePglite();
    await runPgMigrations(
      database as unknown as Queryable,
      () => {},
      () => {}
    );
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

  it("refuses a businessId this deployment does not own", async () => {
    await expect(store.findTurn("other-business", TURN_ID)).rejects.toThrow(
      "conversation_store_business_mismatch:other-business"
    );
  });
});
