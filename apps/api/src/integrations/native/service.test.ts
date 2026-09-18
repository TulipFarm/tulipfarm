import {
  DurableInvocationGateway,
  type DurableInvocationRecord,
  TypedOutputValidator,
} from "@tulipfarm/run-kernel";
import { INVOCATION_REQUEST_SCHEMAS, MANUAL_REQUEST_SCHEMA_REF } from "@tulipfarm/schema";
import type {
  NativeChannelInboxInput,
  NativeChannelInboxRecord,
  NativeChannelRoutineRoute,
  PersistedRoutingSnapshot,
  Queryable,
  TransactionPort,
} from "@tulipfarm/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type NativeChannelDeps, NativeChannelService } from "./service";

const submit = vi.hoisted(() => vi.fn());
const submitter = vi.hoisted(() => vi.fn(() => ({ submit })));
vi.mock("../../chat/turn-submit", () => ({ durableTurnSubmitter: submitter }));

function fixture(withGrant = true, overrides: Partial<NativeChannelDeps> = {}) {
  let accepted: NativeChannelInboxRecord | undefined;
  const snapshot: PersistedRoutingSnapshot = {
    apps: [
      {
        id: "app",
        businessId: "business",
        provider: "slack",
        externalAppId: "A1",
        credentialRefs: ["secret://native-bot"],
        status: "active",
      },
    ],
    integrations: [
      {
        id: "installation",
        businessId: "business",
        appId: "app",
        externalTenantId: "T1",
        status: "active",
      },
    ],
    routes: [
      {
        id: "route",
        businessId: "business",
        integrationId: "installation",
        agentId: "assistant",
        channelId: "C1",
        threadId: null,
        eventTypes: ["message"],
        priority: 1,
        status: "active",
      },
    ],
    accessGrants: withGrant
      ? [
          {
            id: "route",
            businessId: "business",
            integrationId: "installation",
            status: "active",
            definition: {
              metadata: { id: "route" },
              spec: {
                integrationId: "installation",
                principals: [{ kind: "user", id: "muskan" }],
                actions: ["channels.message.receive", "channels.message.send"],
                externalTargets: [{ type: "slack.channel", ids: ["C1"] }],
              },
            },
          },
        ]
      : [],
  };
  const identity = vi.fn().mockResolvedValue({
    outcome: "linked",
    principalKind: "user",
    principalId: "muskan",
  });
  const bindRun = vi.fn(async (_event: NativeChannelInboxRecord, runId: string) => {
    if (accepted) accepted = { ...accepted, runId };
  });
  const createDelivery = vi.fn();
  const finish = vi.fn().mockResolvedValue(true);
  const deps = {
    businessId: "business",
    credentials: { assertEnabled: vi.fn() },
    integrations: { loadRoutingSnapshot: vi.fn(async () => snapshot) },
    inbox: {
      accept: vi.fn(async (input: NativeChannelInboxInput) => {
        accepted = {
          ...input,
          status: "dispatching",
          attempts: 1,
          leaseToken: "lease",
          leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
          runId: null,
        };
        return { outcome: "accepted", event: accepted };
      }),
      claim: vi.fn(async () => (accepted ? [accepted] : [])),
      find: vi.fn(async () => accepted),
      assertClaim: vi.fn(),
      bindRun,
      finish,
      routineRoutes: vi.fn(async () => []),
    },
    identity: { resolve: identity },
    inbound: { accept: vi.fn(async () => ({ outcome: "accepted" })) },
    mentionedThreads: { mark: vi.fn() },
    threads: {
      find: vi.fn(async () => ({
        conversationId: "chat-muskan",
        userId: "muskan",
      })),
    },
    runDeliveries: {
      create: createDelivery,
      find: vi.fn(async () => ({
        integrationId: "installation",
        routeId: "route",
        provider: "slack",
        agentId: "assistant",
        destination: "C1",
        threadId: "100.1",
        principalId: "original-owner",
      })),
    },
    mayUseAgent: vi.fn(async () => true),
    log: {},
    ...overrides,
  } as unknown as NativeChannelDeps;
  const service = new NativeChannelService(deps);
  const accept = () =>
    service.acceptSocketEnvelope({
      type: "event_callback",
      api_app_id: "A1",
      team_id: "T1",
      event_id: "event-1",
      event_time: 100,
      event: { type: "app_mention", user: "U1", channel: "C1", ts: "100.1", text: "Please help" },
    });
  return {
    service,
    accept,
    identity,
    snapshot,
    bindRun,
    createDelivery,
    finish,
    event: () => accepted,
  };
}

