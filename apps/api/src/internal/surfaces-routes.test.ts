import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { Type } from "@sinclair/typebox";
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { runPgMigrations } from "../pg-migrate";
import { MemorySurfaceActionStore } from "../surfaces/action-store";
import { MemorySurfaceArtifactStore } from "../surfaces/artifact-store";
import { makePglite } from "../test/pglite";
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

describe("POST /api/v1/internal/surfaces/interactions", () => {
  let app: FastifyInstance;
  let db: PGlite;
  let workerCredential: string;
  let slackUser: UserDoc;
  let sessionCookie: string;
  let mappings: MemoryExternalIdentityRepo;
  let surfaceActionStore: MemorySurfaceActionStore;
  let surfaceArtifactStore: MemorySurfaceArtifactStore;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    const transactions = transactionPort(db as unknown as Queryable);

    const sessions = new MemorySessionStore();
    const userRepo = new PgUserRepo(db as unknown as Queryable);
    const admin = await createUser(userRepo, "admin@example.com", "pass", "admin");
    sessionCookie = await sessions.create(admin._id);
    slackUser = await createUser(userRepo, "slack-user@example.com", "pass", "member");

    const apiClientRepo = new MemoryApiClientRepo();
    const { doc, secret } = await createApiClient(apiClientRepo, {
      name: "integration-worker",
      ownerUserId: admin._id,
    });
    workerCredential = formatApiClientCredential(doc.clientId, secret);

    mappings = new MemoryExternalIdentityRepo();
    await mappings.upsertMapping({
      provider: "slack",
      externalSubject: "U-LINKED",
      userId: slackUser._id,
      verifiedAt: new Date(),
      expiresAt: null,
      verifiedVia: "manifest_email",
    });

    const runs = new RunStore(transactions);
    const toolApprovals = new ToolApprovalService({
      repo: new ApprovalsRepo(db),
      waits: new DurableWaitManager(new WaitStore(transactions), new RunResumeGateway(runs)),
    });
    surfaceActionStore = new MemorySurfaceActionStore();
    surfaceArtifactStore = new MemorySurfaceArtifactStore();

    app = await buildApp({
      sessionStore: sessions,
      userRepo,
      tokenRepo: new FakeTokenRepo(),
      identity: { apiClientRepo },
      toolApprovals,
      channels: () => ({
        store: new FakeConversationStore(),
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
        runDeliveries: new ChannelRunDeliveryStore(transactions, () => new Date().toISOString()),
        toolApprovals,
        surfaceStore: surfaceArtifactStore,
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

  async function mintHandle() {
    const artifact = createSurfaceArtifact({
      id: "artifact-1",
      component: { name: "Actions", version: "1.0" },
      props: { actions: [{ label: "Approve", action: { event: "record.approve" } }] },
      target: { channel: "slack", surface: "message" },
      audience: [slackUser._id],
      classification: "internal",
    });
    await surfaceArtifactStore.create(artifact, { runId: "run-1" });
    return surfaceActionStore.create({
      artifactId: artifact.id,
      revision: artifact.revision,
      inputSchema: Type.Object({}),
      audience: [slackUser._id],
      target: artifact.target,
      destination: "C-OPS",
      conversationId: null,
      runId: "run-1",
      waitId: null,
      guardrailRevision: "none",
      expiresAt: new Date(Date.now() + 60_000),
      action: { event: "record.approve" },
    });
  }

  it("refuses a signed-in person", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/internal/surfaces/interactions",
      cookies: { [SESSION_COOKIE]: sessionCookie, [CSRF_COOKIE]: TEST_CSRF },
      headers: { "x-csrf-token": TEST_CSRF },
      payload: { handle: "sf_x", provider: "slack", externalSubject: "U-LINKED", input: {} },
    });
    expect(res.statusCode).toBe(403);
  });

  it("resolves a linked sender's click to the Surface interaction", async () => {
    const handle = await mintHandle();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/internal/surfaces/interactions",
      headers: asWorker(),
      payload: {
        handle: handle.handle,
        provider: "slack",
        externalSubject: "U-LINKED",
        input: {},
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.artifactId).toBe("artifact-1");
    expect(body.principal).toBe(slackUser._id);
  });

  it("proxies the store's denial code for an unmapped sender", async () => {
    const handle = await mintHandle();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/internal/surfaces/interactions",
      headers: asWorker(),
      payload: {
        handle: handle.handle,
        provider: "slack",
        externalSubject: "U-UNKNOWN",
        input: {},
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("wrong_principal");
  });

  it("proxies the store's denial code for an unknown handle", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/internal/surfaces/interactions",
      headers: asWorker(),
      payload: { handle: "sf_missing", provider: "slack", externalSubject: "U-LINKED", input: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("not_found");
  });

  it("requires a credential at all", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/internal/surfaces/interactions",
      payload: { handle: "sf_x", provider: "slack", externalSubject: "U-LINKED", input: {} },
    });
    expect(res.statusCode).toBe(401);
  });
});
