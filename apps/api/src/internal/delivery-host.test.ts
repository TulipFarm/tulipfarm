import { EventEmitter } from "node:events";
import {
  ArtifactService,
  chatRequestArtifactId,
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
import type { SoulAgent, SoulIntegration, SoulLoader } from "@tulipfarm/soul";
import { DOMAIN_EVENTS, MemoryArtifactStore } from "@tulipfarm/storage";
import type { ToolDef } from "@tulipfarm/tool-host";
import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserDoc } from "../auth/users";
import type { ToolRegistry } from "../broker/tool-adapter";
import type { ConversationDoc } from "../chat/conversations";
import type { IngressIdentityResolver } from "../ingress/identity";
import type {
  IntegrationConversation,
  IntegrationConversationsRepo,
  IntegrationEventsRepo,
} from "../ingress/repo";
import { BUSINESS_ID, FakeConversationStore, fakeRuns, RUN_ID } from "../test/turn-host-fixtures";
import { declarativeToolName } from "../tools/declarative/tools";
import { DeliveryDeniedError, IngressDeliveryHost } from "./delivery-host";
import type { HostedRunReader } from "./turn-host";

const NOW = new Date("2026-07-28T09:00:00.000Z");
const SLUG = "chatapp";
const THREAD_KEY = "T1/C1/100.1";
const SENDER = "EXT-U1";
const HANDLER = { source: "({ classify() { return { kind: 'ignore' }; } })", hash: "hash-1" };
const BODY = { team: "T1", delivery_id: "D1", event: { channel: "C1", ts: "100.1" } };

const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as FastifyBaseLogger;

function user(id: string): UserDoc {
  return {
    _id: id,
    email: `${id}@example.com`,
    passwordHash: "x",
    name: null,
    role: "admin",
    status: "active",
    createdAt: NOW,
  };
}

/** One installed Integration, varying only what a test is about. */
function integration(
  options: {
    chat?: boolean;
    events?: string[] | false;
    enabled?: boolean;
    contextEnv?: string[];
    env?: Record<string, string>;
  } = {}
): SoulIntegration {
  return {
    slug: SLUG,
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
        ...(options.contextEnv === undefined ? {} : { context_env: options.contextEnv }),
        ...(options.chat === false
          ? {}
          : {
              chat: {
                thread_key: "{team}/{event.channel}/{event.thread_ts|event.ts}",
                reply: {
                  default: {
                    tool: "send_message",
                    args: { channel_id: "{channel}", text: "{text}" },
                  },
                },
              },
            }),
        ...(options.events === false
          ? {}
          : { events: { types: options.events ?? ["member_joined"] } }),
      },
    },
    connection: {
      enabled: options.enabled ?? true,
      env: { SECRET: "s", ...(options.env ?? {}) },
    },
    ingressHandler: HANDLER,
  } as SoulIntegration;
}

/** In-memory thread mappings — the same three operations the pg repo exposes. */
class FakeThreadsRepo {
  readonly rows = new Map<string, IntegrationConversation>();

  async find(slug: string, key: string): Promise<IntegrationConversation | null> {
    return this.rows.get(`${slug}:${key}`) ?? null;
  }

  async exists(slug: string, key: string): Promise<boolean> {
    return this.rows.has(`${slug}:${key}`);
  }

  async insert(doc: IntegrationConversation): Promise<IntegrationConversation> {
    const key = `${doc.integrationSlug}:${doc.externalKey}`;
    const existing = this.rows.get(key);
    if (existing) return existing;
    this.rows.set(key, doc);
    return doc;
  }
}

interface Harness {
  host: IngressDeliveryHost;
  store: FakeConversationStore;
  threads: FakeThreadsRepo;
  artifacts: ArtifactService;
  lineage: MemoryArtifactStore;
  conversations: ConversationDoc[];
  events: EventEmitter;
  recordedEvents: Array<Record<string, unknown>>;
  sent: Array<Record<string, unknown>>;
}