describe("native channel durable dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    submit.mockResolvedValue({
      outcome: "submitted",
      run: { runId: "run-1", replayed: false },
    });
  });

  it.each([false, true])(
    "enlists Routine invocation and fenced inbox binding in one transaction (lease lost: %s)",
    async (leaseLost) => {
      const transaction: Queryable = {
        query: async () => {
          throw new Error("unexpected SQL in the invocation fixture");
        },
      };
      const journal: string[] = [];
      const transactions: TransactionPort = {
        async withTransaction(work) {
          journal.push("begin");
          try {
            const result = await work(transaction);
            journal.push("commit");
            return result;
          } catch (error) {
            journal.push("rollback");
            throw error;
          }
        },
      };
      const persist = vi.fn(async (record: DurableInvocationRecord, tx?: Queryable) => {
        expect(tx).toBe(transaction);
        journal.push("persist");
        return { outcome: "started" as const, runId: record.runId };
      });
      const authority = {
        definitionRef: "published:routine:watch-reactions",
        principal: { kind: "user", id: "muskan" },
        configurationDigest: "approved-route-and-accounts",
      };
      const route: NativeChannelRoutineRoute = {
        id: "reaction-route",
        businessId: "business",
        provider: "slack",
        integrationId: "installation",
        destination: "C1",
        eventType: "slack.reaction_added",
        routineId: "watch-reactions",
        enabled: true,
        authority,
      };
      const f = fixture(true, {
        transactions,
        authorizeRoutine: vi.fn(async () => authority),
        invocations: new DurableInvocationGateway({
          store: { persist },
          validator: new TypedOutputValidator(INVOCATION_REQUEST_SCHEMAS),
          routineDefinitions: {
            resolve: async () => ({
              bundle: { digest: "bundle", routineId: route.routineId, routineVersion: "1" },
              startState: { key: "invoke", definitionRef: authority.definitionRef },
            }),
          },
          nextId: () => "routine-run",
        }),
      });
      vi.spyOn(f.service.deps.inbox, "routineRoutes").mockResolvedValue([route]);
      await f.service.acceptSocketEnvelope({
        type: "event_callback",
        api_app_id: "A1",
        team_id: "T1",
        event_id: "reaction-event",
        event: {
          type: "reaction_added",
          user: "U1",
          reaction: "eyes",
          item: { channel: "C1", ts: "100.1" },
        },
      });
      if (leaseLost) f.bindRun.mockRejectedValueOnce(new Error("native_delivery_lease_lost"));

      expect(await f.service.drain(20)).toEqual({
        claimed: 1,
        dispatched: leaseLost ? 0 : 1,
        denied: 0,
        retrying: leaseLost ? 1 : 0,
      });
      expect(journal).toEqual(["begin", "persist", leaseLost ? "rollback" : "commit"]);
      expect(f.bindRun).toHaveBeenCalledWith(
        expect.objectContaining({ id: f.event()?.id }),
        "routine-run",
        expect.any(Date),
        transaction
      );
      expect(persist).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "integration",
          runSource: "routine",
          initiator: { kind: "integration", id: "installation" },
          effectiveSubject: authority.principal,
          identityMappingEvidenceRef: `native-channel-inbox:${f.event()?.id}`,
          requestArtifact: expect.objectContaining({
            schemaRef: MANUAL_REQUEST_SCHEMA_REF,
            value: expect.objectContaining({ slug: "watch-reactions" }),
          }),
        }),
        transaction
      );
      expect(submitter).not.toHaveBeenCalled();
      expect(f.createDelivery).not.toHaveBeenCalled();
    }
  );

  it("denies missing grants even though the legacy routing resolver still returns a route", async () => {
    const f = fixture(false);
    await f.accept();
    expect(await f.service.drain(20)).toMatchObject({ denied: 1, dispatched: 0 });
    expect(submitter).not.toHaveBeenCalled();
  });

  it.each([
    { outcome: "unlinked", bindOffer: null },
    { outcome: "linked", principalKind: "guest", principalId: "muskan" },
  ])(
    "rechecks identity on replay and never borrows the mapped Conversation owner: %j",
    async (identity) => {
      const f = fixture();
      await f.accept();
      f.identity.mockResolvedValue(identity);
      expect(await f.service.drain(20)).toMatchObject({ denied: 1 });
      expect(submitter).not.toHaveBeenCalled();
    }
  );

  it("denies a revoked or retargeted route accepted under an earlier binding", async () => {
    const f = fixture();
    await f.accept();
    f.snapshot.routes[0].channelId = "C2";
    expect(await f.service.drain(20)).toMatchObject({ denied: 1 });
    expect(submitter).not.toHaveBeenCalled();
  });

  it("publishes a real Chat request and repairs the delivery correlation after Run replay", async () => {
    const f = fixture();
    await f.accept();
    submit.mockResolvedValue({
      outcome: "submitted",
      run: { runId: "run-1", replayed: true },
    });
    expect(await f.service.drain(20)).toMatchObject({ dispatched: 1 });
    expect(submitter).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: { kind: "user", id: "muskan", businessId: "business" },
        payload: {
          conversationId: "chat-muskan",
          agentId: "assistant",
          message: { role: "user", content: "Please help" },
        },
        requestMetadata: {
          nativeChannel: expect.objectContaining({ provider: "slack", audience: "shared" }),
        },
      })
    );
    expect(f.bindRun).toHaveBeenCalledWith(expect.anything(), "run-1");
    expect(f.createDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        principalId: "muskan",
        destination: "C1",
      })
    );
  });

  it("persists a slash command's actual sender before ack without retaining response credentials", async () => {
    const f = fixture();
    const response = await f.service.acceptSocketCommand({
      command: "/tulipfarm",
      api_app_id: "A1",
      team_id: "T1",
      user_id: "U1",
      channel_id: "C1",
      trigger_id: "trigger-1",
      text: "Please help",
      response_url: "https://hooks.slack.com/commands/private-response",
      token: "provider-verification-token",
    });
    expect(response.response).toBe("starting");
    expect(f.event()?.binding.principalId).toBe("muskan");
    expect(f.event()?.payload).not.toHaveProperty("response_url");
    expect(f.event()?.payload).not.toHaveProperty("token");
    expect(submitter).not.toHaveBeenCalled();
    expect(await f.service.drain(20)).toMatchObject({ dispatched: 1 });
    expect(f.createDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        principalId: "muskan",
        destination: "C1",
      })
    );
  });

  it("never dispatches an unlinked slash command even if the sender links after its denial", async () => {
    const f = fixture();
    f.identity.mockResolvedValue({ outcome: "unlinked" });
    const response = await f.service.acceptSocketCommand({
      command: "/tulipfarm",
      api_app_id: "A1",
      team_id: "T1",
      user_id: "U1",
      channel_id: "C1",
      trigger_id: "trigger-1",
      text: "Please help",
    });
    expect(response.response).toBe("unlinked");
    f.identity.mockResolvedValue({
      outcome: "linked",
      principalKind: "user",
      principalId: "muskan",
    });
    expect(await f.service.drain(20)).toMatchObject({ denied: 1 });
    expect(submitter).not.toHaveBeenCalled();
  });

  it("refuses to replay a slash command under a newly linked different user", async () => {
    const f = fixture();
    await f.service.acceptSocketCommand({
      command: "/tulipfarm",
      api_app_id: "A1",
      team_id: "T1",
      user_id: "U1",
      channel_id: "C1",
      trigger_id: "trigger-1",
      text: "Please help",
    });
    f.identity.mockResolvedValue({
      outcome: "linked",
      principalKind: "user",
      principalId: "another-user",
    });
    expect(await f.service.drain(20)).toMatchObject({ denied: 1 });
    expect(submitter).not.toHaveBeenCalled();
  });

  it("queues a Surface answer under the clicking user, not the source Conversation owner", async () => {
    const f = fixture();
    await f.accept();
    const source = f.event();
    if (!source) throw new Error("source event missing");
    vi.spyOn(f.service, "authorizeReply").mockResolvedValue({
      ...source,
      status: "dispatched",
      runId: "source-run",
    });
    await f.service.acceptSurfaceInteraction({
      sourceRunId: "source-run",
      interactionId: "interaction-1",
      provider: "slack",
      externalSubject: "U-CLICK",
      externalTenantId: "T1",
      principalId: "muskan",
      content: "Approve this choice",
    });
    expect(f.event()?.eventType).toBe("surface_interaction");
    expect(f.event()?.payload.user_id).toBe("U-CLICK");
    expect(f.event()?.binding.principalId).toBe("muskan");
    expect(f.identity).toHaveBeenLastCalledWith({
      slug: "slack",
      sender: "U-CLICK",
      externalTenantId: "T1",
    });
    await f.service.authorizeSurfaceInteraction("source-run", "interaction-1", "muskan");
    expect(submitter).not.toHaveBeenCalled();
    expect(await f.service.drain(20)).toMatchObject({ dispatched: 1 });
    expect(submitter).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: { kind: "user", id: "muskan", businessId: "business" },
      })
    );
    expect(f.createDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        principalId: "muskan",
        idempotencyKey: expect.stringMatching(/^native:/),
      })
    );
  });
});

describe("native GitHub reply credentials", () => {
  it.each(["lease", "destination"])(
    "refuses a mismatched %s before minting a token",
    async (changed) => {
      const githubReply = vi.fn();
      const service = new NativeChannelService({
        businessId: "business",
        credentials: { githubReply },
        runDeliveries: {
          find: vi.fn(async () => ({
            status: "delivering",
            integrationId: "installation",
            routeId: "route",
            destination: "business/project",
            leaseGeneration: 2,
            leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          })),
        },
      } as unknown as NativeChannelDeps);
      vi.spyOn(service, "authorizeReply").mockResolvedValue({
        provider: "github",
        externalAppId: "123",
        externalTenantId: "456",
      } as NativeChannelInboxRecord);
      await expect(
        service.githubCredential({
          integrationId: "installation",
          routeId: "route",
          runId: "run-1",
          destination: changed === "destination" ? "another/project" : "business/project",
          leaseGeneration: changed === "lease" ? 1 : 2,
        })
      ).rejects.toMatchObject({ code: "native_reply_lease_invalid" });
      expect(githubReply).not.toHaveBeenCalled();
    }
  );
});
