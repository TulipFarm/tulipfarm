import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IntegrationHttpPort } from "@tulipfarm/integrations";
import { describe, expect, it, vi } from "vitest";
import { type InternalApiClient, InternalApiError } from "../internal/client";
import {
  HANDLED_SLACK_SHORTCUT_CALLBACKS,
  handleSlackInteractive,
  handleSlackResponseInteractive,
  reserveSlackInteractive,
  reserveSlackResponseInteractive,
  reserveSlackSlashCommand,
} from "./interactive-handler";

const SURFACE_INTERACTION = {
  id: "interaction-1",
  artifactId: "artifact-1",
  revision: 1,
  event: "submit",
  input: {},
  principal: "user-1",
  target: { channel: "slack", surface: "modal" },
  destination: "conversation:1",
  occurredAt: "2026-09-07T10:00:00.000Z",
};

const SLACK_MANIFEST = readFileSync(
  join(import.meta.dirname, "../../../../integrations/slack/manifest.yml"),
  "utf8"
);

function payload(overrides: Record<string, unknown> = {}): unknown {
  return {
    type: "block_actions",
    user: { id: "U1" },
    team: { id: "T1" },
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
  it("advertises only shortcut callbacks with real handlers", () => {
    const advertised = [...SLACK_MANIFEST.matchAll(/^\s+callback_id:\s*(\S+)\s*$/gm)].map(
      (match) => match[1]
    );

    expect(advertised).toEqual([...HANDLED_SLACK_SHORTCUT_CALLBACKS]);
    expect(SLACK_MANIFEST).toContain("command: /tulipfarm");
  });

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
      {
        provider: "slack",
        externalSubject: "U1",
        externalTenantId: "T1",
        decision: "approved",
      }
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

  it("uses the enterprise ID when a block action has no workspace ID", async () => {
    const internalApi = {
      require: vi.fn().mockResolvedValue({ outcome: "resumed" }),
    } as unknown as InternalApiClient;

    await handleSlackInteractive(payload({ team: undefined, enterprise: { id: "E1" } }), {
      provider: "slack",
      internalApi,
      http: { send: vi.fn().mockResolvedValue({ body: { ok: true } }) },
      credential: "xoxb-leased",
      log: { warn: vi.fn() },
    });

    expect(internalApi.require).toHaveBeenCalledWith(
      "POST",
      "/api/v1/internal/channels/approvals/approval-1/decide",
      expect.objectContaining({ externalTenantId: "E1" })
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
      {
        handle: "sf_abc123",
        provider: "slack",
        externalSubject: "U1",
        externalTenantId: "T1",
        input: {},
      }
    );
    expect(http.send).not.toHaveBeenCalled();
  });

  it("defers Surface action processing until after its durable reservation returns", async () => {
    const internalApi = {
      require: vi
        .fn()
        .mockResolvedValueOnce(SURFACE_INTERACTION)
        .mockResolvedValueOnce({ outcome: "processed" }),
    } as unknown as InternalApiClient;

    const followUp = await reserveSlackInteractive(
      payload({ actions: [{ action_id: "sf_abc123", value: "sf_abc123" }] }),
      {
        provider: "slack",
        internalApi,
        http: { send: vi.fn() } as unknown as IntegrationHttpPort,
        credential: "xoxb-leased",
        log: { warn: vi.fn() },
      }
    );

    expect(internalApi.require).toHaveBeenCalledTimes(1);
    await followUp?.();
    expect(internalApi.require).toHaveBeenNthCalledWith(
      2,
      "POST",
      "/api/v1/internal/surfaces/interactions/interaction-1/process"
    );
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
      {
        handle: "sf_abc123",
        provider: "slack",
        externalSubject: "U1",
        externalTenantId: "T1",
        input: { value: "opt-1" },
      }
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
        externalTenantId: "T1",
        input: { values: ["opt-1", "opt-2"] },
      }
    );
  });

  it.each([
    ["plain_text_input", { value: "hello" }, "hello"],
    ["datepicker", { selected_date: "2026-09-07" }, "2026-09-07"],
    ["timepicker", { selected_time: "10:45" }, "10:45"],
    ["datetimepicker", { selected_date_time: 1_788_773_400 }, "2026-09-07T09:30:00.000Z"],
    ["users_select", { selected_user: "U2" }, "U2"],
    ["channels_select", { selected_channel: "C2" }, "C2"],
    ["conversations_select", { selected_conversation: "D2" }, "D2"],
    ["external_select", { selected_option: { value: "ext-1" } }, "ext-1"],
  ])("decodes %s block actions to provider-neutral input", async (type, selection, expected) => {
    const internalApi = {
      require: vi.fn().mockResolvedValue({}),
    } as unknown as InternalApiClient;

    await handleSlackInteractive(
      payload({
        actions: [{ action_id: "sf_abc123", type, ...selection }],
      }),
      {
        provider: "slack",
        internalApi,
        http: { send: vi.fn() } as unknown as IntegrationHttpPort,
        credential: "xoxb-leased",
        log: { warn: vi.fn() },
      }
    );

    expect(internalApi.require).toHaveBeenCalledWith(
      "POST",
      "/api/v1/internal/surfaces/interactions",
      expect.objectContaining({ input: { value: expected } })
    );
  });

  it("returns modal acknowledgement work before dispatching the reserved interaction", async () => {
    const internalApi = {
      require: vi
        .fn()
        .mockResolvedValueOnce(SURFACE_INTERACTION)
        .mockResolvedValueOnce({ outcome: "processed" }),
    } as unknown as InternalApiClient;

    const reserved = await reserveSlackResponseInteractive(
      {
        type: "view_submission",
        user: { id: "U1" },
        team: { id: "T1" },
        view: { callback_id: "sf_form", state: { values: {} } },
      },
      {
        provider: "slack",
        internalApi,
        http: { send: vi.fn() } as unknown as IntegrationHttpPort,
        credential: "xoxb-leased",
        log: { warn: vi.fn() },
      }
    );

    expect(reserved.acknowledgement).toEqual({});
    expect(internalApi.require).toHaveBeenCalledTimes(1);
    await reserved.followUp?.();
    expect(internalApi.require).toHaveBeenNthCalledWith(
      2,
      "POST",
      "/api/v1/internal/surfaces/interactions/interaction-1/process"
    );
  });

  it("decodes a view submission and returns an empty acknowledgement", async () => {
    const internalApi = {
      require: vi.fn().mockResolvedValue(SURFACE_INTERACTION),
    } as unknown as InternalApiClient;

    const response = await handleSlackResponseInteractive(
      {
        type: "view_submission",
        user: { id: "U1" },
        team: { id: "T1" },
        view: {
          callback_id: "sf_form",
          state: {
            values: {
              email: { email: { type: "email_text_input", value: "person@example.com" } },
              quantity: { quantity: { type: "number_input", value: "12.50" } },
              notify: {
                notify: {
                  type: "checkboxes",
                  selected_options: [{ value: "Email" }, { value: "SMS" }],
                },
              },
              region: {
                region: { type: "radio_buttons", selected_option: { value: "EU" } },
              },
              plan: {
                plan: { type: "static_select", selected_option: { value: "Pro" } },
              },
              tags: {
                tags: {
                  type: "multi_static_select",
                  selected_options: [{ value: "A" }, { value: "B" }],
                },
              },
              when: { when: { type: "datetimepicker", selected_date_time: 1_788_773_400 } },
              reviewers: {
                reviewers: {
                  type: "multi_external_select",
                  selected_options: [{ value: "U2" }, { value: "U3" }],
                },
              },
              brief: {
                brief: {
                  type: "rich_text_input",
                  rich_text_value: {
                    type: "rich_text",
                    elements: [
                      {
                        type: "rich_text_section",
                        elements: [
                          { type: "text", text: "Review " },
                          { type: "user", user_id: "U2" },
                        ],
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
      {
        provider: "slack",
        internalApi,
        http: { send: vi.fn() } as unknown as IntegrationHttpPort,
        credential: "xoxb-leased",
        log: { warn: vi.fn() },
      }
    );

    expect(response).toEqual({});
    expect(internalApi.require).toHaveBeenCalledWith(
      "POST",
      "/api/v1/internal/surfaces/interactions",
      {
        handle: "sf_form",
        provider: "slack",
        externalSubject: "U1",
        externalTenantId: "T1",
        input: {
          email: "person@example.com",
          quantity: "12.50",
          notify: ["Email", "SMS"],
          region: "EU",
          plan: "Pro",
          tags: ["A", "B"],
          when: "2026-09-07T09:30:00.000Z",
          reviewers: ["U2", "U3"],
          brief: "Review <@U2>",
        },
      }
    );
  });

  it("uses the enterprise ID when a view submission has no workspace ID", async () => {
    const internalApi = {
      require: vi.fn().mockResolvedValue(SURFACE_INTERACTION),
    } as unknown as InternalApiClient;

    const response = await handleSlackResponseInteractive(
      {
        type: "view_submission",
        user: { id: "U1" },
        enterprise: { id: "E1" },
        view: { callback_id: "sf_form", state: { values: {} } },
      },
      {
        provider: "slack",
        internalApi,
        http: { send: vi.fn() } as unknown as IntegrationHttpPort,
        credential: "xoxb-leased",
        log: { warn: vi.fn() },
      }
    );

    expect(response).toEqual({});
    expect(internalApi.require).toHaveBeenCalledWith(
      "POST",
      "/api/v1/internal/surfaces/interactions",
      expect.objectContaining({ externalTenantId: "E1" })
    );
  });

  it("keeps a Slack file upload out of provider-neutral form input", async () => {
    const internalApi = { require: vi.fn() } as unknown as InternalApiClient;

    const response = await handleSlackResponseInteractive(
      {
        type: "view_submission",
        user: { id: "U1" },
        team: { id: "T1" },
        view: {
          callback_id: "sf_form",
          state: {
            values: {
              files: { files: { type: "file_input", files: [{ id: "F-SLACK" }] } },
            },
          },
        },
      },
      {
        provider: "slack",
        internalApi,
        http: { send: vi.fn() } as unknown as IntegrationHttpPort,
        credential: "xoxb-leased",
        log: { warn: vi.fn() },
      }
    );

    expect(response).toEqual({
      response_action: "errors",
      errors: {
        files:
          "Slack file uploads cannot be submitted here yet. Choose an existing TulipFarm File.",
      },
    });
    expect(internalApi.require).not.toHaveBeenCalled();
  });

  it("returns safe field errors for a known view submission rejection", async () => {
    const internalApi = {
      require: vi
        .fn()
        .mockRejectedValue(
          new InternalApiError(
            400,
            "POST",
            "/api/v1/internal/surfaces/interactions",
            JSON.stringify({ code: "invalid_input" })
          )
        ),
    } as unknown as InternalApiClient;

    const response = await handleSlackResponseInteractive(
      {
        type: "view_submission",
        user: { id: "U1" },
        team: { id: "T1" },
        view: {
          private_metadata: JSON.stringify({ handle: "sf_form" }),
          state: { values: { email: { email: { value: "bad" } } } },
        },
      },
      {
        provider: "slack",
        internalApi,
        http: { send: vi.fn() } as unknown as IntegrationHttpPort,
        credential: "xoxb-leased",
        log: { warn: vi.fn() },
      }
    );

    expect(response).toEqual({
      response_action: "errors",
      errors: { email: "This form could not be submitted. Please review it and try again." },
    });
  });

  it("treats a replayed view submission as successful", async () => {
    const internalApi = {
      require: vi
        .fn()
        .mockRejectedValue(
          new InternalApiError(
            400,
            "POST",
            "/api/v1/internal/surfaces/interactions",
            JSON.stringify({ code: "replayed" })
          )
        ),
    } as unknown as InternalApiClient;

    await expect(
      handleSlackResponseInteractive(
        {
          type: "view_submission",
          user: { id: "U1" },
          team: { id: "T1" },
          view: {
            callback_id: "sf_form",
            state: { values: { email: { email: { value: "person@example.com" } } } },
          },
        },
        {
          provider: "slack",
          internalApi,
          http: { send: vi.fn() } as unknown as IntegrationHttpPort,
          credential: "xoxb-leased",
          log: { warn: vi.fn() },
        }
      )
    ).resolves.toEqual({});
  });

  it("does not convert an unknown API failure into a Slack validation acknowledgement", async () => {
    const failure = new InternalApiError(
      503,
      "POST",
      "/api/v1/internal/surfaces/interactions",
      "unavailable"
    );
    const internalApi = {
      require: vi.fn().mockRejectedValue(failure),
    } as unknown as InternalApiClient;

    await expect(
      handleSlackResponseInteractive(
        {
          type: "view_submission",
          user: { id: "U1" },
          team: { id: "T1" },
          view: {
            callback_id: "sf_form",
            state: { values: { email: { email: { value: "person@example.com" } } } },
          },
        },
        {
          provider: "slack",
          internalApi,
          http: { send: vi.fn() } as unknown as IntegrationHttpPort,
          credential: "xoxb-leased",
          log: { warn: vi.fn() },
        }
      )
    ).rejects.toBe(failure);
  });

  it("does not acknowledge an unknown successful API result", async () => {
    const internalApi = {
      require: vi.fn().mockResolvedValue({}),
    } as unknown as InternalApiClient;

    await expect(
      handleSlackResponseInteractive(
        {
          type: "view_submission",
          user: { id: "U1" },
          team: { id: "T1" },
          view: {
            callback_id: "sf_form",
            state: {
              values: {
                email: { email_input: { type: "email_text_input", value: "m@e.com" } },
              },
            },
          },
        },
        {
          provider: "slack",
          internalApi,
          http: { send: vi.fn() } as unknown as IntegrationHttpPort,
          credential: "xoxb-leased",
          log: { warn: vi.fn() },
        }
      )
    ).rejects.toThrow("slack_surface_interaction_unknown_result");
  });

  it("returns an empty options response for block suggestions", async () => {
    const response = await handleSlackResponseInteractive(
      { type: "block_suggestion", user: { id: "U1" }, action_id: "field", value: "mu" },
      {
        provider: "slack",
        internalApi: { require: vi.fn() } as unknown as InternalApiClient,
        http: { send: vi.fn() } as unknown as IntegrationHttpPort,
        credential: "xoxb-leased",
        log: { warn: vi.fn() },
      }
    );

    expect(response).toEqual({ options: [] });
  });

  it("treats view_closed and shortcuts as explicit no-ops", async () => {
    const internalApi = { require: vi.fn() } as unknown as InternalApiClient;
    const deps = {
      provider: "slack",
      internalApi,
      http: { send: vi.fn() } as unknown as IntegrationHttpPort,
      credential: "xoxb-leased",
      log: { warn: vi.fn() },
    };

    await handleSlackInteractive({ type: "view_closed", user: { id: "U1" } }, deps);
    await handleSlackInteractive(
      { type: "shortcut", callback_id: "tulipfarm_ask", user: { id: "U1" } },
      deps
    );
    await handleSlackInteractive(
      { type: "message_action", callback_id: "tulipfarm_ask_about_message", user: { id: "U1" } },
      deps
    );

    expect(internalApi.require).not.toHaveBeenCalled();
  });

  it("reserves a response_url delivery before ack and processes it afterwards", async () => {
    const send = vi.fn().mockResolvedValue({ status: 200, headers: {}, body: { ok: true } });
    const start = vi.fn().mockResolvedValue({ runId: "run-1", outcome: "started" });
    const principal = { kind: "user" as const, id: "user-1" };
    const resolve = vi.fn().mockResolvedValue(principal);
    const require = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "reserved" })
      .mockResolvedValueOnce({ attempted: 1, delivered: 1 });

    const followUp = await reserveSlackSlashCommand(
      {
        command: "/tulipfarm",
        user_id: "U1",
        channel_id: "C1",
        team_id: "T1",
        api_app_id: "A1",
        trigger_id: "trigger-1",
        response_url: "https://hooks.slack.com/commands/1/2/3",
        text: "Review the queue",
      },
      "env-command",
      {
        businessId: "business-1",
        provider: "slack",
        internalApi: { require } as unknown as InternalApiClient,
        identities: { resolve },
        routing: {
          load: vi.fn().mockResolvedValue({
            apps: [
              {
                id: "app-1",
                businessId: "business-1",
                provider: "slack",
                externalAppId: "A1",
                credentialRefs: ["secret://slack/bot"],
                status: "active",
              },
            ],
            integrations: [
              {
                id: "integration-1",
                businessId: "business-1",
                appId: "app-1",
                externalTenantId: "T1",
                status: "active",
              },
            ],
            accessGrants: [
              {
                apiVersion: "tulipfarm.ai/v1",
                kind: "AccessGrant",
                metadata: {
                  id: "grant-1",
                  slug: "slack-command",
                  schemaVersion: 1,
                  authoredVersion: 1,
                  lifecycle: "active",
                },
                spec: {
                  integrationId: "integration-1",
                  principals: [{ kind: "user", id: "user-1" }],
                  actions: ["channels.message.receive"],
                  externalTargets: [{ type: "slack.channel", ids: ["C1"] }],
                  delegable: false,
                },
              },
            ],
            routes: [
              {
                id: "route-1",
                businessId: "business-1",
                integrationId: "integration-1",
                agentId: "agent-1",
                eventTypes: ["message"],
                priority: 1,
                status: "active",
                channelId: "C1",
              },
            ],
          }),
        },
        runs: { start },
        http: { send } as unknown as IntegrationHttpPort,
        credential: "xoxb-leased",
        log: { warn: vi.fn() },
      }
    );

    expect(start).toHaveBeenCalledWith({
      businessId: "business-1",
      eventId: "slack-command:T1:trigger-1",
      integrationId: "integration-1",
      routeId: "route-1",
      agentId: "agent-1",
      principal,
      message: {
        externalAppId: "A1",
        channelId: "C1",
        text: "Review the queue",
        media: [],
      },
    });
    expect(resolve).toHaveBeenCalledWith({
      businessId: "business-1",
      provider: "slack",
      externalSubject: "U1",
      externalTenantId: "T1",
    });
    expect(require).toHaveBeenCalledWith(
      "POST",
      "/api/v1/internal/channels/slack/command-responses",
      {
        idempotencyKey: "slack-command-response:T1:trigger-1",
        responseUrl: "https://hooks.slack.com/commands/1/2/3",
        response: "starting",
      }
    );
    expect(send).not.toHaveBeenCalled();

    await followUp?.();
    expect(require).toHaveBeenLastCalledWith(
      "POST",
      "/api/v1/internal/channels/slack/command-responses/process?idempotencyKey=slack-command-response%3AT1%3Atrigger-1"
    );
  });

  it("uses the durable response URL path when the prompt modal cannot be launched", async () => {
    const require = vi.fn().mockResolvedValue({ outcome: "reserved" });
    const start = vi.fn();

    const followUp = await reserveSlackSlashCommand(
      {
        command: "/tulipfarm",
        user_id: "U1",
        channel_id: "C1",
        team_id: "T1",
        api_app_id: "A1",
        trigger_id: "trigger-1",
        response_url: "https://hooks.slack.com/commands/1/2/3",
        text: "",
      },
      "env-command",
      {
        businessId: "business-1",
        provider: "slack",
        internalApi: { require } as unknown as InternalApiClient,
        identities: { resolve: vi.fn() },
        routing: { load: vi.fn() },
        runs: { start },
        http: { send: vi.fn() } as unknown as IntegrationHttpPort,
        credential: "xoxb-leased",
        log: { warn: vi.fn() },
      }
    );

    expect(require).toHaveBeenCalledWith(
      "POST",
      "/api/v1/internal/channels/slack/command-responses",
      {
        idempotencyKey: "slack-command-response:T1:trigger-1",
        responseUrl: "https://hooks.slack.com/commands/1/2/3",
        response: "prompt_unavailable",
      }
    );
    expect(start).not.toHaveBeenCalled();
    expect(followUp).toBeTypeOf("function");
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