async function harness(
  options: {
    runs?: HostedRunReader;
    integration?: SoulIntegration | undefined;
    resolve?: IngressIdentityResolver["resolve"];
    envelope?: Record<string, unknown>;
    agents?: Map<string, SoulAgent>;
  } = {}
): Promise<Harness> {
  const lineage = new MemoryArtifactStore();
  const artifacts = new ArtifactService(
    lineage,
    new TypedOutputValidator(INVOCATION_REQUEST_SCHEMAS)
  );
  await artifacts.publish({
    id: requestArtifactId(RUN_ID),
    businessId: BUSINESS_ID,
    schemaRef: INTEGRATION_REQUEST_SCHEMA_REF,
    value: options.envelope ?? { slug: SLUG, body: BODY },
    storage: "inline",
    classification: [],
    acl: { readers: [RUN_EXECUTOR_PRINCIPAL_REF] },
    retention: { policy: "standard", expiresAt: null },
    redaction: { redactedPaths: [] },
    producer: { runId: RUN_ID, stateKey: "invoke", attempt: 0 },
    createdAt: NOW.toISOString(),
  });

  const store = new FakeConversationStore();
  const threads = new FakeThreadsRepo();
  const conversations: ConversationDoc[] = [];
  const recordedEvents: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];
  const events = new EventEmitter();

  const registry = {
    getAll: () => [
      {
        name: declarativeToolName(SLUG, "send_message"),
        tier: "integration",
        execute: async (args: Record<string, unknown>) => {
          sent.push(args);
          return { success: true as const, data: {} };
        },
      } as unknown as ToolDef,
    ],
  } as unknown as ToolRegistry;

  let ids = 0;
  const soul = {
    integrations: new Map([[SLUG, options.integration ?? integration()]]),
    agents: options.agents ?? new Map<string, SoulAgent>(),
  } as unknown as SoulLoader;

  const host = new IngressDeliveryHost({
    runs: options.runs ?? fakeRuns({ source: "integration" }),
    artifacts,
    store,
    conversations: {
      create: async (doc: ConversationDoc) => {
        conversations.push(doc);
      },
      findById: async (id: string) => conversations.find((doc) => doc._id === id) ?? null,
      deleteOwned: async (id: string, userId: string) => {
        const index = conversations.findIndex((doc) => doc._id === id && doc.userId === userId);
        if (index === -1) return "not_found" as const;
        conversations.splice(index, 1);
        return "deleted" as const;
      },
    },
    threads: threads as unknown as IntegrationConversationsRepo,
    integrationEvents: {
      insert: async (doc: Record<string, unknown>) => {
        recordedEvents.push(doc);
        return { id: `event-${recordedEvents.length}`, ...doc };
      },
    } as unknown as IntegrationEventsRepo,
    soulLoader: soul,
    identity: {
      resolve:
        options.resolve ??
        (async () => ({
          outcome: "linked",
          user: user("user-1"),
          principalKind: "user",
          principalId: "user-1",
          principalRef: "user:user-1",
        })),
    },
    toolRegistry: registry,
    domainEvents: events,
    bindLinkUrl: (token) => `https://web.example/link-channel?token=${token}`,
    log,
    newId: () => {
      ids += 1;
      return `id-${ids}`;
    },
    now: () => NOW,
  });

  return {
    host,
    store,
    threads,
    artifacts,
    lineage,
    conversations,
    events,
    recordedEvents,
    sent,
  };
}

const CHAT = {
  sender: SENDER,
  text: "summarize this",
  reply: { binding: "default", vars: { channel: "C1" } },
};

async function denial(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    if (error instanceof DeliveryDeniedError) return error.code;
    throw error;
  }
  throw new Error("expected a DeliveryDeniedError");
}

describe("IngressDeliveryHost.describe", () => {
  it("hands the worker the classifier, its hash, and what the manifest declares", async () => {
    const { host } = await harness();

    await expect(host.describe(BUSINESS_ID, RUN_ID)).resolves.toEqual({
      slug: SLUG,
      body: BODY,
      headers: {},
      classifier: HANDLER,
      hasThreadMapping: false,
      chatEnabled: true,
      eventsEnabled: true,
      env: {},
    });
  });

  it("forwards the context_env a classifier needs to recognise its own integration", async () => {
    const { host } = await harness({
      integration: integration({
        contextEnv: ["BOT_USERNAME"],
        env: { BOT_USERNAME: "tulipbot", UNDECLARED: "nope" },
      }),
    });

    await expect(host.describe(BUSINESS_ID, RUN_ID)).resolves.toMatchObject({
      env: { BOT_USERNAME: "tulipbot" },
    });
  });

  it("never forwards an unresolved secret reference to untrusted classifier code", async () => {
    const { host } = await harness({
      integration: integration({
        contextEnv: ["BOT_USERNAME"],
        env: { BOT_USERNAME: "secret://ref/1" },
      }),
    });

    await expect(host.describe(BUSINESS_ID, RUN_ID)).resolves.toMatchObject({ env: {} });
  });

  it("computes hasThreadMapping, which the isolate cannot look up for itself", async () => {
    const { host, threads } = await harness();
    await threads.insert({
      integrationSlug: SLUG,
      externalKey: THREAD_KEY,
      conversationId: "conversation-9",
      userId: "user-1",
    });

    await expect(host.describe(BUSINESS_ID, RUN_ID)).resolves.toMatchObject({
      hasThreadMapping: true,
    });
  });

  it("refuses a Run that is missing, not running, or not a delivery", async () => {
    const missing = await harness({ runs: fakeRuns(null) });
    expect(await denial(missing.host.describe(BUSINESS_ID, RUN_ID))).toBe("run_not_found");

    const done = await harness({ runs: fakeRuns({ status: "succeeded", source: "integration" }) });
    expect(await denial(done.host.describe(BUSINESS_ID, RUN_ID))).toBe("run_not_running");

    const chat = await harness({ runs: fakeRuns({ source: "chat" }) });
    expect(await denial(chat.host.describe(BUSINESS_ID, RUN_ID))).toBe("not_a_delivery");
  });

  it("refuses once the Integration is disconnected", async () => {
    const { host } = await harness({ integration: integration({ enabled: false }) });

    expect(await denial(host.describe(BUSINESS_ID, RUN_ID))).toBe("integration_unavailable");
  });
});

