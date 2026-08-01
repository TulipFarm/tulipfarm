import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { PGlite } from "@electric-sql/pglite";
import type { LlmService } from "@tulipfarm/llm";
import {
  ArtifactService,
  RunCancellationManager,
  TypedOutputValidator,
} from "@tulipfarm/run-kernel";
import {
  CHAT_REQUEST_SCHEMA_REF,
  canonicalHash,
  INVOCATION_REQUEST_SCHEMAS,
} from "@tulipfarm/schema";
import { ArtifactStore, ChildLinkStore, RunEventStore, RunStore } from "@tulipfarm/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/middleware";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import { PgConversationStore } from "../conversations/store.pg";
import { ambientTransactionPort, type Queryable, transactionPort } from "../db";
import type { PaginatedResult } from "../pagination";
import { runPgMigrations } from "../pg-migrate";
import { runCanceller } from "../runs/cancel";
import { DurableInvocationGateway } from "../runtime/invocation-gateway";
import { PgDurableInvocationStore } from "../runtime/invocation-store";
import { makePglite } from "../test/pglite";
import { PgConversationRepo } from "./conversations";
import { PgMessageRepo } from "./messages";

const V3_USAGE = {
  inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, reasoning: undefined },
};

function makeFakeModel(): LanguageModelV3 {
  const chunks: unknown[] = [
    { type: "text-start", id: "t0" },
    { type: "text-delta", id: "t0", delta: "hello" },
    { type: "text-end", id: "t0" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: V3_USAGE },
  ];
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "test-model",
    supportedUrls: {},
    doGenerate: vi.fn(),
    doStream: vi.fn(async () => {
      let i = 0;
      return {
        stream: new ReadableStream({
          pull(controller) {
            if (i < chunks.length) controller.enqueue(chunks[i++]);
            else controller.close();
          },
        }),
      };
    }),
  } as unknown as LanguageModelV3;
}

class FakeUserRepo implements UserRepo {
  private users: UserDoc[] = [];
  async findByEmail(email: string): Promise<UserDoc | null> {
    return this.users.find((u) => u.email === email.trim().toLowerCase()) ?? null;
  }
  async findById(id: string): Promise<UserDoc | null> {
    return this.users.find((u) => u._id === id) ?? null;
  }
  async count(): Promise<number> {
    return this.users.length;
  }
  async insert(user: UserDoc): Promise<void> {
    this.users.push(user);
  }
}

class FakeTokenRepo implements TokenRepo {
  async create(_t: TokenDoc): Promise<void> {}
  async findByHash(): Promise<TokenDoc | null> {
    return null;
  }
  async findByUserId(): Promise<TokenDoc[]> {
    return [];
  }
  async findAll(): Promise<TokenDoc[]> {
    return [];
  }
  async findById(): Promise<TokenDoc | null> {
    return null;
  }
  async deleteById(): Promise<void> {}
  async findAllPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
  async findByUserIdPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
}

const CSRF = "csrf-token-for-tests";
const IDEMPOTENCY_KEY = "client-turn-key-1";
const BODY = { message: { role: "user" as const, content: "hi there" } };

/**
 * End-to-end proof of the PR 2 submission path over real SQL: one `POST /api/v1/chat` must leave a
 * Turn, a Run, an immutable request Artifact, and exactly one user Message behind — and a replay of
 * the same request must add none of them a second time.
 */
