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
  TelegramChannelAdapter,
  TelegramDeliveryAdapter,
  TelegramDeliveryError,
  type TelegramUpdate,
} from "./adapter";

const BUSINESS_ID = "business-1";
const APP_ID = "00000000-0000-4000-8000-000000000001";
const INTEGRATION_ID = "00000000-0000-4000-8000-000000000002";
const AGENT_ID = "00000000-0000-4000-8000-000000000003";
const GUEST_ID = "guest-1";
const GUEST_ROLE_ID = "00000000-0000-4000-8000-000000000004";

function grant(): AccessGrantDefinition {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "AccessGrant",
    metadata: {
      id: "00000000-0000-4000-8000-000000000005",
      slug: "telegram-guest-chat",
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "active",
    },
    spec: {
      integrationId: INTEGRATION_ID,
      principals: [{ kind: "role", id: GUEST_ROLE_ID }],
      actions: ["channels.message.receive"],
      externalTargets: [{ type: "telegram.chat", ids: ["-10042"] }],
      delegable: false,
    },
  };
}

function routing(botId = "bot-primary"): ChannelRoutingSnapshot {
  return {
    apps: [
      {
        id: APP_ID,
        businessId: BUSINESS_ID,
        provider: "telegram",
        externalAppId: botId,
        credentialRefs: ["secret://telegram/bot"],
        status: "active",
      },
    ],
    integrations: [
      {
        id: INTEGRATION_ID,
        businessId: BUSINESS_ID,
        appId: APP_ID,
        externalTenantId: botId,
        credentialRef: "secret://telegram/bot",
        status: "active",
      },
    ],
    accessGrants: [grant()],
    routes: [
      {
        id: "route-chat",
        businessId: BUSINESS_ID,
        integrationId: INTEGRATION_ID,
        agentId: AGENT_ID,
        channelId: "-10042",
        eventTypes: ["message"],
        priority: 10,
        status: "active",
      },
    ],
  };
}

function update(): TelegramUpdate {
  return {
    update_id: 9001,
    message: {
      message_id: 77,
      date: 1_785_000_000,
      message_thread_id: 12,
      from: { id: 1234, is_bot: false, username: "alice" },
      chat: { id: -10042, type: "supergroup", title: "Operations" },
      caption: "latest chart",
      photo: [
        { file_id: "photo-small", width: 90, height: 90, file_size: 100 },
        { file_id: "photo-large", width: 1280, height: 720, file_size: 5000 },
      ],
    },
  };
}