describe("IngressDeliveryHost.attachChat", () => {
  it("attaches the Turn to this Run and derives the chat request from the envelope", async () => {
    const { host, store, lineage, artifacts, threads, conversations } = await harness();

    const attached = await host.attachChat(BUSINESS_ID, RUN_ID, CHAT);

    expect(attached).toEqual({ outcome: "attached", turnId: expect.any(String), attempt: 1 });
    expect(store.turns).toHaveLength(1);
    expect(store.turns[0]).toMatchObject({ runId: RUN_ID, status: "running", attempt: 1 });
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]).toMatchObject({ role: "user", content: textContent(CHAT.text) });
    expect(conversations).toHaveLength(1);
    expect(await threads.find(SLUG, THREAD_KEY)).toMatchObject({ userId: "user-1" });

    const derived = await artifacts.read({
      businessId: BUSINESS_ID,
      artifactId: chatRequestArtifactId(RUN_ID),
      reader: RUN_EXECUTOR_PRINCIPAL_REF,
      allowedClassifications: [],
      now: NOW,
    });
    expect(derived.schemaRef).toBe(CHAT_REQUEST_SCHEMA_REF);
    expect(derived.content).toMatchObject({ message: { role: "user", content: CHAT.text } });

    // The one recorded chain that ties "what was the model asked?" to "which delivery asked it?".
    await expect(lineage.listLineage(BUSINESS_ID, chatRequestArtifactId(RUN_ID))).resolves.toEqual([
      expect.objectContaining({
        sourceArtifactId: requestArtifactId(RUN_ID),
        relation: "derived_from",
      }),
    ]);
  });

  // #431: the derived chat request used to carry a literal `autonomy: "full"`, which the Tool
  // dispatcher reads straight back out — so a Channel-delivered Turn ran above whatever ceiling
  // its Agent was configured with. The routed Agent now supplies both fields.
  it("carries the routed Agent's own autonomy into the derived chat request", async () => {
    const agents = new Map<string, SoulAgent>([
      ["mutator", { name: "mutator", frontmatter: { autonomy: "approval-required" }, body: "" }],
    ]);
    const { host, threads, conversations, artifacts } = await harness({ agents });
    conversations.push({
      _id: "conv-1",
      userId: "user-1",
      agentId: "mutator",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await threads.insert({
      integrationSlug: SLUG,
      externalKey: THREAD_KEY,
      conversationId: "conv-1",
      userId: "user-1",
    });

    await expect(host.attachChat(BUSINESS_ID, RUN_ID, CHAT)).resolves.toMatchObject({
      outcome: "attached",
    });

    const derived = await artifacts.read({
      businessId: BUSINESS_ID,
      artifactId: chatRequestArtifactId(RUN_ID),
      reader: RUN_EXECUTOR_PRINCIPAL_REF,
      allowedClassifications: [],
      now: NOW,
    });
    expect(derived.content).toMatchObject({
      agentId: "mutator",
      autonomy: "approval-required",
    });
  });

  it("claims no autonomy at all for a thread no Agent is pinned to", async () => {
    const { host, artifacts } = await harness();

    await host.attachChat(BUSINESS_ID, RUN_ID, CHAT);

    const derived = await artifacts.read({
      businessId: BUSINESS_ID,
      artifactId: chatRequestArtifactId(RUN_ID),
      reader: RUN_EXECUTOR_PRINCIPAL_REF,
      allowedClassifications: [],
      now: NOW,
    });
    expect((derived.content as { autonomy?: string }).autonomy).toBeUndefined();
  });

  it("is idempotent: a re-run attaches to the Turn it already started", async () => {
    const { host, store } = await harness();

    const first = await host.attachChat(BUSINESS_ID, RUN_ID, CHAT);
    const second = await host.attachChat(BUSINESS_ID, RUN_ID, CHAT);

    expect(second).toEqual(first);
    expect(store.messages).toHaveLength(1);
    expect(store.turns).toHaveLength(1);
  });

  it("reuses the Conversation an existing thread mapping names", async () => {
    const { host, store, threads, conversations } = await harness();
    await threads.insert({
      integrationSlug: SLUG,
      externalKey: THREAD_KEY,
      conversationId: "conversation-9",
      userId: "user-1",
    });

    await host.attachChat(BUSINESS_ID, RUN_ID, CHAT);

    expect(conversations).toHaveLength(0);
    expect(store.turns[0]?.conversationId).toBe("conversation-9");
  });

  it("routes onto the winner and drops the orphan when it loses the mapping race", async () => {
    const { host, store, threads, conversations } = await harness();
    // A concurrent first message already mapped this thread to its own Conversation, owned by the
    // same sender. Our `find` still reads null (the write lands in the gap), so we take the create
    // branch and must recover the winner from the conflicting insert.
    threads.rows.set(`${SLUG}:${THREAD_KEY}`, {
      integrationSlug: SLUG,
      externalKey: THREAD_KEY,
      conversationId: "winner-conv",
      userId: "user-1",
    });
    vi.spyOn(threads, "find").mockResolvedValueOnce(null);

    const attached = await host.attachChat(BUSINESS_ID, RUN_ID, CHAT);

    expect(attached).toMatchObject({ outcome: "attached" });
    expect(store.turns[0]?.conversationId).toBe("winner-conv");
    // The Conversation this call minted is gone; only the winner's mapping remains.
    expect(conversations).toHaveLength(0);
  });

  it("refuses the turn when the race winner belongs to a different sender", async () => {
    const { host, store, threads, conversations } = await harness();
    threads.rows.set(`${SLUG}:${THREAD_KEY}`, {
      integrationSlug: SLUG,
      externalKey: THREAD_KEY,
      conversationId: "winner-conv",
      userId: "user-2",
    });
    vi.spyOn(threads, "find").mockResolvedValueOnce(null);

    const attached = await host.attachChat(BUSINESS_ID, RUN_ID, CHAT);

    expect(attached).toEqual({ outcome: "ignored", reason: "sender_not_thread_owner" });
    expect(store.turns).toHaveLength(0);
    expect(conversations).toHaveLength(0);
  });

  it("runs no turn for an unlinked sender and offers the bind link itself", async () => {
    const { host, store, sent } = await harness({
      resolve: async () => ({
        outcome: "unlinked",
        bindOffer: { token: "tok-1", expiresAt: NOW },
      }),
    });

    const attached = await host.attachChat(BUSINESS_ID, RUN_ID, CHAT);

    expect(attached).toEqual({ outcome: "unlinked" });
    expect(store.turns).toHaveLength(0);
    expect(store.messages).toHaveLength(0);
    // The link is a credential: it is posted from this process and never returned to the caller.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("https://web.example/link-channel?token=tok-1");
    expect(JSON.stringify(attached)).not.toContain("tok-1");
  });

  it("denies without an offer when no bind link could be issued", async () => {
    const { host, sent } = await harness({
      resolve: async () => ({ outcome: "unlinked", bindOffer: null }),
    });

    await expect(host.attachChat(BUSINESS_ID, RUN_ID, CHAT)).resolves.toEqual({
      outcome: "unlinked",
    });
    expect(sent).toHaveLength(0);
  });

  it("refuses a verified sender who does not own the mapped Conversation", async () => {
    const { host, store, threads } = await harness();
    await threads.insert({
      integrationSlug: SLUG,
      externalKey: THREAD_KEY,
      conversationId: "conversation-9",
      userId: "someone-else",
    });

    await expect(host.attachChat(BUSINESS_ID, RUN_ID, CHAT)).resolves.toEqual({
      outcome: "ignored",
      reason: "sender_not_thread_owner",
    });
    expect(store.turns).toHaveLength(0);
  });

  it("honours requireExistingThread when the thread is unmapped", async () => {
    const { host, store } = await harness();

    await expect(
      host.attachChat(BUSINESS_ID, RUN_ID, { ...CHAT, requireExistingThread: true })
    ).resolves.toEqual({ outcome: "ignored", reason: "no_thread_mapping" });
    expect(store.turns).toHaveLength(0);
  });

  it("ignores a chat decision from a manifest that declares no chat", async () => {
    const { host } = await harness({ integration: integration({ chat: false }) });

    await expect(host.attachChat(BUSINESS_ID, RUN_ID, CHAT)).resolves.toEqual({
      outcome: "ignored",
      reason: "chat_not_declared",
    });
  });
});

