import type {
  SlackKnowledgeApiPort,
  SlackKnowledgeChannel,
  SlackKnowledgeMessage,
} from "@tulipfarm/integrations";
import type { SecretsService } from "@tulipfarm/secrets";
import type { IntegrationStore, PersistedRoutingSnapshot } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import type { IdentityVerificationMethod } from "../identity/external-links";
import { MemoryExternalIdentityRepo } from "../identity/fakes";
import { SlackLiveSourceAuthorization, SlackTenantLiveAuthorization } from "./live-authorization";

const { SlackHttpKnowledgeApi } = vi.hoisted(() => ({
  SlackHttpKnowledgeApi: vi.fn(),
}));

vi.mock("./slack-http", () => ({ SlackHttpKnowledgeApi }));

function stubApi(
  members: readonly string[] | undefined | (() => Promise<never>)
): SlackKnowledgeApiPort {
  return {
    listChannels(): Promise<readonly SlackKnowledgeChannel[]> {
      return Promise.resolve([]);
    },
    listMembers(): Promise<readonly string[] | undefined> {
      if (typeof members === "function") return members();
      return Promise.resolve(members);
    },
    listMessages(): Promise<{
      readonly messages: readonly SlackKnowledgeMessage[];
      readonly nextCursor?: string;
    }> {
      return Promise.resolve({ messages: [] });
    },
  };
}

const BUSINESS = "biz-1";
const CHANNEL = "C1";

function baseInput(principals: { kind: string; id: string }[]) {
  return {
    businessId: BUSINESS,
    sourceId: `slack:T1:${CHANNEL}`,
    provider: "slack",
    externalId: CHANNEL,
    principals,
  };
}

describe("SlackLiveSourceAuthorization", () => {
  it("allows when a mapped Slack identity is a current channel member", async () => {
    const identity = new MemoryExternalIdentityRepo();
    identity.mappings.push({
      provider: "slack",
      externalSubject: "U1",
      userId: "user-1",
      verifiedAt: new Date(),
      expiresAt: null,
      verifiedVia: "link_token",
    });
    const auth = new SlackLiveSourceAuthorization(stubApi(["U1", "U2"]), identity);

    const result = await auth.check(baseInput([{ kind: "user", id: "user-1" }]));

    expect(result).toEqual({ allowed: true });
  });

  it("denies when the mapped Slack identity is not a channel member", async () => {
    const identity = new MemoryExternalIdentityRepo();
    identity.mappings.push({
      provider: "slack",
      externalSubject: "U9",
      userId: "user-1",
      verifiedAt: new Date(),
      expiresAt: null,
      verifiedVia: "link_token",
    });
    const auth = new SlackLiveSourceAuthorization(stubApi(["U1", "U2"]), identity);

    const result = await auth.check(baseInput([{ kind: "user", id: "user-1" }]));

    expect(result).toEqual({ allowed: false });
  });

  it("denies when the principal has no Slack mapping at all", async () => {
    const identity = new MemoryExternalIdentityRepo();
    const auth = new SlackLiveSourceAuthorization(stubApi(["U1"]), identity);

    const result = await auth.check(baseInput([{ kind: "user", id: "user-1" }]));

    expect(result).toEqual({ allowed: false });
  });

  it("ignores an expired mapping — treated as unmapped, not a grant", async () => {
    const identity = new MemoryExternalIdentityRepo();
    identity.mappings.push({
      provider: "slack",
      externalSubject: "U1",
      userId: "user-1",
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() - 60_000),
      verifiedVia: "link_token",
    });
    const auth = new SlackLiveSourceAuthorization(stubApi(["U1"]), identity);

    const result = await auth.check(baseInput([{ kind: "user", id: "user-1" }]));

    expect(result).toEqual({ allowed: false });
  });

  it("ignores non-user principals (e.g. role refs) — they carry no Slack identity", async () => {
    const identity = new MemoryExternalIdentityRepo();
    const auth = new SlackLiveSourceAuthorization(stubApi(["U1"]), identity);

    const result = await auth.check(baseInput([{ kind: "role", id: "admin" }]));

    expect(result).toEqual({ allowed: false });
  });

  it("returns undefined (unresolvable) when membership is unreadable", async () => {
    const identity = new MemoryExternalIdentityRepo();
    const auth = new SlackLiveSourceAuthorization(stubApi(undefined), identity);

    const result = await auth.check(baseInput([{ kind: "user", id: "user-1" }]));

    expect(result).toBeUndefined();
  });

  it("returns undefined (unresolvable) rather than throwing when the provider errors", async () => {
    const identity = new MemoryExternalIdentityRepo();
    const auth = new SlackLiveSourceAuthorization(
      stubApi(() => Promise.reject(new Error("slack_api_error:internal_error"))),
      identity
    );

    const result = await auth.check(baseInput([{ kind: "user", id: "user-1" }]));

    expect(result).toBeUndefined();
  });

  it("returns undefined for a non-Slack provider — this port only speaks Slack", async () => {
    const identity = new MemoryExternalIdentityRepo();
    const auth = new SlackLiveSourceAuthorization(stubApi(["U1"]), identity);

    const result = await auth.check({
      ...baseInput([{ kind: "user", id: "user-1" }]),
      provider: "github",
    });

    expect(result).toBeUndefined();
  });

  // Live authorization covers exactly the sensitive Slack sources — private channels, DMs and
  // group DMs. Public channels use a captured snapshot instead. So a verification grade enforced
  // only on the snapshot path would secure the public content and leave the private content open,
  // which is the wrong way round. See ticket 06.
  describe("verification grade", () => {
    const checkVia = async (verifiedVia: IdentityVerificationMethod | null) => {
      const identity = new MemoryExternalIdentityRepo();
      identity.mappings.push({
        provider: "slack",
        externalSubject: "U1",
        userId: "user-1",
        verifiedAt: new Date(),
        expiresAt: null,
        verifiedVia,
      });
      const auth = new SlackLiveSourceAuthorization(stubApi(["U1", "U2"]), identity);
      return auth.check(baseInput([{ kind: "user", id: "user-1" }]));
    };

    it.each(["link_token", "bind_link"] as const)(
      "allows a current member mapped via %s",
      async (method) => {
        expect(await checkVia(method)).toEqual({ allowed: true });
      }
    );

    it("denies a current member whose mapping came from a provider-asserted email", async () => {
      expect(await checkVia("manifest_email")).toEqual({ allowed: false });
    });

    it("denies a current member whose mapping has no recorded provenance", async () => {
      expect(await checkVia(null)).toEqual({ allowed: false });
    });
  });
});

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

