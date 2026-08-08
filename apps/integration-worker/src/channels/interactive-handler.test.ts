import type { IntegrationHttpPort } from "@tulipfarm/integrations";
import { describe, expect, it, vi } from "vitest";
import type { InternalApiClient } from "../internal/client";
import { handleSlackInteractive } from "./interactive-handler";

function payload(overrides: Record<string, unknown> = {}): unknown {
  return {
    type: "block_actions",
    user: { id: "U1" },
    channel: { id: "C1" },
    message: { ts: "1785000000.0002" },
    actions: [
      {
        action_id: "channel_approval_decide",
        value: JSON.stringify({ approvalId: "approval-1", decision: "approved" }),
      },
    ],
    ...overrides,
  };
}

describe("handleSlackInteractive", () => {
  it("decides the approval and updates the message on success", async () => {
    const internalApi = {
      require: vi.fn().mockResolvedValue({ outcome: "resumed" }),
    } as unknown as InternalApiClient;
    const send = vi.fn().mockResolvedValue({ body: { ok: true } });
    const http = { send } as unknown as IntegrationHttpPort;

    await handleSlackInteractive(payload(), {
      provider: "slack",
      internalApi,
      http,
      credential: "xoxb-leased",
      log: { warn: vi.fn() },
    });

    expect(internalApi.require).toHaveBeenCalledWith(
      "POST",
      "/api/v1/internal/channels/approvals/approval-1/decide",
      { provider: "slack", externalSubject: "U1", decision: "approved" }
    );
    expect(send).toHaveBeenCalledWith(
      {
        method: "POST",
        path: "/chat.update",
        body: { channel: "C1", ts: "1785000000.0002", text: "Approved by <@U1>" },
      },
      "xoxb-leased"
    );
  });

  it("updates the message to explain an unlinked clicker", async () => {
    const internalApi = {
      require: vi.fn().mockResolvedValue({ outcome: "unlinked" }),
    } as unknown as InternalApiClient;
    const send = vi.fn().mockResolvedValue({ body: { ok: true } });
    const http = { send } as unknown as IntegrationHttpPort;

    await handleSlackInteractive(payload(), {
      provider: "slack",
      internalApi,
      http,
      credential: "xoxb-leased",
      log: { warn: vi.fn() },
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          text: "This Slack account isn't linked to a Tulip user — approval not recorded.",
        }),
      }),
      "xoxb-leased"
    );
  });

  it("ignores a non-block_actions payload", async () => {
    const internalApi = { require: vi.fn() } as unknown as InternalApiClient;
    const http = { send: vi.fn() } as unknown as IntegrationHttpPort;

    await handleSlackInteractive(
      { type: "view_submission" },
      {
        provider: "slack",
        internalApi,
        http,
        credential: "xoxb-leased",
        log: { warn: vi.fn() },
      }
    );

    expect(internalApi.require).not.toHaveBeenCalled();
  });

  it("ignores a malformed action value", async () => {
    const internalApi = { require: vi.fn() } as unknown as InternalApiClient;
    const http = { send: vi.fn() } as unknown as IntegrationHttpPort;

    await handleSlackInteractive(
      payload({ actions: [{ action_id: "channel_approval_decide", value: "not-json" }] }),
      {
        provider: "slack",
        internalApi,
        http,
        credential: "xoxb-leased",
        log: { warn: vi.fn() },
      }
    );

    expect(internalApi.require).not.toHaveBeenCalled();
  });

  it("routes an sf_ handle click to the internal surfaces interactions route", async () => {
    const internalApi = {
      require: vi.fn().mockResolvedValue({}),
    } as unknown as InternalApiClient;
    const http = { send: vi.fn() } as unknown as IntegrationHttpPort;

    await handleSlackInteractive(
      payload({ actions: [{ action_id: "sf_abc123", value: "sf_abc123" }] }),
      {
        provider: "slack",
        internalApi,
        http,
        credential: "xoxb-leased",
        log: { warn: vi.fn() },
      }
    );

    expect(internalApi.require).toHaveBeenCalledWith(
      "POST",
      "/api/v1/internal/surfaces/interactions",
      { handle: "sf_abc123", provider: "slack", externalSubject: "U1", input: {} }
    );
    expect(http.send).not.toHaveBeenCalled();
  });

  it("forwards a selected static-select option as input.value for an sf_ handle", async () => {
    const internalApi = {
      require: vi.fn().mockResolvedValue({}),
    } as unknown as InternalApiClient;
    const http = { send: vi.fn() } as unknown as IntegrationHttpPort;

    await handleSlackInteractive(
      payload({
        actions: [{ action_id: "sf_abc123", selected_option: { value: "opt-1" } }],
      }),
      {
        provider: "slack",
        internalApi,
        http,
        credential: "xoxb-leased",
        log: { warn: vi.fn() },
      }
    );

    expect(internalApi.require).toHaveBeenCalledWith(
      "POST",
      "/api/v1/internal/surfaces/interactions",
      { handle: "sf_abc123", provider: "slack", externalSubject: "U1", input: { value: "opt-1" } }
    );
  });

  it("forwards selected multi-select options as input.values for an sf_ handle", async () => {
    const internalApi = {
      require: vi.fn().mockResolvedValue({}),
    } as unknown as InternalApiClient;
    const http = { send: vi.fn() } as unknown as IntegrationHttpPort;

    await handleSlackInteractive(
      payload({
        actions: [
          {
            action_id: "sf_abc123",
            selected_options: [{ value: "opt-1" }, { value: "opt-2" }],
          },
        ],
      }),
      {
        provider: "slack",
        internalApi,
        http,
        credential: "xoxb-leased",
        log: { warn: vi.fn() },
      }
    );

    expect(internalApi.require).toHaveBeenCalledWith(
      "POST",
      "/api/v1/internal/surfaces/interactions",
      {
        handle: "sf_abc123",
        provider: "slack",
        externalSubject: "U1",
        input: { values: ["opt-1", "opt-2"] },
      }
    );
  });

  it("swallows an sf_ handle interaction failure without throwing", async () => {
    const internalApi = {
      require: vi.fn().mockRejectedValue(new Error("boom")),
    } as unknown as InternalApiClient;
    const http = { send: vi.fn() } as unknown as IntegrationHttpPort;
    const warn = vi.fn();

    await expect(
      handleSlackInteractive(
        payload({ actions: [{ action_id: "sf_abc123", value: "sf_abc123" }] }),
        {
          provider: "slack",
          internalApi,
          http,
          credential: "xoxb-leased",
          log: { warn },
        }
      )
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("swallows a decide failure without throwing", async () => {
    const internalApi = {
      require: vi.fn().mockRejectedValue(new Error("boom")),
    } as unknown as InternalApiClient;
    const http = { send: vi.fn() } as unknown as IntegrationHttpPort;
    const warn = vi.fn();

    await expect(
      handleSlackInteractive(payload(), {
        provider: "slack",
        internalApi,
        http,
        credential: "xoxb-leased",
        log: { warn },
      })
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(http.send).not.toHaveBeenCalled();
  });
});
