import type { AccessGrantDefinition } from "@tulipfarm/schema";
import { describe, expect, it, vi } from "vitest";
import type {
  ChannelDeliveryAttempt,
  ChannelDeliveryLedger,
  ChannelDeliveryRecord,
  ChannelInboundEvent,
} from "../channels";
import type { ChannelRoutingSnapshot } from "../model";
import {
  SlackChannelAdapter,
  SlackDeliveryAdapter,
  SlackDeliveryError,
  type SlackEventEnvelope,
} from "./adapter";

const BUSINESS_ID = "business-1";
const APP_ID = "00000000-0000-4000-8000-000000000001";
const INTEGRATION_ID = "00000000-0000-4000-8000-000000000002";
const AGENT_ID = "00000000-0000-4000-8000-000000000003";
const PRINCIPAL_ID = "00000000-0000-4000-8000-000000000004";
const GRANT_ID = "00000000-0000-4000-8000-000000000005";

function grant(): AccessGrantDefinition {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "AccessGrant",
    metadata: {
      id: GRANT_ID,
      slug: "slack-channel",
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "active",
    },
    spec: {
      integrationId: INTEGRATION_ID,
      principals: [{ kind: "user", id: PRINCIPAL_ID }],
      actions: ["channels.message.receive"],
      externalTargets: [{ type: "slack.channel", ids: ["C-OPS"] }],
      delegable: false,
    },
  };
}

function routing(status: "active" | "revoked" = "active"): ChannelRoutingSnapshot {
  return {
    apps: [
      {
        id: APP_ID,
        businessId: BUSINESS_ID,
        provider: "slack",
        externalAppId: "A-PRIMARY",
        credentialRefs: ["secret://slack/bot"],
        status: "active",
      },
    ],
    integrations: [
      {
        id: INTEGRATION_ID,
        businessId: BUSINESS_ID,
        appId: APP_ID,
        externalTenantId: "T-ACME",
        credentialRef: "secret://slack/bot",
        status,
      },
    ],
    accessGrants: [grant()],
    routes: [
      {
        id: "route-ops",
        businessId: BUSINESS_ID,
        integrationId: INTEGRATION_ID,
        agentId: AGENT_ID,
        channelId: "C-OPS",
        eventTypes: ["message"],
        priority: 10,
        status: "active",
      },
    ],
  };
}

function event(): SlackEventEnvelope {
  return {
    token: "must-not-be-recorded",
    team_id: "T-ACME",
    api_app_id: "A-PRIMARY",
    event_id: "Ev-1",
    event_time: 1_785_000_000,
    type: "event_callback",
    event: {
      type: "message",
      user: "U-ALICE",
      channel: "C-OPS",
      ts: "1785000000.000100",
      thread_ts: "1784999999.000001",
      text: "status?",
      files: [
        {
          id: "F-1",
          mimetype: "image/png",
          name: "chart.png",
          size: 42,
          url_private: "https://files.slack.com/secret-path",
        },
      ],
    },
  };
}

