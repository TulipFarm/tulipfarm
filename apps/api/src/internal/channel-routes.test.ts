import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import {
  DurableInvocationGateway,
  DurableWaitManager,
  RunResumeGateway,
  TypedOutputValidator,
} from "@tulipfarm/run-kernel";
import { INVOCATION_REQUEST_SCHEMAS } from "@tulipfarm/schema";
import { ChannelRunDeliveryStore, RunStore, WaitStore } from "@tulipfarm/storage";
import { createSurfaceArtifact } from "@tulipfarm/surface";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app";
import { ApprovalsRepo } from "../approvals/runtime-repo";
import { ToolApprovalService } from "../approvals/tool-approvals";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/routes";
import { MemorySessionStore } from "../auth/session-store";
import type { IngressUserLookup } from "../auth/users";
import { createUser, PgUserRepo, type UserDoc } from "../auth/users";
import { PgConversationRepo } from "../chat/conversations";
import { type Queryable, transactionPort } from "../db";
import { createApiClient, formatApiClientCredential } from "../identity/api-clients";
import { MemoryApiClientRepo, MemoryExternalIdentityRepo } from "../identity/fakes";
import { IngressIdentityResolver } from "../ingress/identity";
import { IntegrationConversationsRepo } from "../ingress/repo";
import { MemorySurfaceActionStore } from "../surfaces/action-store";
import { MemorySurfaceArtifactStore } from "../surfaces/artifact-store";
import { makeMigratedPglite } from "../test/pglite";
import { FakeConversationStore } from "../test/turn-host-fixtures";

const TEST_CSRF = "a".repeat(64);

class FakeTokenRepo implements TokenRepo {
  async create(): Promise<void> {}
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
  async findAllPaginated() {
    return { items: [], nextCursor: null };
  }
  async findByUserIdPaginated() {
    return { items: [], nextCursor: null };
  }
}

function makeUsers(users: UserDoc[]): IngressUserLookup {
  return {
    findByEmail: async (email: string) => users.find((user) => user.email === email) ?? null,
    findById: async (id: string) => users.find((user) => user._id === id) ?? null,
    findFirstAdmin: async () => users.find((user) => user.role === "admin") ?? null,
  };
}

