import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { textContent } from "@tulipfarm/schema";
import { RunStore, type StartRunInput } from "@tulipfarm/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fromToolResult, PgMessageRepo } from "../chat/messages";
import { type Queryable, transactionPort } from "../db";
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
    store = new PgConversationStore(
      database as unknown as Queryable,
      (queryable) => new PgMessageRepo(queryable)
    );
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
      content: textContent("hello"),
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
        content: textContent("hello"),
        createdAt: CREATED_AT,
      },
    ]);
  });

  it("rolls back the user Message when Turn reservation fails", async () => {
    await expect(
      store.withTransaction(async (transaction) => {
        await transaction.reserveTurn({
          message: {
            id: MESSAGE_ID,
            businessId: DEPLOYMENT_BUSINESS_ID,
            conversationId: CONVERSATION_ID,
            turnId: TURN_ID,
            role: "user",
            content: textContent("hello"),
            createdAt: CREATED_AT,
          },
          turn: turn(),
        });
        throw new Error("injected after reservation");
      })
    ).rejects.toThrow("injected after reservation");

    await expect(
      database.query<{ count: number }>("SELECT count(*)::int AS count FROM conversation_turns")
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(
      database.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM messages WHERE role = 'user'"
      )
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("deduplicates competing reservations before either can append twice", async () => {
    const reserve = () => {
      const turnId = randomUUID();
      const messageId = randomUUID();
      return store.withTransaction((transaction) =>
        transaction.reserveTurn({
          message: {
            id: messageId,
            businessId: DEPLOYMENT_BUSINESS_ID,
            conversationId: CONVERSATION_ID,
            turnId,
            role: "user",
            content: textContent("hello"),
            createdAt: CREATED_AT,
          },
          turn: turn({
            id: turnId,
            requestMessageId: messageId,
          }),
        })
      );
    };

    const [first, second] = await Promise.all([reserve(), reserve()]);

    expect(second.turn.id).toBe(first.turn.id);
    expect([first.outcome, second.outcome].sort()).toEqual(["created", "replayed"]);
    await expect(
      database.query<{ count: number }>("SELECT count(*)::int AS count FROM conversation_turns")
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(
      database.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM messages WHERE role = 'user'"
      )
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
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

  it("lists history only through the Turn's persisted request boundary", async () => {
    const earlierTurnId = "00000000-0000-4000-8000-000000000015";
    const earlierRequestId = "00000000-0000-4000-8000-000000000016";
    const laterTurnId = "00000000-0000-4000-8000-000000000017";
    const laterRequestId = "00000000-0000-4000-8000-000000000018";
    await store.saveTurn(
      turn({
        id: earlierTurnId,
        idempotencyKey: "earlier",
        requestMessageId: earlierRequestId,
        status: "succeeded",
        runId: "00000000-0000-4000-8000-000000000019",
        createdAt: new Date("2026-07-25T23:59:00.000Z"),
        updatedAt: new Date("2026-07-25T23:59:00.000Z"),
      })
    );
    await store.appendMessage({
      id: earlierRequestId,
      businessId: DEPLOYMENT_BUSINESS_ID,
      conversationId: CONVERSATION_ID,
      turnId: earlierTurnId,
      role: "user",
      content: textContent("earlier question"),
      createdAt: new Date("2026-07-25T23:59:00.000Z"),
    });
    await store.appendMessage({
      id: "00000000-0000-4000-8000-000000000020",
      businessId: DEPLOYMENT_BUSINESS_ID,
      conversationId: CONVERSATION_ID,
      turnId: earlierTurnId,
      role: "assistant",
      content: textContent("earlier answer"),
      attempt: 1,
      createdAt: new Date("2026-07-25T23:59:01.000Z"),
    });
    await store.completeTurn({
      completion: {
        businessId: DEPLOYMENT_BUSINESS_ID,
        turnId: earlierTurnId,
        attempt: 1,
        status: "succeeded",
        messageId: "00000000-0000-4000-8000-000000000020",
        cursor: 1,
        createdAt: new Date("2026-07-25T23:59:01.000Z"),
      },
      runId: "00000000-0000-4000-8000-000000000019",
    });
    await store.saveTurn(turn({ status: "running", runId: RUN_ID }));
    await store.appendMessage({
      id: MESSAGE_ID,
      businessId: DEPLOYMENT_BUSINESS_ID,
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      role: "user",
      content: textContent("current question"),
      createdAt: CREATED_AT,
    });
    await store.appendMessage({
      id: REPLY_ID,
      businessId: DEPLOYMENT_BUSINESS_ID,
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      role: "assistant",
      content: textContent("abandoned current answer"),
      attempt: 1,
      createdAt: new Date("2026-07-26T00:00:01.000Z"),
    });
    await store.saveTurn(
      turn({
        id: laterTurnId,
        idempotencyKey: "later",
        requestMessageId: laterRequestId,
        status: "running",
        runId: "00000000-0000-4000-8000-000000000021",
        createdAt: new Date("2026-07-26T00:01:00.000Z"),
        updatedAt: new Date("2026-07-26T00:01:00.000Z"),
      })
    );
    await store.appendMessage({
      id: laterRequestId,
      businessId: DEPLOYMENT_BUSINESS_ID,
      conversationId: CONVERSATION_ID,
      turnId: laterTurnId,
      role: "user",
      content: textContent("later question"),
      createdAt: new Date("2026-07-26T00:01:00.000Z"),
    });

    const messages = await store.listMessages(DEPLOYMENT_BUSINESS_ID, CONVERSATION_ID, MESSAGE_ID);
    expect(messages.map((message) => message.id)).toEqual([
      earlierRequestId,
      "00000000-0000-4000-8000-000000000020",
      MESSAGE_ID,
    ]);
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

  it("finds the newest Turn for a Conversation", async () => {
    await store.saveTurn(turn({ status: "failed", runId: RUN_ID }));
    const latest = turn({
      id: "00000000-0000-4000-8000-000000000010",
      idempotencyKey: "client-key-2",
      requestMessageId: "00000000-0000-4000-8000-000000000011",
      status: "running",
      runId: "00000000-0000-4000-8000-000000000012",
      createdAt: new Date("2026-07-26T00:01:00.000Z"),
      updatedAt: new Date("2026-07-26T00:01:00.000Z"),
    });
    await store.saveTurn(latest);

    await expect(store.findLatestTurn(DEPLOYMENT_BUSINESS_ID, CONVERSATION_ID)).resolves.toEqual({
      id: latest.id,
      runId: latest.runId,
      status: latest.status,
    });
  });

  it("keeps the first outcome an attempt recorded", async () => {
    await store.saveTurn(turn({ runId: RUN_ID }));
    const completion = {
      businessId: DEPLOYMENT_BUSINESS_ID,
      turnId: TURN_ID,
      attempt: 1,
      status: "succeeded" as const,
      messageId: REPLY_ID,
      cursor: 4,
      createdAt: CREATED_AT,
    };
    await store.completeTurn({ completion: completion, runId: RUN_ID });
    // A redelivered job must not rewrite the answer the Turn already has.
    await store.completeTurn({
      completion: { ...completion, status: "failed", messageId: null, cursor: 9 },
      runId: RUN_ID,
    });

    await expect(store.findCompletion(DEPLOYMENT_BUSINESS_ID, TURN_ID, 1)).resolves.toEqual(
      completion
    );
    await expect(store.findCompletion(DEPLOYMENT_BUSINESS_ID, TURN_ID, 2)).resolves.toBeUndefined();
  });

  it("round-trips a failed completion's reason and model diagnostic through jsonb", async () => {
    await store.saveTurn(turn({ runId: RUN_ID }));
    const completion = {
      businessId: DEPLOYMENT_BUSINESS_ID,
      turnId: TURN_ID,
      attempt: 1,
      status: "failed" as const,
      messageId: null,
      cursor: 4,
      createdAt: CREATED_AT,
      reason: "model_rate_limited",
      modelFailure: { requestId: "req-1", modelId: "gpt-x" },
    };
    await store.completeTurn({ completion, runId: RUN_ID });

    await expect(store.findCompletion(DEPLOYMENT_BUSINESS_ID, TURN_ID, 1)).resolves.toEqual(
      completion
    );
  });

  it("replays only the assistant Message that completed the Turn", async () => {
    await store.saveTurn(turn({ attempt: 2, runId: RUN_ID }));
    // What a Worker killed after writing its reply leaves behind.
    await store.appendMessage({
      id: "00000000-0000-4000-8000-000000000007",
      businessId: DEPLOYMENT_BUSINESS_ID,
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      role: "assistant",
      content: textContent("abandoned"),
      attempt: 1,
      createdAt: CREATED_AT,
    });
    await store.appendMessage({
      id: REPLY_ID,
      businessId: DEPLOYMENT_BUSINESS_ID,
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      role: "assistant",
      content: textContent("the answer"),
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
      runId: RUN_ID,
    });

    const messages = await store.listMessages(DEPLOYMENT_BUSINESS_ID, CONVERSATION_ID);
    expect(messages).toEqual([
      {
        id: REPLY_ID,
        businessId: DEPLOYMENT_BUSINESS_ID,
        conversationId: CONVERSATION_ID,
        turnId: TURN_ID,
        role: "assistant",
        content: textContent("the answer"),
        attempt: 2,
        createdAt: new Date("2026-07-26T00:00:05.000Z"),
      },
    ]);
  });

  it("surfaces a reply that was written but never completed (#662)", async () => {
    // appendAssistantMessage and completeTurn are two separate writes; a crash in between (a
    // guard timeout, a killed process) leaves exactly this: the reply row exists, but no
    // turn_completions row was ever written for it. Existence-gating on that row would hide the
    // reply from every reload forever even though the reader already watched it stream in.
    await store.saveTurn(turn());
    await store.appendMessage({
      id: REPLY_ID,
      businessId: DEPLOYMENT_BUSINESS_ID,
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      role: "assistant",
      content: textContent("revoke this key"),
      attempt: 1,
      createdAt: CREATED_AT,
    });

    const messages = await store.listMessages(DEPLOYMENT_BUSINESS_ID, CONVERSATION_ID);
    expect(messages).toEqual([
      {
        id: REPLY_ID,
        businessId: DEPLOYMENT_BUSINESS_ID,
        conversationId: CONVERSATION_ID,
        turnId: TURN_ID,
        role: "assistant",
        content: textContent("revoke this key"),
        attempt: 1,
        createdAt: CREATED_AT,
      },
    ]);
  });

  it("round-trips assistant Message metadata without changing text content", async () => {
    await store.saveTurn(turn({ runId: RUN_ID }));
    await store.appendMessage({
      id: REPLY_ID,
      businessId: DEPLOYMENT_BUSINESS_ID,
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      role: "assistant",
      content: textContent("the answer"),
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
      runId: RUN_ID,
    });

    await expect(store.listMessages(DEPLOYMENT_BUSINESS_ID, CONVERSATION_ID)).resolves.toEqual([
      {
        id: REPLY_ID,
        businessId: DEPLOYMENT_BUSINESS_ID,
        conversationId: CONVERSATION_ID,
        turnId: TURN_ID,
        role: "assistant",
        content: textContent("the answer"),
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

  it("updates one attempt Message as checkpoints advance", async () => {
    await store.saveTurn(turn({ status: "running", runId: RUN_ID }));
    const firstId = "00000000-0000-4000-8000-000000000022";
    await store.appendAssistantMessage({
      message: {
        id: firstId,
        businessId: DEPLOYMENT_BUSINESS_ID,
        conversationId: CONVERSATION_ID,
        turnId: TURN_ID,
        role: "assistant",
        content: textContent("first"),
        metadata: {
          turnAttempt: {
            runId: RUN_ID,
            attempt: 1,
            cursor: 2,
            outcome: "waiting",
            complete: false,
          },
        },
        attempt: 1,
        createdAt: CREATED_AT,
      },
      runId: RUN_ID,
      attempt: 1,
    });

    const result = await store.appendAssistantMessage({
      message: {
        id: "00000000-0000-4000-8000-000000000023",
        businessId: DEPLOYMENT_BUSINESS_ID,
        conversationId: CONVERSATION_ID,
        turnId: TURN_ID,
        role: "assistant",
        content: textContent("first second"),
        metadata: {
          surfaces: [{ artifactId: "artifact-1", revision: 4 }],
          turnAttempt: {
            runId: RUN_ID,
            attempt: 1,
            cursor: 5,
            outcome: "succeeded",
            complete: true,
          },
        },
        attempt: 1,
        createdAt: CREATED_AT,
      },
      runId: RUN_ID,
      attempt: 1,
    });

    expect(result.messageId).toBe(firstId);
    await expect(
      store.findAttemptMessage(DEPLOYMENT_BUSINESS_ID, TURN_ID, 1)
    ).resolves.toMatchObject({
      id: firstId,
      content: textContent("first second"),
      metadata: {
        surfaces: [{ artifactId: "artifact-1", revision: 4 }],
        turnAttempt: { cursor: 5, complete: true },
      },
    });
  });

  it("retains a failed attempt after the same Turn succeeds on retry", async () => {
    const failedId = "00000000-0000-4000-8000-000000000024";
    const retryRunId = "00000000-0000-4000-8000-000000000025";
    await store.saveTurn(turn({ status: "running", runId: RUN_ID }));
    await store.appendMessage({
      id: failedId,
      businessId: DEPLOYMENT_BUSINESS_ID,
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      role: "assistant",
      content: textContent("safe progress"),
      attempt: 1,
      createdAt: CREATED_AT,
    });
    await store.completeTurn({
      completion: {
        businessId: DEPLOYMENT_BUSINESS_ID,
        turnId: TURN_ID,
        attempt: 1,
        status: "failed",
        messageId: failedId,
        cursor: 4,
        createdAt: CREATED_AT,
      },
      runId: RUN_ID,
    });
    await store.saveTurn(
      turn({
        status: "running",
        attempt: 2,
        runId: retryRunId,
        supersededRunIds: [RUN_ID],
      })
    );
    await store.appendMessage({
      id: REPLY_ID,
      businessId: DEPLOYMENT_BUSINESS_ID,
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      role: "assistant",
      content: textContent("retry succeeded"),
      attempt: 2,
      createdAt: new Date("2026-07-26T00:00:01.000Z"),
    });
    await store.completeTurn({
      completion: {
        businessId: DEPLOYMENT_BUSINESS_ID,
        turnId: TURN_ID,
        attempt: 2,
        status: "succeeded",
        messageId: REPLY_ID,
        cursor: 3,
        createdAt: new Date("2026-07-26T00:00:01.000Z"),
      },
      runId: retryRunId,
    });

    const messages = await store.listMessages(DEPLOYMENT_BUSINESS_ID, CONVERSATION_ID);
    expect(messages.map((message) => message.id)).toEqual([failedId, REPLY_ID]);
  });

  it("settles a terminal Run once and fences a late callback from an older retry", async () => {
    await store.saveTurn(turn({ status: "running", runId: RUN_ID }));
    await store.appendAssistantMessage({
      message: {
        id: REPLY_ID,
        businessId: DEPLOYMENT_BUSINESS_ID,
        conversationId: CONVERSATION_ID,
        turnId: TURN_ID,
        role: "assistant",
        content: textContent("Work before cancellation."),
        metadata: {
          turnAttempt: {
            runId: RUN_ID,
            attempt: 1,
            cursor: 4,
            outcome: "waiting",
            complete: false,
          },
        },
        attempt: 1,
        createdAt: CREATED_AT,
      },
      runId: RUN_ID,
      attempt: 1,
    });

    await expect(
      store.settleTerminalTurn({
        businessId: DEPLOYMENT_BUSINESS_ID,
        turnId: TURN_ID,
        runId: RUN_ID,
        attempt: 1,
        status: "failed",
        cursor: 7,
        reason: "run_cancelled",
        createdAt: CREATED_AT,
        historyOutcome: "cancelled",
      })
    ).resolves.toEqual({ completionInserted: true, status: "recorded" });
    await expect(store.findCompletion(DEPLOYMENT_BUSINESS_ID, TURN_ID, 1)).resolves.toMatchObject({
      status: "failed",
      messageId: REPLY_ID,
      cursor: 7,
      reason: "run_cancelled",
    });
    await expect(
      store.findAttemptMessage(DEPLOYMENT_BUSINESS_ID, TURN_ID, 1)
    ).resolves.toMatchObject({
      metadata: {
        turnAttempt: { runId: RUN_ID, attempt: 1, cursor: 7, outcome: "cancelled", complete: true },
      },
    });

    const retryRunId = "00000000-0000-4000-8000-000000000026";
    await store.saveTurn(
      turn({
        status: "running",
        attempt: 2,
        runId: retryRunId,
        supersededRunIds: [RUN_ID],
      })
    );
    await expect(
      store.settleTerminalTurn({
        businessId: DEPLOYMENT_BUSINESS_ID,
        turnId: TURN_ID,
        runId: RUN_ID,
        attempt: 1,
        status: "failed",
        cursor: 9,
        reason: "run_failed",
        createdAt: new Date("2026-07-26T00:00:02.000Z"),
        historyOutcome: "failed",
      })
    ).resolves.toEqual({ completionInserted: false, status: "stale" });
    await expect(store.findTurn(DEPLOYMENT_BUSINESS_ID, TURN_ID)).resolves.toMatchObject({
      status: "running",
      attempt: 2,
      runId: retryRunId,
    });
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

    beforeEach(async () => {
      await store.saveTurn(turn({ status: "running", runId: RUN_ID }));
    });

    it("atomically rejects Message and completion writes from an older Run claim", async () => {
      const runs = new RunStore(transactionPort(database as unknown as Queryable));
      const runInput: StartRunInput = {
        id: RUN_ID,
        businessId: DEPLOYMENT_BUSINESS_ID,
        source: "chat",
        bundle: {
          digest: "sha256:bundle",
          routineId: "chat",
          routineVersion: "1",
        },
        identity: {
          initiator: { kind: "user", id: USER_ID },
          effectiveSubject: { kind: "user", id: USER_ID },
          guardrailContextRef: "guardrails",
        },
        createdAt: CREATED_AT.toISOString(),
        states: [],
      };
      await runs.start(runInput);
      const [claim] = await runs.claimNextQueued(DEPLOYMENT_BUSINESS_ID, "worker-1", {
        now: CREATED_AT.toISOString(),
        leaseDurationMs: 60_000,
        limit: 1,
      });
      if (claim === undefined) throw new Error("claim missing");
      await runs.transitionRun(DEPLOYMENT_BUSINESS_ID, RUN_ID, {
        expectedVersion: claim.version,
        expectedStatus: "claimed",
        status: "running",
        leaseOwner: "worker-1",
        leaseExpiresAt: claim.leaseExpiresAt,
      });
      await database.query(
        "UPDATE runs SET lease_generation = lease_generation + 1 WHERE id = $1",
        [RUN_ID]
      );

      await expect(
        store.appendAssistantMessage({
          message: {
            id: REPLY_ID,
            businessId: DEPLOYMENT_BUSINESS_ID,
            conversationId: CONVERSATION_ID,
            turnId: TURN_ID,
            role: "assistant",
            content: textContent("late answer"),
            attempt: 1,
            createdAt: CREATED_AT,
          },
          runId: RUN_ID,
          attempt: 1,
          expectedLeaseGeneration: claim.leaseGeneration,
        })
      ).resolves.toEqual({ status: "ownership_lost", messageId: null });
      await expect(
        store.completeTurn({
          completion,
          runId: RUN_ID,
          expectedLeaseGeneration: claim.leaseGeneration,
        })
      ).resolves.toEqual({ completionInserted: false, status: "ownership_lost" });
      expect(
        (
          await database.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM messages WHERE role = 'assistant'"
          )
        ).rows[0]?.count
      ).toBe(0);
      await expect(
        store.findCompletion(DEPLOYMENT_BUSINESS_ID, TURN_ID, completion.attempt)
      ).resolves.toBeUndefined();
      await expect(store.findTurn(DEPLOYMENT_BUSINESS_ID, TURN_ID)).resolves.toMatchObject({
        status: "running",
      });
    });

    it("records the completion and the Turn in one call", async () => {
      await expect(
        store.completeTurn({
          completion,
          runId: RUN_ID,
          surfaceMessage: fromToolResult(CONVERSATION_ID, [
            { type: "surface", artifactId: "surface-1", revision: 1 },
          ]),
        })
      ).resolves.toEqual({ completionInserted: true, status: "recorded" });

      await expect(store.findCompletion(DEPLOYMENT_BUSINESS_ID, TURN_ID, 1)).resolves.toMatchObject(
        { status: "succeeded" }
      );
      await expect(store.findTurn(DEPLOYMENT_BUSINESS_ID, TURN_ID)).resolves.toMatchObject({
        status: "succeeded",
        cursor: 4,
      });
      expect(
        (
          await database.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM messages WHERE role = 'tool'"
          )
        ).rows[0]?.count
      ).toBe(1);
    });

    it("reports a redelivered completion as not inserted", async () => {
      const surfaceMessage = fromToolResult(CONVERSATION_ID, [
        { type: "surface", artifactId: "surface-1", revision: 1 },
      ]);
      await store.completeTurn({ completion, runId: RUN_ID, surfaceMessage });
      await expect(
        store.completeTurn({ completion, runId: RUN_ID, surfaceMessage })
      ).resolves.toEqual({
        completionInserted: false,
        status: "replayed",
      });
      expect(
        (
          await database.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM messages WHERE role = 'tool'"
          )
        ).rows[0]?.count
      ).toBe(1);
    });

    it("completes a Turn", async () => {
      await expect(store.completeTurn({ completion, runId: RUN_ID })).resolves.toEqual({
        completionInserted: true,
        status: "recorded",
      });
    });

    it("makes assistant Message replay idempotent for the current attempt", async () => {
      const first = await store.appendAssistantMessage({
        message: {
          id: REPLY_ID,
          businessId: DEPLOYMENT_BUSINESS_ID,
          conversationId: CONVERSATION_ID,
          turnId: TURN_ID,
          role: "assistant",
          content: textContent("the answer"),
          attempt: 1,
          createdAt: CREATED_AT,
        },
        runId: RUN_ID,
        attempt: 1,
      });
      const replay = await store.appendAssistantMessage({
        message: {
          id: "00000000-0000-4000-8000-000000000013",
          businessId: DEPLOYMENT_BUSINESS_ID,
          conversationId: CONVERSATION_ID,
          turnId: TURN_ID,
          role: "assistant",
          content: textContent("the answer"),
          attempt: 1,
          createdAt: CREATED_AT,
        },
        runId: RUN_ID,
        attempt: 1,
      });

      expect(first).toEqual({ status: "recorded", messageId: REPLY_ID });
      expect(replay).toEqual(first);
      expect(
        (
          await database.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM messages WHERE role = 'assistant'"
          )
        ).rows[0]?.count
      ).toBe(1);
    });

    it("does not insert stale assistant, Surface, completion, or Turn state", async () => {
      const retryRunId = "00000000-0000-4000-8000-000000000014";
      await store.saveTurn(
        turn({
          status: "running",
          attempt: 2,
          runId: retryRunId,
          supersededRunIds: [RUN_ID],
        })
      );

      await expect(
        store.appendAssistantMessage({
          message: {
            id: REPLY_ID,
            businessId: DEPLOYMENT_BUSINESS_ID,
            conversationId: CONVERSATION_ID,
            turnId: TURN_ID,
            role: "assistant",
            content: textContent("stale answer"),
            attempt: 1,
            createdAt: CREATED_AT,
          },
          runId: RUN_ID,
          attempt: 1,
        })
      ).resolves.toEqual({ status: "stale", messageId: null });

      await expect(
        store.completeTurn({
          completion,
          runId: RUN_ID,
          surfaceMessage: fromToolResult(CONVERSATION_ID, [
            { type: "surface", artifactId: "surface-1", revision: 1 },
          ]),
        })
      ).resolves.toEqual({ completionInserted: false, status: "stale" });

      expect(
        (
          await database.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM messages WHERE role IN ('assistant', 'tool')"
          )
        ).rows[0]?.count
      ).toBe(0);
      await expect(
        store.findCompletion(DEPLOYMENT_BUSINESS_ID, TURN_ID, 1)
      ).resolves.toBeUndefined();
      await expect(store.findTurn(DEPLOYMENT_BUSINESS_ID, TURN_ID)).resolves.toMatchObject({
        attempt: 2,
        runId: retryRunId,
        status: "running",
      });
    });
  });
});
