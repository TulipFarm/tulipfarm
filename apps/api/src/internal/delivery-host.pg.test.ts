import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import {
  ArtifactService,
  chatRequestArtifactId,
  INVOKE_STATE_KEY,
  RUN_EXECUTOR_PRINCIPAL_REF,
  requestArtifactId,
  TypedOutputValidator,
} from "@tulipfarm/run-kernel";
import {
  CHAT_REQUEST_SCHEMA_REF,
  INTEGRATION_REQUEST_SCHEMA_REF,
  INVOCATION_REQUEST_SCHEMAS,
  textContent,
} from "@tulipfarm/schema";
import type { SoulIntegration, SoulLoader } from "@tulipfarm/soul";
import { ArtifactStore, RunStore } from "@tulipfarm/storage";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PgConversationRepo } from "../chat/conversations";
import { PgMessageRepo } from "../chat/messages";
import type { PersistedTurn } from "../conversations/service";
import { PgConversationStore } from "../conversations/store.pg";
import { ambientTransactionPort, type Queryable, transactionPort } from "../db";
import { IntegrationConversationsRepo } from "../ingress/repo";
import { makeMigratedPglite } from "../test/pglite";
import { IngressDeliveryHost } from "./delivery-host";

const RUN_ID = "00000000-0000-4000-8000-000000000101";
const USER_ID = "00000000-0000-4000-8000-000000000102";
const NOW = new Date("2026-09-12T05:30:00.000Z");
const THREAD_KEY = "T1/C1/100.1";
const CHAT = {
  sender: "EXT-U1",
  text: "summarize this",
  reply: { binding: "default", vars: { channel: "C1" } },
};
const ENVELOPE = {
  slug: "chatapp",
  body: { team: "T1", delivery_id: "D1", event: { channel: "C1", ts: "100.1" } },
};

const integration = {
  slug: "chatapp",
  sourceIntegration: "chatapp",
  manifest: {
    name: "chatapp",
    egress: { type: "mcp", entry: { transport: "stdio", command: "npx" } },
    ingress: {
      handler: "ingress.ts",
      webhook: {
        security: { type: "hmac_sha256", header: "X-Sig", secret_env: "SECRET" },
        dedup_key: "delivery_id",
      },
      chat: {
        thread_key: "{team}/{event.channel}/{event.thread_ts|event.ts}",
        reply: {
          default: {
            tool: "send_message",
            args: { channel_id: "{channel}", text: "{text}" },
          },
        },
      },
    },
  },
  connection: { enabled: true, env: { SECRET: "s" } },
  ingressHandler: {
    source: "({ classify() { return { kind: 'ignore' }; } })",
    hash: "hash-1",
  },
} as SoulIntegration;

