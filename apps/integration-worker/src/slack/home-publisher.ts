import type { IntegrationHttpPort } from "@tulipfarm/integrations";
import type {
  ChannelSurfaceInstanceKey,
  ChannelSurfaceStore,
  PersistedChannelSurfacePublishJob,
} from "@tulipfarm/storage";
import { type InternalApiClient, InternalApiError } from "../internal/client";
import type { DrainableLoop } from "../shutdown";
import type { SlackAppHomeOpenedEvent } from "./dispatch";

interface SlackHomeResponse {
  integrationId: string;
  linked: boolean;
  renderDigest: string;
  view: Record<string, unknown>;
}

interface SlackPublishBody {
  ok?: boolean;
  error?: string;
  view?: { id?: string; hash?: string };
}

export interface SlackHomePublisherDeps {
  businessId: string;
  store: Pick<
    ChannelSurfaceStore,
    | "enqueuePublish"
    | "claimPublish"
    | "getInstance"
    | "getLatestPublishJob"
    | "finalizePublishSuccess"
    | "finalizePublishFailure"
    | "supersedePublish"
  >;
  internalApi: InternalApiClient;
  http: IntegrationHttpPort;
  credential: string;
  leaseOwner: string;
  resolveExternalAppId(input: {
    businessId: string;
    integrationId: string;
    externalTenantId: string;
  }): Promise<string | undefined>;
  now?: () => Date;
  log: { warn: (message: string, error?: unknown) => void };
}

const COALESCING_WINDOW_MS = 5_000;
const LEASE_DURATION_MS = 30_000;

function instanceKey(
  businessId: string,
  integrationId: string,
  event: Pick<SlackAppHomeOpenedEvent, "externalTenantId" | "externalSubject">
): ChannelSurfaceInstanceKey {
  return {
    businessId,
    provider: "slack",
    integrationId,
    externalTenantId: event.externalTenantId,
    externalSubject: event.externalSubject,
    surface: "home",
    externalId: "home",
  };
}

function retryAt(now: Date, response: { headers: Readonly<Record<string, string>> }): string {
  const seconds = Number(response.headers["retry-after"] ?? 5);
  return new Date(
    now.getTime() + (Number.isFinite(seconds) ? Math.max(1, seconds) : 5) * 1_000
  ).toISOString();
}

export class SlackHomePublisher {
  private readonly now: () => Date;

