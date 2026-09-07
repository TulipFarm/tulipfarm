import type { IntegrationHttpPort, IntegrationHttpResponse } from "@tulipfarm/integrations";
import type { ChannelSurfaceStore, PersistedChannelSurfacePublishJob } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import type { InternalApiClient } from "../internal/client";
import { SlackHomePublisher, type SlackHomePublisherDeps } from "./home-publisher";

function home(linked = true) {
  return {
    integrationId: "integration-1",
    linked,
    renderDigest: linked ? "digest-linked" : "digest-link",
    view: { type: "home", blocks: [{ type: "section" }] },
  };
}

function job(): PersistedChannelSurfacePublishJob {
  return {
    businessId: "business-1",
    integrationId: "integration-1",
    externalTenantId: "T1",
    externalSubject: "U1",
    surface: "home",
    coalescingKey: "slack-home:integration-1:U1:1",
    generation: 1,
    status: "leased",
    leaseOwner: "worker-1",
    attempt: 1,
    nextAttemptAt: "2026-09-07T10:00:00.000Z",
    createdAt: "2026-09-07T10:00:00.000Z",
    updatedAt: "2026-09-07T10:00:00.000Z",
  };
}

function setup(options: {
  linked?: boolean;
  claimed?: readonly PersistedChannelSurfacePublishJob[];
  response?: IntegrationHttpResponse;
  responses?: readonly IntegrationHttpResponse[];
  instance?: Awaited<ReturnType<ChannelSurfaceStore["getInstance"]>>;
  instances?: readonly Awaited<ReturnType<ChannelSurfaceStore["getInstance"]>>[];
  latestJob?: PersistedChannelSurfacePublishJob | null;
  homes?: readonly ReturnType<typeof home>[];
}) {
  const enqueuePublish = vi.fn().mockResolvedValue({ outcome: "enqueued", job: job() });
  const claimPublish = vi.fn().mockResolvedValue(options.claimed ?? []);
  const getInstance = vi.fn();
  for (const instance of options.instances ?? []) getInstance.mockResolvedValueOnce(instance);
  getInstance.mockResolvedValue(options.instance ?? null);
  const getLatestPublishJob = vi.fn().mockResolvedValue(options.latestJob ?? job());
  const finalizePublishSuccess = vi.fn().mockResolvedValue(true);
  const finalizePublishFailure = vi.fn().mockResolvedValue(true);
  const supersedePublish = vi.fn().mockResolvedValue(true);
  const store = {
    enqueuePublish,
    claimPublish,
    getInstance,
    getLatestPublishJob,
    finalizePublishSuccess,
    finalizePublishFailure,
    supersedePublish,
  };
  const find = vi.fn().mockResolvedValue(home(options.linked ?? true));
  const require = vi.fn();
  for (const projected of options.homes ?? []) require.mockResolvedValueOnce(projected);
  require.mockResolvedValue(home(options.linked ?? true));
  const internalApi = { find, require } as unknown as InternalApiClient;
  const send = vi.fn();
  for (const response of options.responses ?? []) send.mockResolvedValueOnce(response);
  send.mockResolvedValue(
    options.response ?? {
      status: 200,
      headers: {},
      body: { ok: true, view: { id: "V1", hash: "H1" } },
    }
  );
  const deps: SlackHomePublisherDeps = {
    businessId: "business-1",
    store: store as unknown as ChannelSurfaceStore,
    internalApi,
    http: { send } as IntegrationHttpPort,
    credential: "xoxb-token",
    leaseOwner: "worker-1",
    resolveExternalAppId: async () => "A1",
    now: () => new Date("2026-09-07T10:00:01.000Z"),
    log: { warn: vi.fn() },
  };
  return {
    publisher: new SlackHomePublisher(deps),
    enqueuePublish,
    claimPublish,
    getInstance,
    getLatestPublishJob,
    finalizePublishSuccess,
    finalizePublishFailure,
    supersedePublish,
    find,
    require,
    send,
  };
}

const opened = {
  integrationId: "integration-1",
  externalTenantId: "T1",
  externalAppId: "A1",
  externalSubject: "U1",
  tab: "home",
} as const;