describe("IngressDeliveryHost.recordEvent", () => {
  it("records an allowlisted event and fans it out to Routine triggers", async () => {
    const { host, events, recordedEvents } = await harness();
    const emitted: unknown[] = [];
    events.on(DOMAIN_EVENTS.INTEGRATION_EVENT, (payload: unknown) => emitted.push(payload));

    await expect(
      host.recordEvent(BUSINESS_ID, RUN_ID, { eventType: "member_joined", payload: { user: "U2" } })
    ).resolves.toEqual({ outcome: "recorded", eventId: "event-1" });

    expect(recordedEvents[0]).toMatchObject({
      integrationSlug: SLUG,
      eventType: "member_joined",
      externalId: "D1",
      payload: { user: "U2" },
    });
    expect(emitted).toEqual([
      expect.objectContaining({ integration: SLUG, event: "member_joined", eventId: "event-1" }),
    ]);
  });

  it("ignores an event type the manifest does not name", async () => {
    const { host, recordedEvents } = await harness();

    await expect(
      host.recordEvent(BUSINESS_ID, RUN_ID, { eventType: "message_deleted" })
    ).resolves.toEqual({ outcome: "ignored", reason: "event_type_not_allowlisted" });
    expect(recordedEvents).toHaveLength(0);
  });

  it("ignores every event when the manifest declares none", async () => {
    const { host } = await harness({ integration: integration({ events: false }) });

    await expect(
      host.recordEvent(BUSINESS_ID, RUN_ID, { eventType: "member_joined" })
    ).resolves.toEqual({ outcome: "ignored", reason: "events_not_declared" });
  });
});

