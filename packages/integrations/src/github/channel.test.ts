import { describe, expect, it, vi } from "vitest";
import type {
  ChannelIdentityPort,
  ChannelInboundStore,
  ChannelRoutingSource,
  ChannelRunStarter,
} from "../channels/ports";
import { GitHubChannelAdapter } from "./channel";

const binding = {
  businessId: "business",
  externalAppId: "1",
  installationId: "2",
  botLogin: "tulipfarm[bot]",
};
const payload = {
  action: "created",
  installation: { id: 2 },
  repository: { full_name: "TulipFarm/tulipfarm" },
  issue: { number: 42 },
  sender: { id: 3, type: "User" },
  comment: { id: 4, user: { id: 3, type: "User" }, body: "@tulipfarm[bot] please help" },
};

function setup() {
  const accept = vi.fn<ChannelInboundStore["accept"]>(async () => ({ outcome: "accepted" }));
  const resolve = vi.fn<ChannelIdentityPort["resolve"]>(async () => ({
    kind: "user",
    id: "linked-user",
  }));
  const load = vi.fn<ChannelRoutingSource["load"]>(async () => ({
    apps: [
      {
        id: "app",
        businessId: "business",
        provider: "github",
        externalAppId: "1",
        credentialRefs: ["secret://native/github"],
        status: "active",
      },
    ],
    integrations: [
      {
        id: "integration",
        businessId: "business",
        appId: "app",
        externalTenantId: "2",
        credentialRef: "secret://native/github",
        status: "active",
      },
    ],
    accessGrants: [
      {
        apiVersion: "tulipfarm.ai/v1",
        kind: "AccessGrant",
        metadata: {
          id: "00000000-0000-4000-8000-000000000001",
          slug: "github-native",
          schemaVersion: 1,
          authoredVersion: 1,
          lifecycle: "active",
        },
        spec: {
          integrationId: "integration",
          principals: [{ kind: "user", id: "linked-user" }],
          actions: ["channels.message.receive"],
          externalTargets: [{ type: "github.repository", ids: ["TulipFarm/tulipfarm"] }],
          delegable: false,
        },
      },
    ],
    routes: [
      {
        id: "route",
        businessId: "business",
        integrationId: "integration",
        agentId: "agent",
        channelId: "TulipFarm/tulipfarm",
        eventTypes: ["message"],
        priority: 1,
        status: "active",
      },
    ],
  }));
  const start = vi.fn<ChannelRunStarter["start"]>(async () => ({
    outcome: "started",
    runId: "run",
  }));
  const adapter = new GitHubChannelAdapter({
    inbound: { accept },
    identities: { resolve },
    routing: { load },
    runs: { start },
    now: () => "2026-09-18T00:00:00Z",
  });
  return { adapter, accept, resolve, load, start };
}

describe("GitHub native human requests", () => {
  it("binds the original linked caller, repository and issue thread", async () => {
    const { adapter, accept, resolve, start } = setup();
    expect(await adapter.receive(binding, "delivery", "issue_comment", payload)).toEqual({
      outcome: "started",
      runId: "run",
    });
    expect(accept).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith({
      businessId: "business",
      provider: "github",
      externalTenantId: "2",
      externalSubject: "3",
    });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: { kind: "user", id: "linked-user" },
        message: expect.objectContaining({
          externalAppId: "1",
          channelId: "TulipFarm/tulipfarm",
          threadId: "42",
          sourceMessageTs: "4",
          text: "please help",
        }),
      })
    );
  });

  it("requires a linked user, not a guest or Conversation owner's identity", async () => {
    const { adapter, resolve, start } = setup();
    resolve.mockResolvedValue({ kind: "guest", id: "guest" });
    expect(await adapter.receive(binding, "delivery", "issue_comment", payload)).toEqual({
      outcome: "denied",
      reason: "external_identity_unmapped",
    });
    expect(start).not.toHaveBeenCalled();
  });

  it("rejects a different installation and ignores unaddressed comments", async () => {
    const { adapter, accept } = setup();
    expect(
      await adapter.receive(
        { ...binding, installationId: "99" },
        "delivery",
        "issue_comment",
        payload
      )
    ).toEqual({ outcome: "denied", reason: "installation_binding_invalid" });
    expect(
      await adapter.receive(binding, "delivery", "issue_comment", {
        ...payload,
        comment: { ...payload.comment, body: "ordinary discussion" },
      })
    ).toEqual({ outcome: "ignored" });
    expect(accept).not.toHaveBeenCalled();
  });

  it("does not turn automated events into assumed human requests", async () => {
    const { adapter, resolve, start } = setup();
    expect(await adapter.receive(binding, "delivery", "push", payload)).toEqual({
      outcome: "ignored",
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});
