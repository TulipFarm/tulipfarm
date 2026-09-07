import type { AuthorityLayer } from "@tulipfarm/authz";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { ConnectionUseAuthorizer } from "@tulipfarm/integrations";
import type { OimConnection } from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import type { SoulLoader } from "@tulipfarm/soul";
import type { PersistedConnection } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { adhocIntegrationId } from "../../integrations/adhoc-connections";
import type { TrackConnectionBroker } from "../../integrations/connection-lease-registry";
import { composeNetworkTools } from "./compose";

function tools(frontmatter: Record<string, unknown>, grants: AuthorityLayer["grants"]) {
  const send = vi.fn(async () => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: { ok: true },
  }));
  const composed = composeNetworkTools({
    secrets: {
      get: vi.fn(async () => "token-value"),
      resolveCurrent: vi.fn(async () => ({ value: "token-value", version: "1" })),
      revision: vi.fn(async () => "1"),
    } as unknown as SecretsService,
    soulLoader: {
      skills: new Map([["jira", { name: "jira", body: "Use Jira.", frontmatter }]]),
    } as unknown as SoulLoader,
    authorityLayers: {
      resolvePrincipalLayer: vi.fn(async () => ({ name: "user", grants })),
    },
    http: { send },
  });
  const apiRequest = composed.find((tool) => tool.name === "api_request");
  if (apiRequest === undefined) throw new Error("api_request was not composed");
  return { apiRequest, send };
}

function connection(overrides: Partial<PersistedConnection> = {}): PersistedConnection {
  return {
    businessId: DEPLOYMENT_BUSINESS_ID,
    id: "connection-1",
    integration: {
      id: adhocIntegrationId("https://api.example.com"),
      majorVersion: 1,
    },
    label: "Example API",
    owner: { scope: "personal", principalKind: "user", principalId: "user-1" },
    status: "active",
    isDefault: true,
    configuration: {
      origin: "https://api.example.com",
      location: "header",
      name: "authorization",
      valuePrefix: "Bearer ",
    },
    agentVisibleConfiguration: ["origin"],
    secretBindings: { credential: "secret://adhoc-1" },
    health: { status: "healthy", checkedAt: null },
    expiresAt: null,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    ...overrides,
  };
}

class MutableConnections {
  row: PersistedConnection;
  onFind?: () => void;

  constructor(row = connection()) {
    this.row = row;
  }

  async findById(businessId: string, id: string): Promise<PersistedConnection | null> {
    this.onFind?.();
    return this.row.businessId === businessId && this.row.id === id ? this.row : null;
  }

  async listForOwner(
    _businessId: string,
    _integration: OimConnection["integration"],
    _owner: OimConnection["owner"]
  ): Promise<PersistedConnection[]> {
    return [this.row];
  }

  async listForIntegration(
    businessId: string,
    integration: OimConnection["integration"]
  ): Promise<PersistedConnection[]> {
    return this.row.businessId === businessId &&
      this.row.integration.id === integration.id &&
      this.row.integration.majorVersion === integration.majorVersion
      ? [this.row]
      : [];
  }
}

function connectionTool(
  connections: MutableConnections,
  connectionAccess?: ConnectionUseAuthorizer,
  trackConnectionBroker?: TrackConnectionBroker
) {
  const send = vi.fn(async () => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: { ok: true },
  }));
  const composed = composeNetworkTools({
    secrets: {
      get: vi.fn(async () => "tok-live"),
      resolveCurrent: vi.fn(async () => ({ value: "tok-live", version: "1" })),
      revision: vi.fn(async () => "1"),
    } as unknown as SecretsService,
    soulLoader: { skills: new Map() } as unknown as SoulLoader,
    authorityLayers: {
      resolvePrincipalLayer: vi.fn(async () => ({ name: "user", grants: [] })),
    },
    connections,
    ...(connectionAccess === undefined ? {} : { connectionAccess }),
    ...(trackConnectionBroker === undefined ? {} : { trackConnectionBroker }),
    http: { send },
  });
  const apiRequest = composed.find((tool) => tool.name === "api_request");
  if (apiRequest === undefined) throw new Error("api_request was not composed");
  return { apiRequest, send };
}

const args = {
  url: "https://api.atlassian.com/me",
  method: "GET",
  credential: { secret: "JIRA_API_TOKEN", header: "authorization" },
};

describe("composed network Tool cancellation", () => {
  it("carries the host's abort signal through to the transport", async () => {
    // The host abandons a Tool that outruns its deadline; without this the socket it opened
    // carries on, and a mutating request can land after the Run recorded it as never having.
    const abortSignal = new AbortController().signal;
    const { apiRequest, send } = tools({}, [{ action: "*", resourceType: "*", effect: "allow" }]);

    const result = await apiRequest.execute(
      { url: "https://api.atlassian.com/me", method: "GET" },
      { userId: "user-1", runId: "run-1", abortSignal }
    );

    expect(result).toMatchObject({ success: true });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ signal: abortSignal }));
  });
});