describe("IngressDeliveryHost.postReplyForAttempt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts the assistant Message the attempt's completion names", async () => {
    const { host, store, sent } = await harness();
    const attached = await host.attachChat(BUSINESS_ID, RUN_ID, CHAT);
    if (attached.outcome !== "attached") throw new Error("expected the chat to attach");
    store.messages.push({
      id: "answer-1",
      businessId: BUSINESS_ID,
      conversationId: store.turns[0]?.conversationId ?? "",
      turnId: attached.turnId,
      role: "assistant",
      content: textContent("  Here is your answer  "),
      createdAt: NOW,
    });
    await store.completeTurn({
      completion: {
        businessId: BUSINESS_ID,
        turnId: attached.turnId,
        attempt: 1,
        status: "succeeded",
        messageId: "answer-1",
        cursor: 1,
        createdAt: NOW,
      },
    });

    await expect(
      host.postReplyForAttempt(BUSINESS_ID, RUN_ID, {
        attempt: 1,
        outcome: "answered",
        binding: "default",
        vars: { channel: "C1" },
      })
    ).resolves.toEqual({ delivered: true });

    expect(sent).toEqual([{ channel_id: "C1", text: "Here is your answer" }]);
  });

  it("substitutes a fixed reply when the turn produced no answer", async () => {
    const { host, sent } = await harness();
    await host.attachChat(BUSINESS_ID, RUN_ID, CHAT);

    await host.postReplyForAttempt(BUSINESS_ID, RUN_ID, {
      attempt: 1,
      outcome: "blocked",
      binding: "default",
      vars: { channel: "C1" },
    });
    await host.postReplyForAttempt(BUSINESS_ID, RUN_ID, {
      attempt: 1,
      outcome: "failed",
      binding: "default",
      vars: { channel: "C1" },
    });

    // Two fixed sentences, chosen here — the worker never supplies wording.
    expect(sent.map((call) => call.text)).toEqual([
      "I can't help with that request.",
      "Something went wrong handling that — please try again.",
    ]);
  });

  it("posts nothing when the Run never attached a Turn", async () => {
    const { host, sent } = await harness();

    await expect(
      host.postReplyForAttempt(BUSINESS_ID, RUN_ID, {
        attempt: 1,
        outcome: "answered",
        binding: "default",
      })
    ).resolves.toEqual({ delivered: false });
    expect(sent).toHaveLength(0);
  });
});