describe("SlackChannelAdapter", () => {
  it("persists before ack, then starts a Run as the mapped external principal", async () => {
    const order: string[] = [];
    let persisted: ChannelInboundEvent | undefined;
    const start = vi.fn(async () => ({ runId: "run-1", outcome: "started" as const }));
    const adapter = new SlackChannelAdapter({
      inbound: {
        accept: async (input) => {
          order.push("persist");
          persisted = input;
          return { outcome: "accepted" };
        },
      },
      identities: {
        resolve: async () => {
          order.push("identity");
          return { kind: "user", id: PRINCIPAL_ID };
        },
      },
      routing: { load: async () => routing() },
      runs: { start },
      now: () => "2026-07-26T10:00:00.000Z",
    });

    const result = await adapter.receive(BUSINESS_ID, event(), async () => {
      order.push("ack");
    });

    expect(order).toEqual(["persist", "ack", "identity"]);
    expect(result).toEqual({ outcome: "started", runId: "run-1" });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: AGENT_ID,
        principal: { kind: "user", id: PRINCIPAL_ID },
      })
    );
    expect(persisted?.data).toEqual({
      externalAppId: "A-PRIMARY",
      channelId: "C-OPS",
      threadId: "1784999999.000001",
      sourceMessageTs: "1785000000.000100",
      text: "status?",
      media: [
        {
          id: "F-1",
          kind: "image",
          contentType: "image/png",
          fileName: "chart.png",
          sizeBytes: 42,
        },
      ],
    });
    expect(JSON.stringify(persisted)).not.toContain("must-not-be-recorded");
    expect(JSON.stringify(persisted)).not.toContain("secret-path");
  });

  it("threads a root @mention (no thread_ts) under the mention's own ts", async () => {
    let persisted: ChannelInboundEvent | undefined;
    const rootEvent = event();
    const rootMessageEvent = rootEvent.event;
    if (rootMessageEvent === undefined) {
      throw new Error("test setup: event missing");
    }
    rootMessageEvent.thread_ts = undefined;
    const adapter = new SlackChannelAdapter({
      inbound: {
        accept: async (input) => {
          persisted = input;
          return { outcome: "accepted" };
        },
      },
      identities: {
        resolve: async () => ({ kind: "user", id: PRINCIPAL_ID }),
      },
      routing: { load: async () => routing() },
      runs: { start: async () => ({ runId: "run-1", outcome: "started" as const }) },
      now: () => "2026-07-26T10:00:00.000Z",
    });

    await adapter.receive(BUSINESS_ID, rootEvent, async () => {});

    expect(persisted?.data.threadId).toBe("1785000000.000100");
  });

  it("acks a duplicate after durable acceptance without resolving identity or starting a Run", async () => {
    const resolve = vi.fn();
    const start = vi.fn();
    const ack = vi.fn();
    const adapter = new SlackChannelAdapter({
      inbound: { accept: async () => ({ outcome: "duplicate" }) },
      identities: { resolve },
      routing: { load: vi.fn() },
      runs: { start },
      now: () => "2026-07-26T10:00:00.000Z",
    });

    expect(await adapter.receive(BUSINESS_ID, event(), ack)).toEqual({
      outcome: "duplicate",
    });
    expect(ack).toHaveBeenCalledOnce();
    expect(resolve).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("denies an unmapped actor and never substitutes an owner or admin", async () => {
    const start = vi.fn();
    const adapter = new SlackChannelAdapter({
      inbound: { accept: async () => ({ outcome: "accepted" }) },
      identities: { resolve: async () => undefined },
      routing: { load: async () => routing() },
      runs: { start },
      now: () => "2026-07-26T10:00:00.000Z",
    });

    expect(await adapter.receive(BUSINESS_ID, event(), async () => undefined)).toEqual({
      outcome: "denied",
      reason: "external_identity_unmapped",
    });
    expect(start).not.toHaveBeenCalled();
  });

  it("resolves mention tokens in the text handed to the Run, not in the persisted event", async () => {
    let persisted: ChannelInboundEvent | undefined;
    const start = vi.fn(async () => ({ runId: "run-1", outcome: "started" as const }));
    const mentionEvent = event();
    if (mentionEvent.event === undefined) throw new Error("test setup: event missing");
    mentionEvent.event.text = "create a task for <@U0AMFGRAKLY>";
    const adapter = new SlackChannelAdapter({
      inbound: {
        accept: async (input) => {
          persisted = input;
          return { outcome: "accepted" };
        },
      },
      identities: {
        resolve: async () => ({ kind: "user", id: PRINCIPAL_ID }),
      },
      routing: { load: async () => routing() },
      runs: { start },
      now: () => "2026-07-26T10:00:00.000Z",
      mentions: {
        resolveDisplayName: async (userId: string) =>
          userId === "U0AMFGRAKLY" ? "Mohit" : undefined,
      },
    });

    await adapter.receive(BUSINESS_ID, mentionEvent, async () => undefined);

    expect(persisted?.data.text).toBe("create a task for <@U0AMFGRAKLY>");
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ text: "create a task for @Mohit" }),
      })
    );
  });

  it("passes text through unchanged when no mentions resolver is configured", async () => {
    const start = vi.fn(async () => ({ runId: "run-1", outcome: "started" as const }));
    const adapter = new SlackChannelAdapter({
      inbound: { accept: async () => ({ outcome: "accepted" }) },
      identities: {
        resolve: async () => ({ kind: "user", id: PRINCIPAL_ID }),
      },
      routing: { load: async () => routing() },
      runs: { start },
      now: () => "2026-07-26T10:00:00.000Z",
    });

    await adapter.receive(BUSINESS_ID, event(), async () => undefined);

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.objectContaining({ text: "status?" }) })
    );
  });

  it("reloads routing for every event so an Integration revocation applies immediately", async () => {
    let calls = 0;
    const start = vi.fn(async () => ({ runId: "run-1", outcome: "started" as const }));
    const adapter = new SlackChannelAdapter({
      inbound: { accept: async () => ({ outcome: "accepted" }) },
      identities: {
        resolve: async () => ({ kind: "user", id: PRINCIPAL_ID }),
      },
      routing: {
        load: async () => {
          calls += 1;
          return routing(calls === 1 ? "active" : "revoked");
        },
      },
      runs: { start },
      now: () => "2026-07-26T10:00:00.000Z",
    });

    expect((await adapter.receive(BUSINESS_ID, event(), async () => undefined)).outcome).toBe(
      "started"
    );
    expect(
      await adapter.receive(BUSINESS_ID, { ...event(), event_id: "Ev-2" }, async () => undefined)
    ).toMatchObject({ outcome: "denied", reason: "integration_not_found" });
    expect(start).toHaveBeenCalledOnce();
  });
});

