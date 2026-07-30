import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { PGlite } from "@electric-sql/pglite";
import type { LlmService } from "@tulipfarm/llm";
import { ArtifactService, TypedOutputValidator } from "@tulipfarm/run-kernel";
import {
  CHAT_REQUEST_SCHEMA_REF,
  canonicalHash,
  INVOCATION_REQUEST_SCHEMAS,
} from "@tulipfarm/schema";
import { ArtifactStore } from "@tulipfarm/storage";
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

  async function count(table: string, where = ""): Promise<number> {
    const result = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${table} ${where}`
    );
    return result.rows[0]?.count ?? 0;
  }

  it("commits a Turn, a Run, and the request Artifact before it streams", async () => {
    const response = await postChat();
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
    const response = await postChat();
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
    const first = await postChat();
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

  it("keeps one caller's idempotency key from claiming another's turn", async () => {
    const first = await postChat();
    // The key is client-supplied and Turn keys are unique deployment-wide, so an unscoped key would
    // let this second caller be refused as a duplicate — and answered with someone else's Run id.
    const second = await postChat(otherSid);

    expect(second.statusCode).toBe(200);
    expect(second.headers["x-run-id"]).not.toBe(first.headers["x-run-id"]);
    expect(await count("conversation_turns")).toBe(2);
    expect(await count("runs")).toBe(2);
  });
});
