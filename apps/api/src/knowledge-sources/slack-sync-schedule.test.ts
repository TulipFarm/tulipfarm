import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import {
  SLACK_KNOWLEDGE_ACL_MAX_AGE_SECONDS,
  SLACK_KNOWLEDGE_SYNC_PERIOD_SECONDS,
  type SlackKnowledgeSyncOptions,
  type SlackKnowledgeSyncResult,
} from "@tulipfarm/integrations";
import type { SecretsService } from "@tulipfarm/secrets";
import type { IntegrationStore, PersistedRoutingSnapshot } from "@tulipfarm/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PgKnowledgeEmissionSink } from "./emission-sink";
import { runSlackKnowledgeSync, SLACK_KNOWLEDGE_SYNC_CRON } from "./slack-sync-schedule";

const { syncSlackKnowledge } = vi.hoisted(() => ({
  syncSlackKnowledge:
    vi.fn<
      (deps: unknown, options: SlackKnowledgeSyncOptions) => Promise<SlackKnowledgeSyncResult>
    >(),
}));

vi.mock("@tulipfarm/integrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tulipfarm/integrations")>();
  return { ...actual, syncSlackKnowledge };
});

function result(overrides: Partial<SlackKnowledgeSyncResult> = {}): SlackKnowledgeSyncResult {
  return {
    channelsProcessed: 1,
    emitted: 1,
    unverifiable: 0,
    messagesIndexed: 3,
    messagesRemoved: 0,
    failures: [],
    ...overrides,
  };
}

function snapshot(
  integrations: PersistedRoutingSnapshot["integrations"]
): PersistedRoutingSnapshot {
  return { apps: [], integrations, accessGrants: [], routes: [] };
}

function fakeIntegrations(snap: PersistedRoutingSnapshot): IntegrationStore {
  return { loadProviderSnapshot: vi.fn().mockResolvedValue(snap) } as unknown as IntegrationStore;
}

function fakeSecrets(token: string | undefined): SecretsService {
  return {
    get: vi.fn(() =>
      token === undefined ? Promise.reject(new Error("not found")) : Promise.resolve(token)
    ),
  } as unknown as SecretsService;
}

const noopCheckpoints = { load: vi.fn(), save: vi.fn() };
const noopSink = {
  emitSource: vi.fn(),
  emitChunk: vi.fn(),
  removeSourceContent: vi.fn(),
  removeChunk: vi.fn(),
} as unknown as PgKnowledgeEmissionSink;
const noopIdentity = { resolve: vi.fn() };

describe("runSlackKnowledgeSync", () => {
  beforeEach(() => {
    syncSlackKnowledge.mockReset();
  });

  it("syncs each active integration and attaches its integrationId to the result", async () => {
    syncSlackKnowledge.mockResolvedValue(result());
    const integrations = fakeIntegrations(
      snapshot([
        {
          id: "slack:app1:T1",
          businessId: DEPLOYMENT_BUSINESS_ID,
          appId: "app1",
          externalTenantId: "T1",
          status: "active",
        },
      ])
    );

    const results = await runSlackKnowledgeSync({
      integrations,
      secrets: fakeSecrets("xoxb-token"),
      checkpoints: noopCheckpoints,
      sink: noopSink,
      identity: noopIdentity,
    });

    expect(results).toEqual([{ ...result(), integrationId: "slack:app1:T1" }]);
    expect(syncSlackKnowledge).toHaveBeenCalledTimes(1);
    const [, options] = syncSlackKnowledge.mock.calls[0] ?? [];
    expect(options).toEqual({
      businessId: DEPLOYMENT_BUSINESS_ID,
      integrationId: "slack:app1:T1",
      externalTenantId: "T1",
    });
  });

  it("skips a revoked integration", async () => {
    const integrations = fakeIntegrations(
      snapshot([
        {
          id: "slack:app1:T1",
          businessId: DEPLOYMENT_BUSINESS_ID,
          appId: "app1",
          externalTenantId: "T1",
          status: "revoked",
        },
      ])
    );
    const results = await runSlackKnowledgeSync({
      integrations,
      secrets: fakeSecrets("xoxb-token"),
      checkpoints: noopCheckpoints,
      sink: noopSink,
      identity: noopIdentity,
    });
    expect(results).toEqual([]);
    expect(syncSlackKnowledge).not.toHaveBeenCalled();
  });

  it("skips an active integration whose bot token secret cannot be resolved", async () => {
    const integrations = fakeIntegrations(
      snapshot([
        {
          id: "slack:app1:T1",
          businessId: DEPLOYMENT_BUSINESS_ID,
          appId: "app1",
          externalTenantId: "T1",
          status: "active",
        },
      ])
    );
    const results = await runSlackKnowledgeSync({
      integrations,
      secrets: fakeSecrets(undefined),
      checkpoints: noopCheckpoints,
      sink: noopSink,
      identity: noopIdentity,
    });
    expect(results).toEqual([]);
    expect(syncSlackKnowledge).not.toHaveBeenCalled();
  });

  it("isolates one integration's sync from another and aggregates both results", async () => {
    syncSlackKnowledge
      .mockResolvedValueOnce(result({ messagesIndexed: 3 }))
      .mockResolvedValueOnce(result({ messagesIndexed: 5 }));
    const integrations = fakeIntegrations(
      snapshot([
        {
          id: "slack:app1:T1",
          businessId: DEPLOYMENT_BUSINESS_ID,
          appId: "app1",
          externalTenantId: "T1",
          status: "active",
        },
        {
          id: "slack:app1:T2",
          businessId: DEPLOYMENT_BUSINESS_ID,
          appId: "app1",
          externalTenantId: "T2",
          status: "active",
        },
      ])
    );
    const results = await runSlackKnowledgeSync({
      integrations,
      secrets: fakeSecrets("xoxb-token"),
      checkpoints: noopCheckpoints,
      sink: noopSink,
      identity: noopIdentity,
    });
    expect(results.map((r) => r.integrationId)).toEqual(["slack:app1:T1", "slack:app1:T2"]);
    expect(results.map((r) => r.messagesIndexed)).toEqual([3, 5]);
  });
});

describe("Slack Knowledge ACL max age vs sync cadence", () => {
  it("derives SLACK_KNOWLEDGE_SYNC_CRON's period from SLACK_KNOWLEDGE_SYNC_PERIOD_SECONDS", () => {
    const match = SLACK_KNOWLEDGE_SYNC_CRON.match(/^\*\/(\d+) \* \* \* \*$/);
    expect(match).not.toBeNull();
    const cronPeriodSeconds = Number(match?.[1]) * 60;
    expect(cronPeriodSeconds).toBe(SLACK_KNOWLEDGE_SYNC_PERIOD_SECONDS);
  });

  it("keeps the captured ACL snapshot valid across at least one missed sync run", () => {
    // Regression guard: a 900s cron (every 15 min) paired with a 300s max age denied every
    // Slack source as acl_stale for 10 of every 15 minutes (`decideKnowledgeAccess`, silently).
    // The max age must stay a comfortable multiple of the sync period so one missed or delayed
    // job cannot black out retrieval on its own.
    expect(SLACK_KNOWLEDGE_ACL_MAX_AGE_SECONDS).toBeGreaterThanOrEqual(
      SLACK_KNOWLEDGE_SYNC_PERIOD_SECONDS * 2
    );
  });
});