describe("TelegramChannelAdapter", () => {
  it("persists before ack and starts a Run as the configured guest with only its own grants", async () => {
    const order: string[] = [];
    let persisted: ChannelInboundEvent | undefined;
    const start = vi.fn(async () => ({ runId: "run-telegram", outcome: "started" as const }));
    const adapter = new TelegramChannelAdapter({
      inbound: {
        accept: async (event) => {
          order.push("persist");
          persisted = event;
          return { outcome: "accepted" };
        },
      },
      identities: {
        resolve: async () => {
          order.push("identity");
          return {
            kind: "guest",
            id: GUEST_ID,
            grantPrincipals: [{ kind: "role", id: GUEST_ROLE_ID }],
          };
        },
      },
      routing: { load: async () => routing() },
      runs: { start },
      now: () => "2026-07-26T10:00:00.000Z",
    });

    const result = await adapter.receive(BUSINESS_ID, "bot-primary", update(), async () => {
      order.push("ack");
    });

    expect(order).toEqual(["persist", "ack", "identity"]);
    expect(result).toEqual({ outcome: "started", runId: "run-telegram" });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: AGENT_ID,
        principal: { kind: "guest", id: GUEST_ID },
      })
    );
    expect(persisted?.data).toEqual({
      externalAppId: "bot-primary",
      channelId: "-10042",
      threadId: "12",
      text: "latest chart",
      media: [
        {
          id: "photo-large",
          kind: "image",
          contentType: "image/jpeg",
          sizeBytes: 5000,
        },
      ],
    });
  });

  it("keeps multiple bots isolated by the configured external App identity", async () => {
    const load = vi.fn(async (input: { externalTenantId: string }) =>
      routing(input.externalTenantId)
    );
    const start = vi.fn(async () => ({ runId: "run-1", outcome: "started" as const }));
    const adapter = new TelegramChannelAdapter({
      inbound: { accept: async () => ({ outcome: "accepted" }) },
      identities: {
        resolve: async () => ({
          kind: "guest",
          id: GUEST_ID,
          grantPrincipals: [{ kind: "role", id: GUEST_ROLE_ID }],
        }),
      },
      routing: { load },
      runs: { start },
      now: () => "2026-07-26T10:00:00.000Z",
    });

    await adapter.receive(BUSINESS_ID, "bot-primary", update(), async () => undefined);
    await adapter.receive(
      BUSINESS_ID,
      "bot-secondary",
      { ...update(), update_id: 9002 },
      async () => undefined
    );

    expect(load.mock.calls.map(([input]) => input.externalTenantId)).toEqual([
      "bot-primary",
      "bot-secondary",
    ]);
  });

  it("denies an unmapped user and drops bot-authored loop messages before persistence", async () => {
    const start = vi.fn();
    const accept = vi.fn(async () => ({ outcome: "accepted" as const }));
    const adapter = new TelegramChannelAdapter({
      inbound: { accept },
      identities: { resolve: async () => undefined },
      routing: { load: async () => routing() },
      runs: { start },
      now: () => "2026-07-26T10:00:00.000Z",
    });

    expect(
      await adapter.receive(BUSINESS_ID, "bot-primary", update(), async () => undefined)
    ).toEqual({ outcome: "denied", reason: "external_identity_unmapped" });
    expect(start).not.toHaveBeenCalled();

    await expect(
      adapter.receive(
        BUSINESS_ID,
        "bot-primary",
        {
          ...update(),
          update_id: 9002,
          message: {
            ...update().message,
            from: { id: 999, is_bot: true },
          },
        },
        async () => undefined
      )
    ).rejects.toThrow("telegram_update_rejected:bot_message");
    expect(accept).toHaveBeenCalledOnce();
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
  routeId: "route-chat",
  idempotencyKey: "telegram-delivery-1",
  provider: "telegram",
  destination: "-10042",
  agentId: AGENT_ID,
  principalId: GUEST_ID,
};

describe("TelegramDeliveryAdapter", () => {
  it("delivers once with escaped visible Agent attribution and thread identity", async () => {
    const ledger = new MemoryDeliveryLedger();
    const send = vi.fn(async () => ({
      status: 200,
      headers: {},
      body: { ok: true, result: { message_id: 88 } },
    }));
    const adapter = new TelegramDeliveryAdapter({
      ledger,
      authorization: { authorize: async () => "allowed" },
      http: { send },
    });

    const result = await adapter.deliver(
      {
        ...attempt,
        text: "Ready <now>",
        agentDisplayName: "Ops & Safety",
        threadId: "12",
      },
      "123456:leased-token"
    );

    expect(result).toMatchObject({ status: "confirmed", providerMessageId: "88" });
    expect(send).toHaveBeenCalledWith(
      {
        method: "POST",
        path: "/sendMessage",
        body: {
          chat_id: "-10042",
          message_thread_id: 12,
          text: "<b>Ops &amp; Safety</b>\nReady &lt;now&gt;",
          parse_mode: "HTML",
        },
      },
      "123456:leased-token"
    );
  });

  it("records Telegram retry_after and refuses immediate duplicate dispatch", async () => {
    const ledger = new MemoryDeliveryLedger();
    const send = vi.fn(async () => ({
      status: 429,
      headers: {},
      body: { ok: false, parameters: { retry_after: 9 } },
    }));
    const adapter = new TelegramDeliveryAdapter({
      ledger,
      authorization: { authorize: async () => "allowed" },
      http: { send },
    });

    await expect(
      adapter.deliver({ ...attempt, text: "hello", agentDisplayName: "Agent" }, "leased-token")
    ).rejects.toEqual(new TelegramDeliveryError("provider_rate_limited"));
    expect(ledger.failures).toContainEqual({
      status: "retry_wait",
      code: "provider_rate_limited",
      retryAfterMs: 9000,
    });

    await expect(
      adapter.deliver({ ...attempt, text: "hello", agentDisplayName: "Agent" }, "leased-token")
    ).rejects.toEqual(new TelegramDeliveryError("delivery_in_progress"));
    expect(send).toHaveBeenCalledOnce();
  });

  it("reauthorizes every attempt and records revocation without provider dispatch", async () => {
    const ledger = new MemoryDeliveryLedger();
    const send = vi.fn();
    const adapter = new TelegramDeliveryAdapter({
      ledger,
      authorization: { authorize: async () => "revoked" },
      http: { send },
    });

    await expect(
      adapter.deliver({ ...attempt, text: "hello", agentDisplayName: "Agent" }, "leased-token")
    ).rejects.toEqual(new TelegramDeliveryError("integration_revoked"));
    expect(ledger.failures).toContainEqual({
      status: "revoked",
      code: "integration_revoked",
    });
    expect(send).not.toHaveBeenCalled();
  });
});