describe("durable chat submission over HTTP", () => {
  let app: FastifyInstance;
  let db: PGlite;
  let userId: string;
  let sid: string;
  let otherSid: string;
  let validator: TypedOutputValidator;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db as unknown as Queryable);

    const sessionStore = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const user = await createUser(userRepo, "chat@example.com", "pass", "member");
    userId = user._id;
    sid = await sessionStore.create(userId);
    const other = await createUser(userRepo, "other@example.com", "pass", "member");
    otherSid = await sessionStore.create(other._id);

    validator = new TypedOutputValidator(INVOCATION_REQUEST_SCHEMAS);
    const queryable = db as unknown as Queryable;
    const invocations = new DurableInvocationGateway({
      store: new PgDurableInvocationStore(
        queryable,
        (transaction) =>
          new ArtifactService(new ArtifactStore(ambientTransactionPort(transaction)), validator)
      ),
      validator,
    });

    const runTransactions = transactionPort(queryable);
    const runStore = new RunStore(runTransactions);

    app = await buildApp({
      sessionStore,
      userRepo,
      tokenRepo: new FakeTokenRepo(),
      llmService: {
        resolve: vi.fn(() => ({
          model: makeFakeModel(),
          modelId: "test-model",
          tier: undefined,
          chain: [{ provider: "test", modelId: "test-model" }],
        })),
      } as unknown as LlmService,
      conversationRepo: new PgConversationRepo(queryable),
      messageRepo: new PgMessageRepo(queryable),
      invocations,
      conversationStore: new PgConversationStore(queryable),
      // The route streams the Run back out of `run_events`, so the reader is part of what makes a
      // turn submittable at all — a half-composed API refuses the turn rather than running it here.
      runEvents: {
        events: new RunEventStore(runTransactions),
        runs: runStore,
        authorize: async (req) =>
          req.principal
            ? { businessId: req.principal.businessId, audiences: ["participant"] }
            : null,
        pollIntervalMs: 5,
      },
      runCancel: runCanceller(
        new RunCancellationManager(runStore, new ChildLinkStore(runTransactions))
      ),
    });
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  function postChat(session = sid) {
    return app.inject({
      method: "POST",
      url: "/api/v1/chat",
      cookies: { [SESSION_COOKIE]: session, [CSRF_COOKIE]: CSRF },
      headers: { "x-csrf-token": CSRF, "idempotency-key": IDEMPOTENCY_KEY },
      payload: BODY,
    });
  }

  /** Waits for the Run an in-flight request minted — it is committed before the stream opens. */
  async function awaitRun(): Promise<{ id: string; businessId: string }> {
    for (;;) {
      const open = await db.query<{ id: string; business_id: string }>(
        "SELECT id, business_id FROM runs WHERE status NOT IN ('succeeded', 'failed', 'cancelled')"
      );
      const row = open.rows[0];
      if (row) return { id: row.id, businessId: row.business_id };
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  async function appendEvent(
    run: { id: string; businessId: string },
    event: { sequence: number; type: string; audience: string; payload: unknown }
  ): Promise<void> {
    await db.query(
      `INSERT INTO run_events
         (business_id, run_id, sequence, event_type, audience, payload, idempotency_key, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
      [
        run.businessId,
        run.id,
        event.sequence,
        event.type,
        event.audience,
        JSON.stringify(event.payload),
        `turn:1:${event.sequence}`,
      ]
    );
  }

  /**
   * One turn, start to finish: submit, settle the Run, and read back the closed stream.
   *
   * The route hands the turn to a Worker and then only reads `run_events`, so the response does not
   * arrive until the Run is terminal. Nothing in this process executes Runs, so the test plays the
   * Worker's last step — which is what makes the stream's ending a fact about the Run rather than
   * about the request handler finishing something itself.
   */
  async function chat(session = sid) {
    const response = postChat(session);
    const run = await awaitRun();
    await db.query("UPDATE runs SET status = 'succeeded' WHERE id = $1", [run.id]);
    return await response;
  }

  async function count(table: string, where = ""): Promise<number> {
    const result = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${table} ${where}`
    );
    return result.rows[0]?.count ?? 0;
  }

  it("commits a Turn, a Run, and the request Artifact before it streams", async () => {
    const response = await chat();
    expect(response.statusCode).toBe(200);

    const runId = response.headers["x-run-id"];
    expect(typeof runId).toBe("string");
    expect(await count("runs")).toBe(1);
    expect(await count("conversation_turns")).toBe(1);

    // The §4 seam: `prepareChatTurn` no longer writes the user Message, so exactly one row exists
    // and it names the Turn it belongs to. Two rows here would mean two submission paths.
    const messages = await db.query<{ turn_id: string | null; content: string }>(
      "SELECT turn_id, content FROM messages WHERE role = 'user'"
    );
    expect(messages.rows).toHaveLength(1);
    expect(messages.rows[0]?.turn_id).not.toBeNull();

    const turn = await db.query<{ id: string; run_id: string | null }>(
      "SELECT id, run_id FROM conversation_turns"
    );
    expect(turn.rows[0]?.id).toBe(messages.rows[0]?.turn_id);
    expect(turn.rows[0]?.run_id).toBe(runId);

    const artifact = await db.query<{ id: string; content: unknown; content_hash: string }>(
      "SELECT id, content, content_hash FROM artifacts"
    );
    expect(artifact.rows).toHaveLength(1);
    expect(artifact.rows[0]?.id).toBe(`${runId}:request`);
    // Verbatim: what the Worker replays must be the request as received, not a re-derived shape.
    expect(artifact.rows[0]?.content).toEqual(BODY);
    expect(artifact.rows[0]?.content_hash).toBe(canonicalHash(BODY));

    const states = await db.query<{ resolved_input: { payloadRef: string } }>(
      "SELECT resolved_input FROM run_states"
    );
    expect(states.rows[0]?.resolved_input.payloadRef).toBe(`artifact:${runId}:request`);
  });

  it("lets the Run executor reconstruct the request, and denies a reader outside the ACL", async () => {
    const response = await chat();
    const runId = response.headers["x-run-id"] as string;

    const reader = new ArtifactService(
      new ArtifactStore(transactionPort(db as unknown as Queryable)),
      validator
    );
    const request = {
      businessId: (await db.query<{ business_id: string }>("SELECT business_id FROM runs")).rows[0]
        ?.business_id as string,
      artifactId: `${runId}:request`,
      allowedClassifications: [],
      now: new Date(),
    };

    // The blocker's acceptance criterion: a Worker holding only the Run id can read the Turn input.
    await expect(
      reader.read({ ...request, reader: "service:run-executor" })
    ).resolves.toMatchObject({ schemaRef: CHAT_REQUEST_SCHEMA_REF, content: BODY });
    await expect(reader.read({ ...request, reader: `user:${userId}` })).resolves.toMatchObject({
      content: BODY,
    });
    await expect(reader.read({ ...request, reader: "user:intruder" })).rejects.toMatchObject({
      code: "artifact_unauthorized",
    });
  });

  it("answers a replayed Idempotency-Key with 409 and creates nothing new", async () => {
    const first = await chat();
    const runId = first.headers["x-run-id"];

    const replay = await postChat();

    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toEqual({ error: "duplicate chat invocation", runId });
    // Refused before the turn prepares: a retry of a first-message request must not leave an empty
    // conversation (and a generated title) behind for a turn that never runs.
    expect(await count("conversations")).toBe(1);
    expect(await count("conversation_turns")).toBe(1);
    expect(await count("runs")).toBe(1);
    expect(await count("artifacts")).toBe(1);
    expect(await count("messages", "WHERE role = 'user'")).toBe(1);
  });

  it("streams the Run's persisted events, withholding the ones this reader may not see", async () => {
    const pending = postChat();
    const run = await awaitRun();
    await appendEvent(run, {
      sequence: 1,
      type: "text.delta",
      audience: "participant",
      payload: { text: "hello", index: 0 },
    });
    // Operator evidence lives in the same log; the grant is what decides who is shown it.
    await appendEvent(run, {
      sequence: 2,
      type: "context.assembled",
      audience: "operator",
      payload: { contextDigest: "sha256:context" },
    });
    await db.query("UPDATE runs SET status = 'succeeded' WHERE id = $1", [run.id]);

    const response = await pending;
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("id: 1\nevent: text.delta\n");
    expect(response.body).toContain('"text":"hello"');
    expect(response.body).not.toContain("context.assembled");
    // The stream ends on the Run's own status, so a reader learns the turn is over from the Run.
    expect(response.body).toContain("event: stream.closed");
    expect(response.body).toContain('"status":"succeeded"');
  });

  it("stops a turn by cancelling the Run, and the stream ends on that status", async () => {
    const pending = postChat();
    const run = await awaitRun();

    const stopped = await app.inject({
      method: "POST",
      url: `/api/v1/chat/runs/${run.id}/stop`,
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: CSRF },
      headers: { "x-csrf-token": CSRF },
    });

    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toEqual({ status: "stopped" });
    // Stop is not "close my connection": the Run itself is cancelled, so the turn halts in whichever
    // process is executing it and every other reader of the same Run sees the same ending.
    const response = await pending;
    expect(response.body).toContain('"status":"cancelled"');
    const runs = await db.query<{ status: string }>("SELECT status FROM runs");
    expect(runs.rows[0]?.status).toBe("cancelled");
  });

  it("refuses to stop a Run that is already finished", async () => {
    const first = await chat();

    const stopped = await app.inject({
      method: "POST",
      url: `/api/v1/chat/runs/${first.headers["x-run-id"]}/stop`,
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: CSRF },
      headers: { "x-csrf-token": CSRF },
    });

    expect(stopped.statusCode).toBe(404);
  });

  it("keeps one caller's idempotency key from claiming another's turn", async () => {
    const first = await chat();
    // The key is client-supplied and Turn keys are unique deployment-wide, so an unscoped key would
    // let this second caller be refused as a duplicate — and answered with someone else's Run id.
    const second = await chat(otherSid);

    expect(second.statusCode).toBe(200);
    expect(second.headers["x-run-id"]).not.toBe(first.headers["x-run-id"]);
    expect(await count("conversation_turns")).toBe(2);
    expect(await count("runs")).toBe(2);
  });
});