describe("network Skill Secret authority", () => {
  it("intersects the Skill declaration with the caller's exact secret.use grant", async () => {
    const { apiRequest, send } = tools(
      {
        requiredSecrets: ["JIRA_API_TOKEN"],
        allowedDomains: ["api.atlassian.com"],
      },
      [
        {
          action: "secret.use",
          resourceType: "secret",
          recordSelector: "JIRA_API_TOKEN",
          destination: "https://api.atlassian.com",
          effect: "allow",
        },
      ]
    );
    const result = await apiRequest.execute(args, {
      userId: "user-1",
      runId: "run-1",
      activeSkillName: "jira",
    });
    expect(result).toMatchObject({ success: true });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { authorization: "Bearer token-value" } })
    );
  });

  it("denies a guessed Secret that the active Skill did not declare", async () => {
    const { apiRequest, send } = tools(
      { requiredSecrets: ["OTHER_TOKEN"], allowedDomains: ["api.atlassian.com"] },
      [{ action: "*", resourceType: "*", effect: "allow" }]
    );
    const result = await apiRequest.execute(args, {
      userId: "user-1",
      runId: "run-1",
      activeSkillName: "jira",
    });
    expect(result).toMatchObject({ success: false, error: { code: "write_denied" } });
    expect(send).not.toHaveBeenCalled();
  });

  it("denies a caller without the exact secret.use grant", async () => {
    const { apiRequest, send } = tools(
      {
        requiredSecrets: ["JIRA_API_TOKEN"],
        allowedDomains: ["api.atlassian.com"],
      },
      []
    );
    const result = await apiRequest.execute(args, {
      userId: "user-1",
      runId: "run-1",
      activeSkillName: "jira",
    });
    expect(result).toMatchObject({ success: false, error: { code: "write_denied" } });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("network Skill destination confinement", () => {
  const uncredentialed = { url: "https://api.github.com/repos/tulipfarm/tulipfarm", method: "GET" };

  // A Skill that never mentions the network is not making a claim about it. Reading its silence as
  // an empty allowlist meant loading, say, a Routine-authoring Skill revoked the Agent's ability to
  // read any public URL — a capability *loss* caused by gaining a Skill.
  it("lets a Skill that declares no domains read a public URL", async () => {
    const { apiRequest, send } = tools({}, [{ action: "*", resourceType: "*", effect: "allow" }]);

    const result = await apiRequest.execute(uncredentialed, {
      userId: "user-1",
      runId: "run-1",
      activeSkillName: "jira",
    });

    expect(result).toMatchObject({ success: true });
    expect(send).toHaveBeenCalled();
  });

  it("confines a Skill to the domains it did declare", async () => {
    const { apiRequest, send } = tools({ allowedDomains: ["api.atlassian.com"] }, [
      { action: "*", resourceType: "*", effect: "allow" },
    ]);

    const result = await apiRequest.execute(uncredentialed, {
      userId: "user-1",
      runId: "run-1",
      activeSkillName: "jira",
    });

    expect(result).toMatchObject({ success: false, error: { code: "write_denied" } });
    expect(send).not.toHaveBeenCalled();
  });

  // Absence of a declaration is permission to fall through; absence of the Skill is not, because
  // there is no frontmatter to have read.
  it("denies an active Skill the Soul cannot resolve", async () => {
    const { apiRequest, send } = tools({}, [{ action: "*", resourceType: "*", effect: "allow" }]);

    const result = await apiRequest.execute(uncredentialed, {
      userId: "user-1",
      runId: "run-1",
      activeSkillName: "vanished",
    });

    expect(result).toMatchObject({ success: false, error: { code: "write_denied" } });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("ad-hoc Connection authority", () => {
  const request = { url: "https://api.example.com/me", method: "GET" };
  const hostContext = { userId: "user-1", runId: "run-1" };

  it("uses the caller's personal Connection without a shared grant", async () => {
    const { apiRequest, send } = connectionTool(new MutableConnections());
    await apiRequest.execute(request, hostContext);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { authorization: expect.any(String) } })
    );
  });

  it("does not use an organization Connection without a live connection.use grant", async () => {
    const connections = new MutableConnections(connection({ owner: { scope: "organization" } }));
    const { apiRequest, send } = connectionTool(connections);
    await apiRequest.execute(request, hostContext);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ headers: {} }));
  });

  it("denies use when access is revoked after selection and before the lease", async () => {
    const canUse = vi.fn(async () => canUse.mock.calls.length === 1);
    const { apiRequest, send } = connectionTool(
      new MutableConnections(connection({ owner: { scope: "organization" } })),
      { canUse }
    );
    const result = await apiRequest.execute(request, hostContext);
    expect(result).toMatchObject({ success: false, error: { code: "write_denied" } });
    expect(canUse).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
  });

  it("tracks a Connection lease broker only for the active dispatch", async () => {
    const release = vi.fn();
    const trackConnectionBroker = vi.fn(() => release);
    const { apiRequest } = connectionTool(
      new MutableConnections(),
      undefined,
      trackConnectionBroker
    );

    await apiRequest.execute(request, hostContext);

    expect(trackConnectionBroker).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases a tracked Connection broker when dispatch fails", async () => {
    const release = vi.fn();
    const { apiRequest, send } = connectionTool(
      new MutableConnections(),
      undefined,
      vi.fn(() => release)
    );
    send.mockRejectedValueOnce(new Error("provider unavailable"));

    await apiRequest.execute(request, hostContext);

    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["status", { status: "revoked" }],
    ["origin", { configuration: { ...connection().configuration, origin: "https://other.test" } }],
    [
      "rule",
      {
        configuration: {
          ...connection().configuration,
          name: "x-api-key",
          valuePrefix: "",
        },
      },
    ],
    ["Secret binding", { secretBindings: { credential: "secret://replacement" } }],
  ] as const)("denies when the Connection %s changes before use", async (_case, change) => {
    const connections = new MutableConnections();
    connections.onFind = () => {
      connections.onFind = undefined;
      connections.row = { ...connections.row, ...change } as PersistedConnection;
    };
    const { apiRequest, send } = connectionTool(connections);
    const result = await apiRequest.execute(request, hostContext);
    expect(result).toMatchObject({ success: false, error: { code: "write_denied" } });
    expect(send).not.toHaveBeenCalled();
  });
});