  constructor(private readonly deps: SlackHomePublisherDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async onAppHomeOpened(event: SlackAppHomeOpenedEvent): Promise<void> {
    if (event.tab !== "home" || event.integrationId === undefined) return;

    const bucket = Math.floor(this.now().getTime() / COALESCING_WINDOW_MS);
    await this.deps.store.enqueuePublish({
      ...instanceKey(this.deps.businessId, event.integrationId, event),
      coalescingKey: `slack-home:${event.integrationId}:${event.externalSubject}:${bucket}`,
      supersedePending: false,
    });
  }

  async publishDue(): Promise<void> {
    const jobs = await this.deps.store.claimPublish({
      businessId: this.deps.businessId,
      owner: this.deps.leaseOwner,
      limit: 10,
      leaseDurationMs: LEASE_DURATION_MS,
    });
    for (const job of jobs) {
      await this.publishJob(job).catch((error) => {
        this.deps.log.warn("Slack Home publish job failed", error);
      });
    }
  }

  private async publishJob(job: PersistedChannelSurfacePublishJob): Promise<void> {
    const externalAppId = await this.deps.resolveExternalAppId({
      businessId: job.businessId,
      integrationId: job.integrationId,
      externalTenantId: job.externalTenantId,
    });
    if (externalAppId === undefined) {
      await this.fail(job, "failed", "integration_inactive");
      return;
    }
    const event: SlackAppHomeOpenedEvent = {
      externalTenantId: job.externalTenantId,
      externalAppId,
      externalSubject: job.externalSubject,
      tab: "home",
    };
    let home: SlackHomeResponse;
    try {
      const loaded = await this.loadHome(event, job.integrationId);
      if (loaded === undefined) {
        await this.fail(job, "failed", "integration_inactive");
        return;
      }
      home = loaded;
    } catch (error) {
      await this.fail(
        job,
        error instanceof InternalApiError && error.status === 404 ? "failed" : "retry_wait",
        "home_projection_failed"
      );
      return;
    }

    const key = instanceKey(job.businessId, job.integrationId, event);
    const current = await this.deps.store.getInstance(key);
    if (
      current?.renderDigest === home.renderDigest &&
      current.providerViewId !== undefined &&
      current.providerHash !== undefined
    ) {
      await this.deps.store.finalizePublishSuccess({
        key,
        generation: job.generation,
        leaseOwner: this.deps.leaseOwner,
        providerViewId: current.providerViewId,
        providerHash: current.providerHash,
        renderDigest: current.renderDigest,
      });
      return;
    }

    let response = await this.publish(job.externalSubject, home.view, current?.providerHash);
    let body = response.body as SlackPublishBody | undefined;
    if (body?.error === "hash_conflict") {
      const [latestJob, refreshedCurrent] = await Promise.all([
        this.deps.store.getLatestPublishJob(job),
        this.deps.store.getInstance(key),
      ]);
      if (
        latestJob?.generation !== job.generation ||
        latestJob.status !== "leased" ||
        latestJob.leaseOwner !== this.deps.leaseOwner
      ) {
        await this.deps.store.supersedePublish({
          job,
          leaseOwner: this.deps.leaseOwner,
        });
        return;
      }
      if (refreshedCurrent?.providerHash === undefined) {
        await this.fail(job, "retry_wait", "home_hash_unavailable");
        return;
      }

      try {
        const refreshedHome = await this.loadHome(event, job.integrationId);
        if (refreshedHome === undefined) {
          await this.fail(job, "failed", "integration_inactive");
          return;
        }
        home = refreshedHome;
      } catch (error) {
        await this.fail(
          job,
          error instanceof InternalApiError && error.status === 404 ? "failed" : "retry_wait",
          "home_projection_failed"
        );
        return;
      }
      if (
        refreshedCurrent.renderDigest === home.renderDigest &&
        refreshedCurrent.providerViewId !== undefined
      ) {
        await this.deps.store.finalizePublishSuccess({
          key,
          generation: job.generation,
          leaseOwner: this.deps.leaseOwner,
          providerViewId: refreshedCurrent.providerViewId,
          providerHash: refreshedCurrent.providerHash,
          renderDigest: refreshedCurrent.renderDigest,
        });
        return;
      }

      response = await this.publish(job.externalSubject, home.view, refreshedCurrent.providerHash);
      body = response.body as SlackPublishBody | undefined;
    }
    if (
      response.status >= 200 &&
      response.status < 300 &&
      body?.ok === true &&
      typeof body.view?.id === "string" &&
      typeof body.view.hash === "string"
    ) {
      await this.deps.store.finalizePublishSuccess({
        key,
        generation: job.generation,
        leaseOwner: this.deps.leaseOwner,
        providerViewId: body.view.id,
        providerHash: body.view.hash,
        renderDigest: home.renderDigest,
      });
      return;
    }

    if (response.status === 429 || response.status >= 500) {
      await this.fail(job, "retry_wait", body?.error ?? `http_${response.status}`, response);
      return;
    }
    await this.fail(job, "failed", body?.error ?? "views_publish_failed");
  }

  private async loadHome(
    event: SlackAppHomeOpenedEvent,
    integrationId?: string
  ): Promise<SlackHomeResponse | undefined> {
    if (event.externalAppId === undefined) return undefined;
    const path = "/api/v1/internal/channels/slack/home";
    if (integrationId !== undefined) {
      return this.deps.internalApi.require<SlackHomeResponse>("POST", path, {
        integrationId,
        externalTenantId: event.externalTenantId,
        externalAppId: event.externalAppId,
        externalSubject: event.externalSubject,
      });
    }
    if (event.integrationId === undefined) return undefined;
    return this.deps.internalApi.find<SlackHomeResponse>("POST", path, [404], {
      integrationId: event.integrationId,
      externalTenantId: event.externalTenantId,
      externalAppId: event.externalAppId,
      externalSubject: event.externalSubject,
    });
  }

  private publish(userId: string, view: Record<string, unknown>, hash?: string) {
    return this.deps.http.send(
      {
        method: "POST",
        path: "/views.publish",
        body: {
          user_id: userId,
          view,
          ...(hash === undefined ? {} : { hash }),
        },
      },
      this.deps.credential
    );
  }

  private async fail(
    job: PersistedChannelSurfacePublishJob,
    status: "retry_wait" | "failed",
    errorCode: string,
    response?: { headers: Readonly<Record<string, string>> }
  ): Promise<void> {
    await this.deps.store.finalizePublishFailure({
      job,
      leaseOwner: this.deps.leaseOwner,
      status,
      errorCode,
      ...(status === "retry_wait"
        ? { nextAttemptAt: retryAt(this.now(), response ?? { headers: {} }) }
        : {}),
    });
  }
}

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

export function startSlackHomePublishLoop(
  signal: AbortSignal,
  publisher: SlackHomePublisher,
  pollIntervalMs = 2_000
): DrainableLoop {
  return {
    name: "slack-home-publish",
    settled: (async () => {
      while (!signal.aborted) {
        await publisher.publishDue();
        await wait(pollIntervalMs, signal);
      }
    })(),
  };
}