describe("SlackHomePublisher", () => {
  it("skips the messages tab", async () => {
    const context = setup({});

    await context.publisher.onAppHomeOpened({ ...opened, tab: "messages" });

    expect(context.find).not.toHaveBeenCalled();
    expect(context.send).not.toHaveBeenCalled();
  });

  it("enqueues an unlinked Home publish before any projection or provider call", async () => {
    const context = setup({ linked: false });

    await context.publisher.onAppHomeOpened(opened);

    expect(context.enqueuePublish).toHaveBeenCalledOnce();
    expect(context.find).not.toHaveBeenCalled();
    expect(context.send).not.toHaveBeenCalled();
  });

  it("only enqueues during the acknowledgement path", async () => {
    const context = setup({ claimed: [job()] });

    await context.publisher.onAppHomeOpened(opened);

    expect(context.enqueuePublish).toHaveBeenCalledWith(
      expect.objectContaining({
        coalescingKey: `slack-home:integration-1:U1:${Math.floor(
          new Date("2026-09-07T10:00:01.000Z").getTime() / 5_000
        )}`,
        externalId: "home",
        surface: "home",
      })
    );
    expect(context.claimPublish).not.toHaveBeenCalled();
    expect(context.find).not.toHaveBeenCalled();
    expect(context.send).not.toHaveBeenCalled();
  });

  it("publishes a claimed job and records the returned view state", async () => {
    const context = setup({ claimed: [job()] });

    await context.publisher.publishDue();

    expect(context.send).toHaveBeenCalledWith(
      {
        method: "POST",
        path: "/views.publish",
        body: { user_id: "U1", view: home().view },
      },
      "xoxb-token"
    );
    expect(context.finalizePublishSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: 1,
        providerViewId: "V1",
        providerHash: "H1",
        renderDigest: "digest-linked",
      })
    );
  });

  it("skips views.publish when the durable render digest is unchanged", async () => {
    const context = setup({
      claimed: [job()],
      instance: {
        businessId: "business-1",
        provider: "slack",
        integrationId: "integration-1",
        externalTenantId: "T1",
        externalSubject: "U1",
        surface: "home",
        externalId: "home",
        providerViewId: "V1",
        providerHash: "H1",
        renderDigest: "digest-linked",
        status: "active",
        createdAt: "2026-09-07T10:00:00.000Z",
        updatedAt: "2026-09-07T10:00:00.000Z",
      },
    });

    await context.publisher.publishDue();

    expect(context.send).not.toHaveBeenCalled();
    expect(context.finalizePublishSuccess).toHaveBeenCalled();
  });

  it("uses Slack Retry-After for a durable retry", async () => {
    const context = setup({
      claimed: [job()],
      response: {
        status: 429,
        headers: { "retry-after": "7" },
        body: { ok: false, error: "ratelimited" },
      },
    });

    await context.publisher.publishDue();

    expect(context.finalizePublishFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "retry_wait",
        errorCode: "ratelimited",
        nextAttemptAt: "2026-09-07T10:00:08.000Z",
      })
    );
  });

  it("refuses a superseded job after a hash conflict", async () => {
    const newer = { ...job(), generation: 2, status: "pending" as const };
    const context = setup({
      claimed: [job()],
      latestJob: newer,
      instance: {
        businessId: "business-1",
        provider: "slack",
        integrationId: "integration-1",
        externalTenantId: "T1",
        externalSubject: "U1",
        surface: "home",
        externalId: "home",
        providerViewId: "V1",
        providerHash: "old-hash",
        renderDigest: "old-digest",
        status: "active",
        createdAt: "2026-09-07T10:00:00.000Z",
        updatedAt: "2026-09-07T10:00:00.000Z",
      },
      response: {
        status: 200,
        headers: {},
        body: { ok: false, error: "hash_conflict" },
      },
    });

    await context.publisher.publishDue();

    expect(context.send).toHaveBeenCalledOnce();
    expect(context.supersedePublish).toHaveBeenCalledWith({
      job: job(),
      leaseOwner: "worker-1",
    });
    expect(context.require).toHaveBeenCalledOnce();
  });

  it("re-projects and retries a current job with the refreshed provider hash", async () => {
    const oldInstance = {
      businessId: "business-1",
      provider: "slack",
      integrationId: "integration-1",
      externalTenantId: "T1",
      externalSubject: "U1",
      surface: "home" as const,
      externalId: "home",
      providerViewId: "V1",
      providerHash: "old-hash",
      renderDigest: "old-digest",
      status: "active" as const,
      createdAt: "2026-09-07T10:00:00.000Z",
      updatedAt: "2026-09-07T10:00:00.000Z",
    };
    const refreshedInstance = { ...oldInstance, providerHash: "current-hash" };
    const currentHome = {
      ...home(false),
      renderDigest: "digest-current",
      view: { type: "home", blocks: [{ type: "section", text: "Link account" }] },
    };
    const context = setup({
      claimed: [job()],
      instances: [oldInstance, refreshedInstance],
      homes: [home(true), currentHome],
      responses: [
        {
          status: 200,
          headers: {},
          body: { ok: false, error: "hash_conflict" },
        },
        {
          status: 200,
          headers: {},
          body: { ok: true, view: { id: "V1", hash: "new-hash" } },
        },
      ],
    });

    await context.publisher.publishDue();

    expect(context.send).toHaveBeenNthCalledWith(
      2,
      {
        method: "POST",
        path: "/views.publish",
        body: {
          user_id: "U1",
          view: currentHome.view,
          hash: "current-hash",
        },
      },
      "xoxb-token"
    );
    expect(context.finalizePublishSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: 1,
        providerHash: "new-hash",
        renderDigest: "digest-current",
      })
    );
  });
});