class MemoryDeliveryLedger implements ChannelDeliveryLedger {
  records = new Map<string, ChannelDeliveryRecord>();
  failures: { status: string; code: string; retryAfterMs?: number }[] = [];

  async begin(attempt: ChannelDeliveryAttempt) {
    const current = this.records.get(attempt.idempotencyKey);
    if (current) return { outcome: "duplicate" as const, record: current };
    const record: ChannelDeliveryRecord = { ...attempt, status: "pending", attempts: 1 };
    this.records.set(attempt.idempotencyKey, record);
    return { outcome: "started" as const, record };
  }

  async complete(attempt: ChannelDeliveryAttempt, providerMessageId: string) {
    const record: ChannelDeliveryRecord = {
      ...attempt,
      status: "confirmed",
      attempts: 1,
      providerMessageId,
    };
    this.records.set(attempt.idempotencyKey, record);
    return record;
  }

  async fail(
    attempt: ChannelDeliveryAttempt,
    outcome: {
      status: "retry_wait" | "ambiguous" | "failed" | "revoked";
      code: string;
      retryAfterMs?: number;
    }
  ) {
    this.failures.push(outcome);
    const record: ChannelDeliveryRecord = { ...attempt, status: outcome.status, attempts: 1 };
    this.records.set(attempt.idempotencyKey, record);
    return record;
  }
}

const attempt: ChannelDeliveryAttempt = {
  businessId: BUSINESS_ID,
  integrationId: INTEGRATION_ID,
  routeId: "route-ops",
  idempotencyKey: "delivery-1",
  provider: "slack",
  destination: "C-OPS",
  agentId: AGENT_ID,
  principalId: PRINCIPAL_ID,
};

