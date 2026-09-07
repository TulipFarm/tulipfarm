import { inspect } from "node:util";
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { SecretBroker, type SecretBrokerEvent, type SecretLeaseRequest } from "./broker";
import { SecretLeakError, SecretLeaseDeniedError, SecretNotSerializableError } from "./lease";
import { inMemorySecretProvider } from "./providers";

const PLAINTEXT = "tok-live-abcdef";

const SCOPE = {
  secretRef: "github.token",
  toolId: "github.create_issue",
  integrationId: "github",
  targetId: "acme/repo",
  runId: "run-1",
  stateId: "state-1",
  purpose: "create issue",
} as const;

const CONNECTION_SCOPE = {
  ...SCOPE,
  secretRef: "secret://github-personal-token",
  connectionId: "connection-github-personal",
  credentialSlot: "access_token",
} as const;

function harness(options: { allowed?: boolean; maxTtlMs?: number } = {}) {
  const provider = inMemorySecretProvider({
    [SCOPE.secretRef]: PLAINTEXT,
    [CONNECTION_SCOPE.secretRef]: PLAINTEXT,
  });
  const events: SecretBrokerEvent[] = [];
  let clock = 1_000;
  const broker = new SecretBroker({
    provider,
    authorizer: {
      authorize: async () =>
        options.allowed === false
          ? { allowed: false as const, reason: "not_authorized" as const }
          : { allowed: true as const, maxTtlMs: options.maxTtlMs },
    },
    onEvent: (event) => events.push(event),
    now: () => clock,
    defaultTtlMs: 60_000,
  });
  return {
    broker,
    provider,
    events,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("SecretBroker.lease", () => {
  it("reserves Connection scopes for leaseConnection", () => {
    expectTypeOf<typeof CONNECTION_SCOPE>().not.toMatchTypeOf<SecretLeaseRequest["scope"]>();
  });

  it("leases distinct Connection slots as one callback-only credential set", async () => {
    const secondScope = {
      ...CONNECTION_SCOPE,
      secretRef: "secret://github-personal-refresh-token",
      credentialSlot: "refresh_token",
    } as const;
    const broker = new SecretBroker({
      provider: inMemorySecretProvider({
        [CONNECTION_SCOPE.secretRef]: PLAINTEXT,
        [secondScope.secretRef]: "refresh-live-abcdef",
      }),
      authorizer: { authorize: async () => ({ allowed: true as const }) },
    });

    const lease = await broker.leaseConnectionSet({
      access_token: { scope: CONNECTION_SCOPE },
      refresh_token: { scope: secondScope },
    });

    await expect(
      lease.use(async (credentials) => ({
        access: credentials.access_token,
        refresh: credentials.refresh_token,
      }))
    ).rejects.toBeInstanceOf(SecretLeakError);
  });

  it("denies by default when authorization fails, without naming the plaintext", async () => {
    const { broker, events } = harness({ allowed: false });
    const error = await broker.lease({ scope: SCOPE }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SecretLeaseDeniedError);
    expect((error as SecretLeaseDeniedError).reason).toBe("not_authorized");
    expect((error as Error).message).not.toContain(PLAINTEXT);
    expect(events.map((event) => event.type)).toEqual(["secret.lease.denied"]);
  });

  it("denies when the authorizer itself throws", async () => {
    const provider = inMemorySecretProvider({ [SCOPE.secretRef]: PLAINTEXT });
    const broker = new SecretBroker({
      provider,
      authorizer: {
        authorize: async () => {
          throw new Error("authz backend down");
        },
      },
    });
    await expect(broker.lease({ scope: SCOPE })).rejects.toMatchObject({
      reason: "not_authorized",
    });
  });

  it("clamps the requested TTL to the authorized maximum", async () => {
    const { broker, advance } = harness({ maxTtlMs: 5_000 });
    const lease = await broker.lease({ scope: SCOPE, ttlMs: 600_000 });
    advance(5_001);
    await expect(lease.use(async (secret) => secret)).rejects.toMatchObject({
      reason: "expired",
    });
  });
});

describe("SecretLease.use", () => {
  it("resolves the current plaintext only inside the callback", async () => {
    const { broker, events } = harness();
    const lease = await broker.lease({ scope: SCOPE });
    const seen = await lease.use(async (secret) => secret.length);
    expect(seen).toBe(PLAINTEXT.length);
    expect(events.map((event) => event.type)).toEqual(["secret.lease.issued", "secret.lease.used"]);
    expect(JSON.stringify(events)).not.toContain(PLAINTEXT);
  });

  it("is single-use by default so a replayed lease is denied", async () => {
    const { broker } = harness();
    const lease = await broker.lease({ scope: SCOPE });
    await lease.use(async () => "ok");
    await expect(lease.use(async () => "ok")).rejects.toMatchObject({ reason: "exhausted" });
  });

  it("admits exactly one of two concurrent uses of a single-use lease", async () => {
    const { broker } = harness();
    const lease = await broker.lease({ scope: SCOPE });
    const outcomes = await Promise.allSettled([
      lease.use(async () => "a"),
      lease.use(async () => "b"),
    ]);
    expect(outcomes.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((entry) => entry.status === "rejected")).toHaveLength(1);
  });

  it("revokes an existing lease when its Secret revision changes", async () => {
    const { broker, provider } = harness();
    const lease = await broker.lease({ scope: SCOPE, maxUses: 2 });
    await expect(lease.use(async (secret) => secret === PLAINTEXT)).resolves.toBe(true);
    provider.set(SCOPE.secretRef, "tok-live-rotated");
    await expect(lease.use(async (secret) => secret === "tok-live-rotated")).resolves.toBe(true);
  });

  it("denies immediately after the secret is revoked", async () => {
    const { broker, provider, events } = harness();
    const lease = await broker.lease({ scope: SCOPE, maxUses: 5 });
    provider.revoke(SCOPE.secretRef);
    await expect(lease.use(async (secret) => secret)).rejects.toMatchObject({
      reason: "revoked",
    });
    expect(events.at(-1)?.type).toBe("secret.lease.denied");
  });

  it("denies every outstanding lease once the broker revokes the secret", async () => {
    const { broker } = harness();
    const lease = await broker.lease({ scope: SCOPE, maxUses: 5 });
    broker.revokeSecret(SCOPE.secretRef);
    await expect(lease.use(async (secret) => secret)).rejects.toMatchObject({
      reason: "revoked",
    });
  });

  it("denies every outstanding lease once its Connection is revoked", async () => {
    const { broker } = harness();
    const lease = await broker.leaseConnection({ scope: CONNECTION_SCOPE, maxUses: 5 });
    broker.revokeConnection(CONNECTION_SCOPE.connectionId);
    await expect(lease.use(async (secret) => secret)).rejects.toMatchObject({
      reason: "revoked",
    });
  });

  it("denies a lease that outlived the broker, as after a crash or restart", async () => {
    const { broker } = harness();
    const lease = await broker.lease({ scope: SCOPE, maxUses: 5 });
    broker.revokeAll();
    await expect(lease.use(async (secret) => secret)).rejects.toMatchObject({
      reason: "lease_unknown",
    });
  });

  it("rejects a lease presented against a different scope", async () => {
    const { broker } = harness();
    const lease = await broker.lease({ scope: SCOPE });
    await expect(
      lease.use(async (secret) => secret, { ...SCOPE, targetId: "acme/other" })
    ).rejects.toMatchObject({ reason: "scope_mismatch" });
  });

  it("cannot use one Connection or credential slot through another lease", async () => {
    const { broker } = harness();
    const lease = await broker.leaseConnection({ scope: CONNECTION_SCOPE });
    await expect(
      lease.use(async () => "ok", { ...CONNECTION_SCOPE, connectionId: "connection-other" })
    ).rejects.toMatchObject({ reason: "scope_mismatch" });
    await expect(
      lease.use(async () => "ok", { ...CONNECTION_SCOPE, credentialSlot: "refresh_token" })
    ).rejects.toMatchObject({ reason: "scope_mismatch" });
  });

  it("requires durable revisions for Connection leases", async () => {
    const events: SecretBrokerEvent[] = [];
    const broker = new SecretBroker({
      provider: {
        resolveCurrent: async () => ({ value: PLAINTEXT }),
      },
      authorizer: { authorize: async () => ({ allowed: true }) },
      onEvent: (event) => events.push(event),
    });

    await expect(broker.leaseConnection({ scope: CONNECTION_SCOPE })).rejects.toMatchObject({
      reason: "not_authorized",
    });
    expect(events).toMatchObject([{ type: "secret.lease.denied", reason: "not_authorized" }]);
  });

  it("authorizes before checking the Connection credential revision", async () => {
    let revisionReads = 0;
    const events: SecretBrokerEvent[] = [];
    const broker = new SecretBroker({
      provider: {
        resolveCurrent: async () => ({ value: PLAINTEXT }),
        currentVersion: async () => {
          revisionReads += 1;
          return "1";
        },
      },
      authorizer: { authorize: async () => ({ allowed: false, reason: "not_authorized" }) },
      onEvent: (event) => events.push(event),
    });

    await expect(broker.leaseConnection({ scope: CONNECTION_SCOPE })).rejects.toMatchObject({
      reason: "not_authorized",
    });
    expect(revisionReads).toBe(0);
    expect(events).toMatchObject([{ type: "secret.lease.denied", reason: "not_authorized" }]);
  });

  it("emits denial evidence when the Connection credential is revoked", async () => {
    const events: SecretBrokerEvent[] = [];
    const broker = new SecretBroker({
      provider: {
        resolveCurrent: async () => null,
        currentVersion: async () => null,
      },
      authorizer: { authorize: async () => ({ allowed: true }) },
      onEvent: (event) => events.push(event),
    });

    await expect(broker.leaseConnection({ scope: CONNECTION_SCOPE })).rejects.toMatchObject({
      reason: "revoked",
    });
    expect(events).toMatchObject([{ type: "secret.lease.denied", reason: "revoked" }]);
  });

  it("cannot be retargeted by mutating the caller-owned scope after issue", async () => {
    const provider = inMemorySecretProvider({
      [SCOPE.secretRef]: PLAINTEXT,
      "other.token": "other-plaintext",
    });
    const broker = new SecretBroker({
      provider,
      authorizer: { authorize: async () => ({ allowed: true }) },
    });
    const mutableScope = { ...SCOPE, secretRef: String(SCOPE.secretRef) };
    const lease = await broker.lease({ scope: mutableScope });

    mutableScope.secretRef = "other.token";

    await expect(lease.use(async (secret) => secret === PLAINTEXT)).resolves.toBe(true);
    expect(lease.scope.secretRef).toBe(SCOPE.secretRef);
    expect(Object.isFrozen(lease.scope)).toBe(true);
  });
});

describe("secret containment", () => {
  let fixture: ReturnType<typeof harness>;

  beforeEach(() => {
    fixture = harness();
  });

  it("keeps plaintext out of the lease handle and blocks serialization", async () => {
    const lease = await fixture.broker.lease({ scope: SCOPE });
    expect(() => JSON.stringify(lease)).toThrow(SecretNotSerializableError);
    expect(String(lease)).toBe("[SecretLease redacted]");
    expect(`${lease}`).toBe("[SecretLease redacted]");
    expect(inspect(lease, { depth: 5 })).not.toContain(PLAINTEXT);
  });

  it("redacts plaintext out of an error thrown by the callback", async () => {
    const lease = await fixture.broker.lease({ scope: SCOPE });
    const error = await lease
      .use(async (secret) => {
        throw new Error(`upstream rejected ${secret}`);
      })
      .catch((err: unknown) => err);
    expect((error as Error).message).toBe("upstream rejected [redacted]");
    expect((error as Error).stack ?? "").not.toContain(PLAINTEXT);
  });

  it("fails closed when the callback returns the plaintext", async () => {
    const lease = await fixture.broker.lease({ scope: SCOPE });
    const error = await lease
      .use(async (secret) => ({ echoed: secret }))
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SecretLeakError);
    expect((error as Error).message).not.toContain(PLAINTEXT);
  });

  it.each([
    ["Map", (secret: string) => new Map([["credential", secret]])],
    ["Set", (secret: string) => new Set([secret])],
    ["binary data", (secret: string) => new TextEncoder().encode(secret)],
  ])("fails closed when the callback returns plaintext inside %s", async (_name, value) => {
    const lease = await fixture.broker.lease({ scope: SCOPE });

    await expect(lease.use(async (secret) => value(secret))).rejects.toBeInstanceOf(
      SecretLeakError
    );
  });

  it("never puts plaintext in lease evidence", async () => {
    const lease = await fixture.broker.lease({ scope: SCOPE });
    await lease.use(async () => "ok");
    const issued = fixture.events.find((event) => event.type === "secret.lease.issued");
    expect(issued?.scope.secretRef).toBe(SCOPE.secretRef);
    expect(issued?.scope).not.toHaveProperty("value");
    expect(inspect(fixture.events, { depth: 8 })).not.toContain(PLAINTEXT);
  });

  it("emits immutable scope evidence that cannot retarget a lease", async () => {
    const lease = await fixture.broker.lease({ scope: SCOPE });
    const issued = fixture.events[0];
    if (!issued) throw new Error("expected issue evidence");

    expect(Object.isFrozen(issued.scope)).toBe(true);
    expect(() => {
      Object.assign(issued.scope, { secretRef: "other.token" });
    }).toThrow();
    await expect(lease.use(async (secret) => secret === PLAINTEXT)).resolves.toBe(true);
  });
});