describe("/api/v1/internal/channels", () => {
  let app: FastifyInstance;
  let db: PGlite;
  let workerCredential: string;
  let store: FakeConversationStore;
  let mappings: MemoryExternalIdentityRepo;
  let toolApprovals: ToolApprovalService;
  let runs: RunStore;
  let slackUser: UserDoc;
  let sessionCookie: string;
  let apiClientRepo: MemoryApiClientRepo;
  let runDeliveries: ChannelRunDeliveryStore;
  let surfaceStore: MemorySurfaceArtifactStore;
  let surfaceActionStore: MemorySurfaceActionStore;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    const transactions = transactionPort(db as unknown as Queryable);

    const sessions = new MemorySessionStore();
    const userRepo = new PgUserRepo(db as unknown as Queryable);
    const admin = await createUser(userRepo, "admin@example.com", "pass", "admin");
    sessionCookie = await sessions.create(admin._id);
    slackUser = await createUser(userRepo, "slack-user@example.com", "pass", "member");

    apiClientRepo = new MemoryApiClientRepo();
    const { doc, secret } = await createApiClient(apiClientRepo, {
      name: "integration-worker",
      ownerUserId: admin._id,
    });
    workerCredential = formatApiClientCredential(doc.clientId, secret);

    store = new FakeConversationStore();
    mappings = new MemoryExternalIdentityRepo();
    await mappings.upsertMapping({
      provider: "slack",
      externalSubject: "U-LINKED",
      userId: slackUser._id,
      verifiedAt: new Date(),
      expiresAt: null,
      verifiedVia: "manifest_email",
    });

    runs = new RunStore(transactions);
    toolApprovals = new ToolApprovalService({
      repo: new ApprovalsRepo(db),
      waits: new DurableWaitManager(new WaitStore(transactions), new RunResumeGateway(runs)),
    });
    runDeliveries = new ChannelRunDeliveryStore(transactions, () => new Date().toISOString());
    surfaceStore = new MemorySurfaceArtifactStore();
    surfaceActionStore = new MemorySurfaceActionStore();

    app = await buildApp({
      sessionStore: sessions,
      userRepo,
      tokenRepo: new FakeTokenRepo(),
      identity: { apiClientRepo },
      toolApprovals,
      channels: () => ({
        store,
        invocations: new DurableInvocationGateway({
          store: {
            persist: async (record) => ({ outcome: "started", runId: record.runId }),
          },
          validator: new TypedOutputValidator(INVOCATION_REQUEST_SCHEMAS),
          nextId: () => randomUUID(),
        }),
        conversations: new PgConversationRepo(db as unknown as Queryable),
        threads: new IntegrationConversationsRepo(db as unknown as Queryable),
        identity: new IngressIdentityResolver({
          users: makeUsers([admin, slackUser]),
          log: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} } as never,
          mappings,
        }),
        runDeliveries,
        toolApprovals,
        surfaceStore,
        surfaceActionStore,
        bindLinkUrl: (token) => `http://localhost:4000/link-channel?token=${token}`,
      }),
    });
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  const asWorker = () => ({ authorization: `Bearer ${workerCredential}` });

  describe("POST /identity/resolve", () => {
    it("resolves a linked sender to its own principal", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/internal/channels/identity/resolve",
        headers: asWorker(),
        payload: { provider: "slack", externalSubject: "U-LINKED" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        linked: true,
        principal: { kind: "user", id: slackUser._id },
      });
    });

    it("never hands a worker the bind link for an unmapped sender", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/internal/channels/identity/resolve",
        headers: asWorker(),
        payload: { provider: "slack", externalSubject: "U-UNKNOWN" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ linked: false });
    });

    it("refuses a signed-in person", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/internal/channels/identity/resolve",
        cookies: { [SESSION_COOKIE]: sessionCookie, [CSRF_COOKIE]: TEST_CSRF },
        headers: { "x-csrf-token": TEST_CSRF },
        payload: { provider: "slack", externalSubject: "U-LINKED" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("requires a credential at all", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/internal/channels/identity/resolve",
        payload: { provider: "slack", externalSubject: "U-LINKED" },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("POST /identity/bind-offer", () => {
    it("reports no_offer for an already-linked sender", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/internal/channels/identity/bind-offer",
        headers: asWorker(),
        payload: { provider: "slack", externalSubject: "U-LINKED", channelId: "C1" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ outcome: "no_offer" });
    });

    it("reports unconfigured for an unmapped sender when no bind offer is available", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/internal/channels/identity/bind-offer",
        headers: asWorker(),
        payload: { provider: "slack", externalSubject: "U-UNKNOWN", channelId: "C1" },
      });
      expect(res.statusCode).toBe(200);
      // No `bind` config on this app's identity resolver, so no offer is minted at all.
      expect(res.json()).toEqual({ outcome: "no_offer" });
    });

    it("posts a Slack reply with the bind link and never returns the token", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      try {
        const withBind = await buildApp({
          sessionStore: new MemorySessionStore(),
          userRepo: new PgUserRepo(db as unknown as Queryable),
          tokenRepo: new FakeTokenRepo(),
          identity: { apiClientRepo },
          toolApprovals,
          channels: () => ({
            store,
            invocations: new DurableInvocationGateway({
              store: { persist: async (record) => ({ outcome: "started", runId: record.runId }) },
              validator: new TypedOutputValidator(INVOCATION_REQUEST_SCHEMAS),
              nextId: () => randomUUID(),
            }),
            conversations: new PgConversationRepo(db as unknown as Queryable),
            threads: new IntegrationConversationsRepo(db as unknown as Queryable),
            identity: new IngressIdentityResolver({
              users: makeUsers([slackUser]),
              log: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} } as never,
              mappings,
              bind: { repo: mappings, signingKey: async () => Buffer.from("test-signing-key") },
            }),
            runDeliveries: new ChannelRunDeliveryStore(
              transactionPort(db as unknown as Queryable),
              () => new Date().toISOString()
            ),
            toolApprovals,
            secrets: {
              get: async (key: string) =>
                key === "integration.slack.SLACK_BOT_TOKEN" ? "xoxb-secret" : "xapp-secret",
            },
            bindLinkUrl: (token) => `http://localhost:4000/link-channel?token=${token}`,
          }),
        });
        try {
          const res = await withBind.inject({
            method: "POST",
            url: "/api/v1/internal/channels/identity/bind-offer",
            headers: asWorker(),
            payload: {
              provider: "slack",
              externalSubject: "U-NEW",
              channelId: "C1",
              threadId: "1.1",
            },
          });
          expect(res.statusCode).toBe(200);
          expect(res.json()).toEqual({ outcome: "sent" });

          expect(fetchSpy).toHaveBeenCalledTimes(1);
          const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
          expect(url).toBe("https://slack.com/api/chat.postEphemeral");
          expect(init.headers).toMatchObject({ authorization: "Bearer xoxb-secret" });
          const sentBody = JSON.parse(init.body as string) as {
            channel: string;
            user: string;
            thread_ts: string;
            text: string;
            blocks: Array<{
              type: string;
              elements?: Array<{ url?: string }>;
            }>;
          };
          expect(sentBody.channel).toBe("C1");
          expect(sentBody.user).toBe("U-NEW");
          expect(sentBody.thread_ts).toBe("1.1");
          expect(sentBody.text).not.toContain("test-signing-key");
          const buttonUrl = sentBody.blocks.find((b) => b.type === "actions")?.elements?.[0]?.url;
          expect(buttonUrl).toContain("/link-channel?token=");
          expect(buttonUrl).not.toContain("test-signing-key");
        } finally {
          await withBind.close();
        }
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  describe("POST /runs", () => {
    const runBody = () => ({
      eventId: randomUUID(),
      provider: "slack",
      integrationId: "integration-1",
      routeId: "route-1",
      agentId: "assistant",
      principal: { kind: "user" as const, id: slackUser._id },
      message: { externalAppId: "A1", channelId: "C1", threadId: "1720000000.000100", text: "hi" },
    });

    it("mints a Run, a Conversation, and the delivery correlation row", async () => {
      const body = runBody();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/internal/channels/runs",
        headers: asWorker(),
        payload: body,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ outcome: "started" });
      expect(store.turns).toHaveLength(1);
      expect(store.messages[0]?.content).toBe("hi");
    });

    it("resolves a redelivered event to the same Run instead of answering twice", async () => {
      const body = runBody();
      const first = await app.inject({
        method: "POST",
        url: "/api/v1/internal/channels/runs",
        headers: asWorker(),
        payload: body,
      });
      const second = await app.inject({
        method: "POST",
        url: "/api/v1/internal/channels/runs",
        headers: asWorker(),
        payload: body,
      });

      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual({ runId: first.json().runId, outcome: "duplicate" });
      expect(store.turns).toHaveLength(1);
    });

    it("maps the same external thread to the same Conversation across messages", async () => {
      const first = runBody();
      await app.inject({
        method: "POST",
        url: "/api/v1/internal/channels/runs",
        headers: asWorker(),
        payload: first,
      });

      const second = { ...runBody(), message: { ...first.message, text: "again" } };
      await app.inject({
        method: "POST",
        url: "/api/v1/internal/channels/runs",
        headers: asWorker(),
        payload: second,
      });

      expect(store.turns).toHaveLength(2);
      expect(store.turns[0]?.conversationId).toBe(store.turns[1]?.conversationId);
    });
  });

  describe("GET /runs/:runId/reply", () => {
    it("is pending before the Turn completes", async () => {
      store.turns.push({
        id: "turn-1",
        businessId: DEPLOYMENT_BUSINESS_ID,
        conversationId: "conversation-1",
        idempotencyKey: "key-1",
        requestMessageId: "message-1",
        status: "running",
        attempt: 1,
        runId: "run-1",
        cursor: 0,
        supersededRunIds: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/internal/channels/runs/run-1/reply",
        headers: asWorker(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "pending" });
    });

    it("reads the answer out of the durable conversation once succeeded", async () => {
      store.turns.push({
        id: "turn-1",
        businessId: DEPLOYMENT_BUSINESS_ID,
        conversationId: "conversation-1",
        idempotencyKey: "key-1",
        requestMessageId: "message-1",
        status: "succeeded",
        attempt: 1,
        runId: "run-1",
        cursor: 0,
        supersededRunIds: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      store.messages.push({
        id: "message-2",
        businessId: DEPLOYMENT_BUSINESS_ID,
        conversationId: "conversation-1",
        turnId: "turn-1",
        role: "assistant",
        content: "  the answer  ",
        createdAt: new Date(),
      });
      store.completions.push({
        businessId: DEPLOYMENT_BUSINESS_ID,
        turnId: "turn-1",
        attempt: 1,
        status: "succeeded",
        messageId: "message-2",
        cursor: 0,
        createdAt: new Date(),
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/internal/channels/runs/run-1/reply",
        headers: asWorker(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "succeeded", text: "the answer" });
    });

    it("includes rendered Slack blocks when a Surface Artifact was presented for the Run", async () => {
      store.turns.push({
        id: "turn-1",
        businessId: DEPLOYMENT_BUSINESS_ID,
        conversationId: "conversation-1",
        idempotencyKey: "key-1",
        requestMessageId: "message-1",
        status: "succeeded",
        attempt: 1,
        runId: "run-1",
        cursor: 0,
        supersededRunIds: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      store.messages.push({
        id: "message-2",
        businessId: DEPLOYMENT_BUSINESS_ID,
        conversationId: "conversation-1",
        turnId: "turn-1",
        role: "assistant",
        content: "the answer",
        createdAt: new Date(),
      });
      store.completions.push({
        businessId: DEPLOYMENT_BUSINESS_ID,
        turnId: "turn-1",
        attempt: 1,
        status: "succeeded",
        messageId: "message-2",
        cursor: 0,
        createdAt: new Date(),
      });
      await runDeliveries.create({
        businessId: DEPLOYMENT_BUSINESS_ID,
        runId: "run-1",
        integrationId: "integration-1",
        routeId: "route-1",
        provider: "slack",
        destination: "C-OPS",
        agentId: "agent-1",
        principalId: slackUser._id,
        idempotencyKey: "key-1",
      });
      const artifact = createSurfaceArtifact({
        id: "artifact-1",
        component: { name: "Text", version: "1.0" },
        props: { text: "hello" },
        target: { channel: "slack", surface: "message" },
        catalogRevision: "rev-1",
        audience: [slackUser._id],
        classification: "internal",
      });
      await surfaceStore.create(artifact, { runId: "run-1", stateKey: "conversation-1" });

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/internal/channels/runs/run-1/reply",
        headers: asWorker(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("succeeded");
      expect(Array.isArray(body.blocks)).toBe(true);
      expect(body.blocks.length).toBeGreaterThan(0);
    });

    it("resolves the default assistant's human label, never its internal slug", async () => {
      const conversationId = "11111111-1111-1111-1111-111111111111";
      const conversations = new PgConversationRepo(db as unknown as Queryable);
      await conversations.create({
        _id: conversationId,
        agentId: "__tulipfarm_default__",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      store.turns.push({
        id: "turn-1",
        businessId: DEPLOYMENT_BUSINESS_ID,
        conversationId,
        idempotencyKey: "key-1",
        requestMessageId: "message-1",
        status: "succeeded",
        attempt: 1,
        runId: "run-1",
        cursor: 0,
        supersededRunIds: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      store.messages.push({
        id: "message-2",
        businessId: DEPLOYMENT_BUSINESS_ID,
        conversationId,
        turnId: "turn-1",
        role: "assistant",
        content: "the answer",
        createdAt: new Date(),
      });
      store.completions.push({
        businessId: DEPLOYMENT_BUSINESS_ID,
        turnId: "turn-1",
        attempt: 1,
        status: "succeeded",
        messageId: "message-2",
        cursor: 0,
        createdAt: new Date(),
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/internal/channels/runs/run-1/reply",
        headers: asWorker(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: "succeeded",
        text: "the answer",
        agentDisplayName: "TulipFarm Assistant",
      });
    });

    it("404s an unknown Run", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/internal/channels/runs/run-missing/reply",
        headers: asWorker(),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("GET /runs/:runId/pending-approval", () => {
    it("reports no pending approval for a Run that has none", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/internal/channels/runs/run-none/pending-approval",
        headers: asWorker(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ pending: false });
    });

    it("reports the open approval a Run is parked on", async () => {
      const runId = randomUUID();
      const decision = await toolApprovals.decide({
        businessId: DEPLOYMENT_BUSINESS_ID,
        runId,
        toolCallId: "call-1",
        toolName: "record_delete",
        args: { id: "record-1" },
      });
      if (decision.status !== "pending") throw new Error("expected a pending approval");

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/internal/channels/runs/${runId}/pending-approval`,
        headers: asWorker(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        pending: true,
        approvalId: decision.approvalId,
        toolName: "record_delete",
        args: { id: "record-1" },
      });
    });
  });

  describe("POST /approvals/:approvalId/decide", () => {
    it("reports unlinked without exposing a bind offer", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/internal/channels/approvals/approval-1/decide",
        headers: asWorker(),
        payload: { provider: "slack", externalSubject: "U-UNKNOWN", decision: "approved" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ outcome: "unlinked" });
    });

    it("resolves the clicking sender's own identity and signals the parked wait", async () => {
      const runId = randomUUID();
      await runs.start({
        id: runId,
        businessId: DEPLOYMENT_BUSINESS_ID,
        source: "chat",
        createdAt: new Date().toISOString(),
        bundle: { digest: "bundle-digest", routineId: "chat", routineVersion: "1" },
        identity: {
          initiator: { kind: "user", id: slackUser._id },
          effectiveSubject: { kind: "user", id: slackUser._id },
          guardrailContextRef: "guardrails:1",
        },
        bounds: { wallTimeMs: 60_000, activeTimeMs: 60_000, attempts: 1, sideEffects: 8 },
        states: [
          {
            key: "invoke",
            definitionRef: "published:agent:assistant",
            resolvedInput: { payloadRef: `artifact:${runId}:request` },
          },
        ],
      });
      const decision = await toolApprovals.decide({
        businessId: DEPLOYMENT_BUSINESS_ID,
        runId,
        toolCallId: "call-1",
        toolName: "record_delete",
        args: { id: "record-1" },
      });
      if (decision.status !== "pending") throw new Error("expected a pending approval");
      await toolApprovals.registerWait({
        businessId: DEPLOYMENT_BUSINESS_ID,
        runId,
        stateKey: "invoke",
        approvalId: decision.approvalId,
        subject: { kind: "user", id: slackUser._id },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/internal/channels/approvals/${decision.approvalId}/decide`,
        headers: asWorker(),
        payload: { provider: "slack", externalSubject: "U-LINKED", decision: "approved" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ outcome: "resumed" });
    });
  });

  describe("GET /slack/credential", () => {
    it("reports unconfigured when no secrets store is wired", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/internal/channels/slack/credential",
        headers: asWorker(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ configured: false });
    });

    it("resolves both tokens once sealed at connect time", async () => {
      const secretValues = new Map([
        ["integration.slack.SLACK_BOT_TOKEN", "xoxb-secret"],
        ["integration.slack.SLACK_APP_TOKEN", "xapp-secret"],
      ]);
      const withSecrets = await buildApp({
        sessionStore: new MemorySessionStore(),
        userRepo: new PgUserRepo(db as unknown as Queryable),
        tokenRepo: new FakeTokenRepo(),
        identity: { apiClientRepo },
        toolApprovals,
        channels: () => ({
          store,
          invocations: new DurableInvocationGateway({
            store: { persist: async (record) => ({ outcome: "started", runId: record.runId }) },
            validator: new TypedOutputValidator(INVOCATION_REQUEST_SCHEMAS),
            nextId: () => randomUUID(),
          }),
          conversations: new PgConversationRepo(db as unknown as Queryable),
          threads: new IntegrationConversationsRepo(db as unknown as Queryable),
          identity: new IngressIdentityResolver({
            users: makeUsers([slackUser]),
            log: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} } as never,
            mappings,
          }),
          runDeliveries: new ChannelRunDeliveryStore(
            transactionPort(db as unknown as Queryable),
            () => new Date().toISOString()
          ),
          toolApprovals,
          secrets: {
            get: async (key: string) => {
              const value = secretValues.get(key);
              if (value === undefined) throw new Error(`no secret for ${key}`);
              return value;
            },
          },
          bindLinkUrl: (token) => `http://localhost:4000/link-channel?token=${token}`,
        }),
      });
      try {
        const res = await withSecrets.inject({
          method: "GET",
          url: "/api/v1/internal/channels/slack/credential",
          headers: asWorker(),
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
          configured: true,
          botToken: "xoxb-secret",
          appToken: "xapp-secret",
        });
      } finally {
        await withSecrets.close();
      }
    });
  });
});