describe("IngressDeliveryHost PostgreSQL attachment", () => {
  let db: PGlite;
  let q: Queryable;
  let store: PgConversationStore;
  let conversations: PgConversationRepo;
  let threads: IntegrationConversationsRepo;
  let artifacts: ArtifactService;
  let artifactFailure: "before" | "after" | null;
  let host: IngressDeliveryHost;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    q = db as unknown as Queryable;
    await q.query(
      `INSERT INTO users (id, email, password_hash, role, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [USER_ID, "member@example.com", "hash", "member", NOW]
    );
    artifactFailure = null;
    const transactions = transactionPort(q);
    const validator = new TypedOutputValidator(INVOCATION_REQUEST_SCHEMAS);
    const artifactsOver = (transaction: Queryable) =>
      new ArtifactService(new ArtifactStore(ambientTransactionPort(transaction)), validator);
    artifacts = new ArtifactService(new ArtifactStore(transactions), validator);
    conversations = new PgConversationRepo(q);
    threads = new IntegrationConversationsRepo(q);
    store = new PgConversationStore(
      q,
      (transaction) => new PgMessageRepo(transaction),
      (transaction) => new PgConversationRepo(transaction)
    );

    const runs = new RunStore(transactions);
    await runs.start({
      id: RUN_ID,
      businessId: DEPLOYMENT_BUSINESS_ID,
      source: "integration",
      createdAt: NOW.toISOString(),
      bundle: { digest: "bundle-digest", routineId: "delivery", routineVersion: "1" },
      identity: {
        initiator: { kind: "integration", id: "chatapp" },
        effectiveSubject: { kind: "integration", id: "chatapp" },
        guardrailContextRef: "guardrails:1",
      },
      states: [
        {
          key: INVOKE_STATE_KEY,
          definitionRef: "published:integration:chatapp",
          resolvedInput: { payloadRef: `artifact:${requestArtifactId(RUN_ID)}` },
        },
      ],
    });
    await runs.transitionRun(DEPLOYMENT_BUSINESS_ID, RUN_ID, {
      expectedVersion: 0,
      expectedStatus: "queued",
      status: "running",
      startedAt: NOW.toISOString(),
      leaseOwner: "worker:test",
      leaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    });
    await artifacts.publish({
      id: requestArtifactId(RUN_ID),
      businessId: DEPLOYMENT_BUSINESS_ID,
      schemaRef: INTEGRATION_REQUEST_SCHEMA_REF,
      value: ENVELOPE,
      storage: "inline",
      classification: [],
      acl: { readers: [RUN_EXECUTOR_PRINCIPAL_REF] },
      retention: { policy: "standard", expiresAt: null },
      redaction: { redactedPaths: [] },
      producer: { runId: RUN_ID, stateKey: INVOKE_STATE_KEY, attempt: 0 },
      createdAt: NOW.toISOString(),
    });

    host = new IngressDeliveryHost({
      runs,
      artifacts,
      store,
      conversations,
      threads,
      transactionScope: (transaction) => {
        const transactionalArtifacts = artifactsOver(transaction);
        return {
          artifacts: {
            publish: async (input) => {
              if (artifactFailure === "before") throw new Error("injected before artifact");
              const published = await transactionalArtifacts.publish(input);
              if (artifactFailure === "after") throw new Error("injected after artifact");
              return published;
            },
          },
          conversations: new PgConversationRepo(transaction),
          threads: new IntegrationConversationsRepo(transaction),
        };
      },
      integrationEvents: { insert: async () => ({ id: "unused" }) } as never,
      soulLoader: {
        integrations: new Map([["chatapp", integration]]),
        agents: new Map(),
      } as unknown as SoulLoader,
      bundled: new Map(),
      identity: {
        resolve: async () => ({
          outcome: "linked",
          user: {
            _id: USER_ID,
            email: "member@example.com",
            passwordHash: "x",
            name: null,
            role: "member",
            status: "active",
            createdAt: NOW,
          },
          principalKind: "user",
          principalId: USER_ID,
          principalRef: `user:${USER_ID}`,
        }),
      },
      bindLinkUrl: (token) => `https://example.test/link?token=${token}`,
      log: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      } as unknown as FastifyBaseLogger,
      newId: randomUUID,
      now: () => NOW,
    });
  });

  afterEach(async () => {
    await db.close();
  });

  async function count(table: string, where = ""): Promise<number> {
    const result = await q.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${table} ${where}`
    );
    return result.rows[0]?.count ?? 0;
  }

  async function expectNoAttachment(): Promise<void> {
    expect(await count("conversations")).toBe(0);
    expect(await count("integration_conversations")).toBe(0);
    expect(await count("conversation_turns")).toBe(0);
    expect(await count("messages")).toBe(0);
    expect(await count("artifacts", `WHERE id = '${chatRequestArtifactId(RUN_ID)}'`)).toBe(0);
    await expect(
      q.query("SELECT status, version, lease_owner FROM runs WHERE id = $1", [RUN_ID])
    ).resolves.toMatchObject({
      rows: [{ status: "running", version: 1, lease_owner: "worker:test" }],
    });
    expect(await count("run_states")).toBe(1);
  }

  it.each(["before", "after"] as const)(
    "rolls back the whole attachment when derived Artifact publication fails %s its write",
    async (failure) => {
      artifactFailure = failure;

      await expect(host.attachChat(DEPLOYMENT_BUSINESS_ID, RUN_ID, CHAT)).rejects.toThrow(
        `injected ${failure} artifact`
      );
      await expectNoAttachment();

      artifactFailure = null;
      await expect(host.attachChat(DEPLOYMENT_BUSINESS_ID, RUN_ID, CHAT)).resolves.toMatchObject({
        outcome: "attached",
        attempt: 1,
      });
      expect(await count("conversations")).toBe(1);
      expect(await count("integration_conversations")).toBe(1);
      expect(await count("conversation_turns")).toBe(1);
      expect(await count("messages")).toBe(1);
      expect(await count("artifacts", `WHERE id = '${chatRequestArtifactId(RUN_ID)}'`)).toBe(1);
    }
  );

  it("deduplicates concurrent attachment and preserves the existing integration Run", async () => {
    const [first, second] = await Promise.all([
      host.attachChat(DEPLOYMENT_BUSINESS_ID, RUN_ID, CHAT),
      host.attachChat(DEPLOYMENT_BUSINESS_ID, RUN_ID, CHAT),
    ]);

    expect(second).toEqual(first);
    expect(await count("conversations")).toBe(1);
    expect(await count("integration_conversations")).toBe(1);
    expect(await count("conversation_turns")).toBe(1);
    expect(await count("messages")).toBe(1);
    expect(await count("artifacts", `WHERE id = '${chatRequestArtifactId(RUN_ID)}'`)).toBe(1);
    await expect(
      q.query("SELECT status, version, lease_owner FROM runs WHERE id = $1", [RUN_ID])
    ).resolves.toMatchObject({
      rows: [{ status: "running", version: 1, lease_owner: "worker:test" }],
    });
    expect(await count("run_states")).toBe(1);
  });

  it("repairs a legacy Run-bound Turn whose derived request Artifact is missing", async () => {
    const conversationId = randomUUID();
    const turnId = randomUUID();
    const messageId = randomUUID();
    await conversations.create({
      _id: conversationId,
      userId: USER_ID,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await threads.insert({
      integrationSlug: "chatapp",
      externalKey: THREAD_KEY,
      conversationId,
      userId: USER_ID,
    });
    await store.appendMessage({
      id: messageId,
      businessId: DEPLOYMENT_BUSINESS_ID,
      conversationId,
      turnId,
      role: "user",
      content: textContent(CHAT.text),
      createdAt: NOW,
    });
    const turn: PersistedTurn = {
      id: turnId,
      businessId: DEPLOYMENT_BUSINESS_ID,
      conversationId,
      idempotencyKey: `${RUN_ID}:ingress`,
      requestMessageId: messageId,
      status: "running",
      attempt: 1,
      runId: RUN_ID,
      cursor: 0,
      supersededRunIds: [],
      createdAt: NOW,
      updatedAt: NOW,
    };
    await store.saveTurn(turn);

    await expect(host.attachChat(DEPLOYMENT_BUSINESS_ID, RUN_ID, CHAT)).resolves.toEqual({
      outcome: "attached",
      turnId,
      attempt: 1,
    });
    const derived = await artifacts.read({
      businessId: DEPLOYMENT_BUSINESS_ID,
      artifactId: chatRequestArtifactId(RUN_ID),
      reader: RUN_EXECUTOR_PRINCIPAL_REF,
      allowedClassifications: [],
      now: NOW,
    });
    expect(derived.schemaRef).toBe(CHAT_REQUEST_SCHEMA_REF);
    expect(await count("messages")).toBe(1);
    expect(await count("conversation_turns")).toBe(1);
  });
});