describe("SlackDeliveryAdapter", () => {
  it("records before dispatch, uses provider idempotency, and visibly attributes the Agent", async () => {
    const ledger = new MemoryDeliveryLedger();
    const send = vi.fn(async () => ({
      status: 200,
      headers: {},
      body: { ok: true, ts: "1785000001.000001" },
    }));
    const adapter = new SlackDeliveryAdapter({
      ledger,
      authorization: { authorize: async () => "allowed" },
      http: { send },
    });

    const result = await adapter.deliver(
      {
        ...attempt,
        text: "All systems green.",
        agentDisplayName: "Operations Agent",
        threadId: "1784999999.000001",
      },
      "xoxb-leased"
    );

    expect(result).toMatchObject({
      status: "confirmed",
      providerMessageId: "1785000001.000001",
    });
    expect(send).toHaveBeenCalledWith(
      {
        method: "POST",
        path: "/chat.postMessage",
        body: {
          channel: "C-OPS",
          text: "All systems green.",
          thread_ts: "1784999999.000001",
          client_msg_id: "delivery-1",
        },
      },
      "xoxb-leased"
    );
  });

  it("includes blocks in chat.postMessage when supplied", async () => {
    const ledger = new MemoryDeliveryLedger();
    const send = vi.fn(async () => ({
      status: 200,
      headers: {},
      body: { ok: true, ts: "1785000002.000001" },
    }));
    const adapter = new SlackDeliveryAdapter({
      ledger,
      authorization: { authorize: async () => "allowed" },
      http: { send },
    });
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "hi" } }];

    await adapter.deliver(
      {
        ...attempt,
        idempotencyKey: "delivery-blocks-1",
        text: "hi",
        agentDisplayName: "Agent",
        blocks,
      },
      "xoxb-leased"
    );

    expect(send).toHaveBeenCalledWith(
      {
        method: "POST",
        path: "/chat.postMessage",
        body: {
          channel: "C-OPS",
          text: "hi",
          blocks,
          client_msg_id: "delivery-blocks-1",
        },
      },
      "xoxb-leased"
    );
  });

  it("does not dispatch a confirmed duplicate delivery", async () => {
    const ledger = new MemoryDeliveryLedger();
    await ledger.complete(attempt, "existing-ts");
    const send = vi.fn();
    const adapter = new SlackDeliveryAdapter({
      ledger,
      authorization: { authorize: async () => "allowed" },
      http: { send },
    });

    expect(
      await adapter.deliver({ ...attempt, text: "hello", agentDisplayName: "Agent" }, "xoxb-leased")
    ).toMatchObject({ status: "confirmed", providerMessageId: "existing-ts" });
    expect(send).not.toHaveBeenCalled();
  });

  it("records immediate revocation without calling Slack", async () => {
    const ledger = new MemoryDeliveryLedger();
    const send = vi.fn();
    const adapter = new SlackDeliveryAdapter({
      ledger,
      authorization: { authorize: async () => "revoked" },
      http: { send },
    });

    await expect(
      adapter.deliver({ ...attempt, text: "hello", agentDisplayName: "Agent" }, "xoxb-leased")
    ).rejects.toEqual(new SlackDeliveryError("integration_revoked"));
    expect(ledger.failures).toContainEqual({
      status: "revoked",
      code: "integration_revoked",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("records rate limits for bounded retry and 5xx writes as ambiguous", async () => {
    const rateLedger = new MemoryDeliveryLedger();
    const rateLimited = new SlackDeliveryAdapter({
      ledger: rateLedger,
      authorization: { authorize: async () => "allowed" },
      http: {
        send: async () => ({
          status: 429,
          headers: { "retry-after": "7" },
          body: { ok: false },
        }),
      },
    });
    await expect(
      rateLimited.deliver({ ...attempt, text: "hello", agentDisplayName: "Agent" }, "xoxb-leased")
    ).rejects.toEqual(new SlackDeliveryError("provider_rate_limited"));
    expect(rateLedger.failures).toContainEqual({
      status: "retry_wait",
      code: "provider_rate_limited",
      retryAfterMs: 7000,
    });

    const ambiguousLedger = new MemoryDeliveryLedger();
    const unavailable = new SlackDeliveryAdapter({
      ledger: ambiguousLedger,
      authorization: { authorize: async () => "allowed" },
      http: {
        send: async () => ({ status: 503, headers: {}, body: undefined }),
      },
    });
    await expect(
      unavailable.deliver(
        { ...attempt, idempotencyKey: "delivery-2", text: "hello", agentDisplayName: "Agent" },
        "xoxb-leased"
      )
    ).rejects.toEqual(new SlackDeliveryError("provider_unavailable"));
    expect(ambiguousLedger.failures).toContainEqual({
      status: "ambiguous",
      code: "provider_unavailable",
    });
  });

  it("overwrites the placeholder message via chat.update when updateTs is present", async () => {
    const ledger = new MemoryDeliveryLedger();
    const send = vi.fn(async () => ({
      status: 200,
      headers: {},
      body: { ok: true, ts: "1785000001.000001" },
    }));
    const adapter = new SlackDeliveryAdapter({
      ledger,
      authorization: { authorize: async () => "allowed" },
      http: { send },
    });

    await adapter.deliver(
      {
        ...attempt,
        text: "All systems green.",
        agentDisplayName: "Operations Agent",
        updateTs: "1784999999.000001",
      },
      "xoxb-leased"
    );

    expect(send).toHaveBeenCalledWith(
      {
        method: "POST",
        path: "/chat.update",
        body: {
          channel: "C-OPS",
          ts: "1784999999.000001",
          text: "All systems green.",
        },
      },
      "xoxb-leased"
    );
  });

  it("includes blocks in chat.update when supplied", async () => {
    const ledger = new MemoryDeliveryLedger();
    const send = vi.fn(async () => ({
      status: 200,
      headers: {},
      body: { ok: true, ts: "1785000001.000001" },
    }));
    const adapter = new SlackDeliveryAdapter({
      ledger,
      authorization: { authorize: async () => "allowed" },
      http: { send },
    });
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "hi" } }];

    await adapter.deliver(
      {
        ...attempt,
        text: "All systems green.",
        agentDisplayName: "Operations Agent",
        updateTs: "1784999999.000001",
        blocks,
      },
      "xoxb-leased"
    );

    expect(send).toHaveBeenCalledWith(
      {
        method: "POST",
        path: "/chat.update",
        body: {
          channel: "C-OPS",
          ts: "1784999999.000001",
          text: "All systems green.",
          blocks,
        },
      },
      "xoxb-leased"
    );
  });

  it("update() rotates a still-pending placeholder without touching the ledger", async () => {
    const ledger = new MemoryDeliveryLedger();
    const send = vi.fn(async () => ({ status: 200, headers: {}, body: { ok: true } }));
    const adapter = new SlackDeliveryAdapter({
      ledger,
      authorization: { authorize: async () => "allowed" },
      http: { send },
    });

    await adapter.update(
      { destination: "C-OPS", ts: "1784999999.000001", text: "Organizing…" },
      "xoxb-leased"
    );

    expect(send).toHaveBeenCalledWith(
      {
        method: "POST",
        path: "/chat.update",
        body: { channel: "C-OPS", ts: "1784999999.000001", text: "Organizing…" },
      },
      "xoxb-leased"
    );
    expect(ledger.failures).toHaveLength(0);
  });

  it("setStatus() posts the Agents & AI Apps status indicator without touching the ledger", async () => {
    const ledger = new MemoryDeliveryLedger();
    const send = vi.fn(async () => ({ status: 200, headers: {}, body: { ok: true } }));
    const adapter = new SlackDeliveryAdapter({
      ledger,
      authorization: { authorize: async () => "allowed" },
      http: { send },
    });

    await adapter.setStatus(
      { destination: "C-OPS", threadId: "1784999999.000001", status: "is thinking…" },
      "xoxb-leased"
    );

    expect(send).toHaveBeenCalledWith(
      {
        method: "POST",
        path: "/assistant.threads.setStatus",
        body: { channel_id: "C-OPS", thread_ts: "1784999999.000001", status: "is thinking…" },
      },
      "xoxb-leased"
    );
    expect(ledger.failures).toHaveLength(0);
  });
});