describe("SlackTenantLiveAuthorization", () => {
  it("returns undefined for a non-Slack provider without touching integrations or secrets", async () => {
    const integrations = fakeIntegrations(snapshot([]));
    const secrets = fakeSecrets("xoxb-token");
    const identity = new MemoryExternalIdentityRepo();
    const auth = new SlackTenantLiveAuthorization(integrations, secrets, identity);

    const result = await auth.check({ ...baseInput([]), provider: "github" });

    expect(result).toBeUndefined();
    expect(integrations.loadProviderSnapshot).not.toHaveBeenCalled();
    expect(secrets.get).not.toHaveBeenCalled();
  });

  it("returns undefined when no active Slack integration exists", async () => {
    const integrations = fakeIntegrations(
      snapshot([
        {
          id: "slack:app1:T1",
          businessId: BUSINESS,
          appId: "app1",
          externalTenantId: "T1",
          status: "revoked",
        },
      ])
    );
    const secrets = fakeSecrets("xoxb-token");
    const identity = new MemoryExternalIdentityRepo();
    const auth = new SlackTenantLiveAuthorization(integrations, secrets, identity);

    const result = await auth.check(baseInput([{ kind: "user", id: "user-1" }]));

    expect(result).toBeUndefined();
    expect(secrets.get).not.toHaveBeenCalled();
  });

  it("returns undefined when the bot token secret cannot be resolved", async () => {
    const integrations = fakeIntegrations(
      snapshot([
        {
          id: "slack:app1:T1",
          businessId: BUSINESS,
          appId: "app1",
          externalTenantId: "T1",
          status: "active",
        },
      ])
    );
    const secrets = fakeSecrets(undefined);
    const identity = new MemoryExternalIdentityRepo();
    const auth = new SlackTenantLiveAuthorization(integrations, secrets, identity);

    const result = await auth.check(baseInput([{ kind: "user", id: "user-1" }]));

    expect(result).toBeUndefined();
  });

  it("resolves the active integration + token, then delegates to a Slack API check", async () => {
    SlackHttpKnowledgeApi.mockReset();
    SlackHttpKnowledgeApi.mockImplementation(function (this: SlackKnowledgeApiPort) {
      return stubApi(["U1"]);
    });
    const integrations = fakeIntegrations(
      snapshot([
        {
          id: "slack:app1:T1",
          businessId: BUSINESS,
          appId: "app1",
          externalTenantId: "T1",
          status: "active",
        },
      ])
    );
    const secrets = fakeSecrets("xoxb-token");
    const identity = new MemoryExternalIdentityRepo();
    identity.mappings.push({
      provider: "slack",
      externalSubject: "U1",
      userId: "user-1",
      verifiedAt: new Date(),
      expiresAt: null,
      verifiedVia: "link_token",
    });
    const auth = new SlackTenantLiveAuthorization(integrations, secrets, identity);

    const result = await auth.check(baseInput([{ kind: "user", id: "user-1" }]));

    expect(result).toEqual({ allowed: true });
    expect(SlackHttpKnowledgeApi).toHaveBeenCalledWith({ token: "xoxb-token", teamId: "T1" });
  });
});
