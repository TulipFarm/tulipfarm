import { PGlite } from "@electric-sql/pglite";
import {
  type IntegrationHttpRequest,
  type IntegrationHttpResponse,
  SlackDeliveryAdapter,
} from "@tulipfarm/integrations";
import {
  CHANNEL_DELIVERY_STORAGE_STATEMENTS,
  CHANNEL_RUN_DELIVERY_STORAGE_STATEMENTS,
  ChannelDeliveryStore,
  ChannelRunDeliveryStore,
  type Queryable,
  type RunStore,
  type TransactionPort,
} from "@tulipfarm/storage";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalApiClient } from "../internal/client";
import { channelDeliveryLedger } from "./delivery-ledger";
import { startDeliveryPollLoop } from "./delivery-poll-loop";

const START = Date.parse("2026-09-17T12:00:00.000Z");
const correlation = {
  businessId: "business-1",
  runId: "run-1",
  integrationId: "integration-1",
  routeId: "route-1",
  provider: "slack",
  destination: "C1",
  threadId: "1.0",
  agentId: "agent-1",
  principalId: "user-1",
  idempotencyKey: "run-1",
};

describe("durable Slack delivery recovery", () => {
  let database: PGlite;
  let transactions: TransactionPort;
  let now: number;
  let runDeliveries: ChannelRunDeliveryStore;
  let ledger: ChannelDeliveryStore;
  const post =
    vi.fn<
      (request: IntegrationHttpRequest, credential: string) => Promise<IntegrationHttpResponse>
    >();
  const history = vi.fn<() => Promise<IntegrationHttpResponse>>();

  beforeAll(async () => {
    database = new PGlite();
    await database.exec(`CREATE TABLE integrations (
      business_id text NOT NULL, id text NOT NULL, PRIMARY KEY(business_id, id)
    );
    INSERT INTO integrations VALUES ('business-1', 'integration-1');`);
    for (const sql of [
      ...CHANNEL_DELIVERY_STORAGE_STATEMENTS,
      ...CHANNEL_RUN_DELIVERY_STORAGE_STATEMENTS,
    ]) {
      await database.exec(sql);
    }
    transactions = {
      withTransaction: (operation) => database.transaction((tx) => operation(tx as Queryable)),
    };
  });
  afterAll(async () => {
    await database.close();
  });
  beforeEach(async () => {
    await database.exec("TRUNCATE channel_run_deliveries, channel_delivery_attempts");
    now = START;
    runDeliveries = new ChannelRunDeliveryStore(transactions, () => new Date(now).toISOString());
    ledger = new ChannelDeliveryStore(transactions, () => new Date(now).toISOString());
    post.mockReset().mockResolvedValue({ status: 200, headers: {}, body: { ok: true, ts: "2.0" } });
    history
      .mockReset()
      .mockResolvedValue({ status: 200, headers: {}, body: { ok: true, messages: [] } });
    await runDeliveries.create(correlation);
  });

  async function tick(credential = "bot-one") {
    const controller = new AbortController();
    const adapter = new SlackDeliveryAdapter({
      ledger: channelDeliveryLedger(ledger),
      authorization: { authorize: async () => "allowed" },
      http: {
        send: async (request, credential) => {
          if (request.path === "/auth.test")
            return { status: 200, headers: {}, body: { ok: true, user_id: "BOT" } };
          if (request.path.startsWith("/conversations.")) return history();
          return post(request, credential);
        },
      },
      now: () => now,
    });
    await startDeliveryPollLoop(controller.signal, {
      businessId: correlation.businessId,
      runDeliveries,
      runs: { find: async () => ({ status: "succeeded" }) } as unknown as RunStore,
      internalApi: {
        require: async () => ({ status: "succeeded", text: "The completed answer." }),
      } as unknown as InternalApiClient,
      delivery: adapter,
      credential,
      wait: async () => {
        controller.abort();
      },
      log: { warn: vi.fn() },
    }).settled;
  }

  function publishedReceipt() {
    history.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        ok: true,
        messages: [
          {
            ts: "2.0",
            user: "BOT",
            metadata: {
              event_type: "tulipfarm_delivery",
              event_payload: { id: correlation.idempotencyKey },
            },
          },
        ],
      },
    });
  }

  it("recovers a crash immediately after Run claim and admits only one competing poller", async () => {
    await runDeliveries.claim(correlation.businessId, correlation.runId);
    now += 59_999;
    await tick();
    expect(post).not.toHaveBeenCalled();
    now += 1;
    runDeliveries = new ChannelRunDeliveryStore(transactions, () => new Date(now).toISOString());
    await Promise.all([tick(), tick()]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(await runDeliveries.find(correlation.businessId, correlation.runId)).toMatchObject({
      status: "done",
    });
  });

  it("does not resend when the process crashes after the receipt commits but before Run delivery commits", async () => {
    vi.spyOn(runDeliveries, "markStatus").mockRejectedValueOnce(
      new Error("simulated process death")
    );
    await tick();
    now += 60_000;
    await tick();
    expect(post).toHaveBeenCalledTimes(1);
    expect(await runDeliveries.find(correlation.businessId, correlation.runId)).toMatchObject({
      status: "done",
    });
  });

  it("reconciles Slack acceptance after a crash before the local receipt commits without a second post", async () => {
    vi.spyOn(ledger, "complete").mockRejectedValueOnce(new Error("simulated process death"));
    await tick();
    publishedReceipt();
    now += 60_000;
    await tick();
    expect(post).toHaveBeenCalledTimes(1);
    expect(history).toHaveBeenCalledTimes(1);
    expect(await runDeliveries.find(correlation.businessId, correlation.runId)).toMatchObject({
      status: "done",
    });
  });

  it.each(["90", "Thu, 17 Sep 2026 12:01:30 GMT"])(
    "honors persisted Retry-After %s exactly across worker reconstruction",
    async (retryAfter) => {
      post.mockResolvedValueOnce({
        status: 429,
        headers: { "retry-after": retryAfter },
        body: { ok: false },
      });

      await tick();
      expect(post).toHaveBeenCalledTimes(1);
      expect(await runDeliveries.find(correlation.businessId, correlation.runId)).toMatchObject({
        status: "pending",
        nextAttemptAt: "2026-09-17T12:01:30.000Z",
      });
      now += 89_999;
      await tick();
      expect(post).toHaveBeenCalledTimes(1);
      now += 1;
      ledger = new ChannelDeliveryStore(transactions, () => new Date(now).toISOString());
      await tick();
      expect(post).toHaveBeenCalledTimes(2);
      expect(await runDeliveries.find(correlation.businessId, correlation.runId)).toMatchObject({
        status: "done",
      });
    }
  );

  it("retries a transient update safely against the existing message", async () => {
    await runDeliveries.setSlackMessageTs(correlation.businessId, correlation.runId, "2.0");
    post.mockResolvedValueOnce({ status: 503, headers: {}, body: undefined });
    await tick();
    now += 5000;
    await tick();
    expect(post).toHaveBeenCalledTimes(2);
    expect(history).not.toHaveBeenCalled();
    expect(await runDeliveries.find(correlation.businessId, correlation.runId)).toMatchObject({
      status: "done",
    });
  });

  it("refuses another user's forged delivery metadata while reconciling", async () => {
    await ledger.begin(correlation);
    history.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        ok: true,
        messages: [{ ts: "2.0", user: "OTHER", client_msg_id: correlation.idempotencyKey }],
      },
    });
    now += 60_000;
    await tick();
    expect(post).not.toHaveBeenCalled();
    expect(await runDeliveries.find(correlation.businessId, correlation.runId)).toMatchObject({
      status: "pending",
    });
  });

  it("retries expired-token rejection after rotation without losing the answer", async () => {
    post.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: { ok: false, error: "token_expired" },
    });
    await tick();
    now += 30_000;
    await tick("bot-two");
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenLastCalledWith(
      expect.objectContaining({
        path: "/chat.postMessage",
        body: expect.objectContaining({ text: "The completed answer." }),
      }),
      "bot-two"
    );
    expect(await runDeliveries.find(correlation.businessId, correlation.runId)).toMatchObject({
      status: "done",
    });
  });

  it("reconciles ambiguous 503 acceptance instead of sending a generic failure or duplicate", async () => {
    post.mockResolvedValueOnce({ status: 503, headers: {}, body: undefined });
    await tick();
    publishedReceipt();
    now += 5000;
    await tick();
    expect(post).toHaveBeenCalledTimes(1);
    expect(await runDeliveries.find(correlation.businessId, correlation.runId)).toMatchObject({
      status: "done",
    });
  });

  it("keeps an unproven dispatch pending for reconciliation rather than blindly posting twice", async () => {
    await ledger.begin(correlation);
    now += 60_000;
    await tick();
    expect(post).not.toHaveBeenCalled();
    expect(await runDeliveries.find(correlation.businessId, correlation.runId)).toMatchObject({
      status: "pending",
      nextAttemptAt: "2026-09-17T12:01:30.000Z",
    });
  });
});
