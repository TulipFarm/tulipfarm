import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/middleware";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import type { PaginatedResult } from "../pagination";
import { createApiClient, formatApiClientCredential } from "./api-clients";
import { CHANNEL_BIND_TTL_MS, issueChannelBindToken } from "./channel-link";
import { MemoryApiClientRepo, MemoryExternalIdentityRepo, MemoryOidcRequestRepo } from "./fakes";
import type { OidcClaims, OidcProvider } from "./oidc";
import { type MfaVerifier, MfaVerifierRegistry } from "./step-up";

const PASSWORD = "correct horse battery staple";

class FakeUserRepo implements UserRepo {
  constructor(public users: UserDoc[] = []) {}
  async findByEmail(email: string): Promise<UserDoc | null> {
    return this.users.find((u) => u.email === email.trim().toLowerCase()) ?? null;
  }
  async findById(id: string): Promise<UserDoc | null> {
    return this.users.find((u) => u._id === id) ?? null;
  }
  async count(): Promise<number> {
    return this.users.length;
  }
  async insert(user: UserDoc): Promise<void> {
    this.users.push(user);
  }
}

class FakeTokenRepo implements TokenRepo {
  tokens: TokenDoc[] = [];
  async create(token: TokenDoc): Promise<void> {
    this.tokens.push(token);
  }
  async findByHash(hash: string): Promise<TokenDoc | null> {
    return this.tokens.find((t) => t.tokenHash === hash) ?? null;
  }
  async findByUserId(userId: string): Promise<TokenDoc[]> {
    return this.tokens.filter((t) => t.userId === userId);
  }
  async findAll(): Promise<TokenDoc[]> {
    return [...this.tokens];
  }
  async findById(id: string): Promise<TokenDoc | null> {
    return this.tokens.find((t) => t._id === id) ?? null;
  }
  async deleteById(id: string): Promise<void> {
    this.tokens = this.tokens.filter((t) => t._id !== id);
  }
  async findAllPaginated(limit: number): Promise<PaginatedResult<TokenDoc>> {
    return { items: this.tokens.slice(0, limit), nextCursor: null };
  }
  async findByUserIdPaginated(userId: string, limit: number): Promise<PaginatedResult<TokenDoc>> {
    return {
      items: this.tokens.filter((t) => t.userId === userId).slice(0, limit),
      nextCursor: null,
    };
  }
}

interface Harness {
  app: FastifyInstance;
  store: MemorySessionStore;
  users: FakeUserRepo;
  apiClients: MemoryApiClientRepo;
  external: MemoryExternalIdentityRepo;
  oidcRequests: MemoryOidcRequestRepo;
  exchange: ReturnType<typeof vi.fn>;
  admin: UserDoc;
  member: UserDoc;
}

const REDIRECT_URI = "https://app.example/api/v1/auth/oidc/callback";

async function makeHarness(options: { withOidc?: boolean; mfa?: MfaVerifier[] } = {}) {
  const store = new MemorySessionStore();
  const users = new FakeUserRepo();
  const admin = await createUser(users, "admin@example.com", PASSWORD, "admin");
  const member = await createUser(users, "member@example.com", PASSWORD, "member");
  const apiClients = new MemoryApiClientRepo();
  const external = new MemoryExternalIdentityRepo();
  const oidcRequests = new MemoryOidcRequestRepo();
  const exchange = vi.fn(async (): Promise<OidcClaims> => ({ subject: "sub-1", amr: ["pwd"] }));
  const provider: OidcProvider = {
    providerId: "acme-oidc",
    authorizationUrl: ({ state }) => `https://idp.example/authorize?state=${state}`,
    exchange: exchange as unknown as OidcProvider["exchange"],
  };

  const app = await buildApp({
    sessionStore: store,
    userRepo: users,
    tokenRepo: new FakeTokenRepo(),
    identity: {
      apiClientRepo: apiClients,
      externalIdentityRepo: external,
      channelBind: { repo: external, signingKey: async () => Buffer.alloc(32, 3) },
      ...(options.withOidc
        ? { oidc: { provider, requestRepo: oidcRequests, redirectUri: REDIRECT_URI } }
        : {}),
      ...(options.mfa ? { mfa: new MfaVerifierRegistry(options.mfa) } : {}),
    },
  });

  return {
    app,
    store,
    users,
    apiClients,
    external,
    oidcRequests,
    exchange,
    admin,
    member,
  } satisfies Harness;
}

function cookiesFrom(response: { cookies: Array<{ name: string; value: string }> }) {
  return Object.fromEntries(response.cookies.map((c) => [c.name, c.value]));
}

async function login(harness: Harness, email: string) {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password: PASSWORD },
  });
  const cookies = cookiesFrom(response);
  return {
    response,
    sid: cookies[SESSION_COOKIE],
    csrf: cookies[CSRF_COOKIE],
  };
}

describe("session authentication", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it("issues a session and a session-bound CSRF token on login", async () => {
    const { response, sid, csrf } = await login(harness, "admin@example.com");

    expect(response.statusCode).toBe(200);
    const session = await harness.store.read(sid);
    expect(session?.userId).toBe(harness.admin._id);
    expect(session?.authMethods).toEqual(["password"]);
    expect(session?.csrfToken).toBe(csrf);
  });

  it("rotates the session id on login and kills the presented one (fixation)", async () => {
    const planted = await harness.store.issue({
      userId: harness.member._id,
      authMethods: ["password"],
    });

    const { sid } = await harness.app
      .inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: "admin@example.com", password: PASSWORD },
        cookies: { [SESSION_COOKIE]: planted.sid },
      })
      .then((response) => ({ sid: cookiesFrom(response)[SESSION_COOKIE] }));

    expect(sid).not.toBe(planted.sid);
    expect(await harness.store.read(planted.sid)).toBeNull();

    const replay = await harness.app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      cookies: { [SESSION_COOKIE]: planted.sid },
    });
    expect(replay.statusCode).toBe(401);
  });

  it("denies login for a disabled user with the same message as a bad password", async () => {
    harness.users.users[1].status = "disabled";

    const disabled = await harness.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "member@example.com", password: PASSWORD },
    });
    const wrongPassword = await harness.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "member@example.com", password: "nope" },
    });

    expect(disabled.statusCode).toBe(401);
    expect(disabled.json()).toEqual(wrongPassword.json());
    expect(disabled.cookies.find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
  });

  it("denies an existing session as soon as the user is disabled", async () => {
    const { sid } = await login(harness, "member@example.com");
    expect(
      (
        await harness.app.inject({
          method: "GET",
          url: "/api/v1/auth/session",
          cookies: { [SESSION_COOKIE]: sid },
        })
      ).statusCode
    ).toBe(200);

    harness.users.users[1].status = "disabled";

    const after = await harness.app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      cookies: { [SESSION_COOKIE]: sid },
    });
    expect(after.statusCode).toBe(401);
    expect(after.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects a CSRF token that is not the one bound to the session", async () => {
    const { sid } = await login(harness, "admin@example.com");
    const other = await harness.store.issue({
      userId: harness.admin._id,
      authMethods: ["password"],
    });

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/identity/external-links",
      payload: { provider: "slack" },
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: other.csrfToken },
      headers: { [CSRF_HEADER]: other.csrfToken },
    });

    expect(response.statusCode).toBe(403);
  });

  it("accepts the session-bound CSRF token", async () => {
    const { sid, csrf } = await login(harness, "admin@example.com");

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/identity/external-links",
      payload: { provider: "slack" },
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: csrf },
      headers: { [CSRF_HEADER]: csrf },
    });

    expect(response.statusCode).toBe(201);
  });
});

describe("api clients", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it("lets an admin mint a client and authenticates it as a service principal", async () => {
    const { sid, csrf } = await login(harness, "admin@example.com");

    const created = await harness.app.inject({
      method: "POST",
      url: "/api/v1/identity/api-clients",
      payload: { name: "slack-adapter" },
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: csrf },
      headers: { [CSRF_HEADER]: csrf },
    });

    expect(created.statusCode).toBe(201);
    const credential = created.json().credential as string;

    // A service identity is not a user: user-only routes refuse it.
    const asService = await harness.app.inject({
      method: "POST",
      url: "/api/v1/identity/external-links",
      payload: { provider: "slack" },
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(asService.statusCode).toBe(403);
  });

  it("refuses a non-admin caller", async () => {
    const { sid, csrf } = await login(harness, "member@example.com");

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/identity/api-clients",
      payload: { name: "sneaky" },
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: csrf },
      headers: { [CSRF_HEADER]: csrf },
    });

    expect(response.statusCode).toBe(403);
  });

  it("refuses a disabled client's credential on the next request", async () => {
    const { doc, secret } = await createApiClient(harness.apiClients, {
      name: "adapter",
      ownerUserId: harness.admin._id,
    });
    const credential = formatApiClientCredential(doc.clientId, secret);
    const { raw } = await mintLink(harness);

    const before = await redeem(harness, credential, raw, "U1");
    expect(before.statusCode).toBe(201);

    await harness.apiClients.updateStatus(doc._id, "disabled");
    const { raw: raw2 } = await mintLink(harness);
    const after = await redeem(harness, credential, raw2, "U2");

    expect(after.statusCode).toBe(401);
    expect(after.json()).toEqual({ error: "unauthorized" });
  });

  it("refuses an expired client's credential", async () => {
    const { doc, secret } = await createApiClient(harness.apiClients, {
      name: "adapter",
      ownerUserId: harness.admin._id,
      expiresAt: new Date(Date.now() - 1000),
    });
    const { raw } = await mintLink(harness);

    const response = await redeem(
      harness,
      formatApiClientCredential(doc.clientId, secret),
      raw,
      "U1"
    );

    expect(response.statusCode).toBe(401);
  });
});

async function mintLink(harness: Harness) {
  const { sid, csrf } = await login(harness, "member@example.com");
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/v1/identity/external-links",
    payload: { provider: "slack" },
    cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: csrf },
    headers: { [CSRF_HEADER]: csrf },
  });
  return { raw: response.json().linkToken as string, sid, csrf };
}

function redeem(harness: Harness, credential: string, linkToken: string, subject: string) {
  return harness.app.inject({
    method: "POST",
    url: "/api/v1/identity/external-links/redeem",
    payload: { linkToken, provider: "slack", externalSubject: subject },
    headers: { authorization: `Bearer ${credential}` },
  });
}

describe("external identity linking", () => {
  let harness: Harness;
  let credential: string;

  beforeEach(async () => {
    harness = await makeHarness();
    const { doc, secret } = await createApiClient(harness.apiClients, {
      name: "adapter",
      ownerUserId: harness.admin._id,
    });
    credential = formatApiClientCredential(doc.clientId, secret);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it("links a subject through a one-use token and denies the replay", async () => {
    const { raw } = await mintLink(harness);

    const first = await redeem(harness, credential, raw, "U123");
    const replay = await redeem(harness, credential, raw, "U-attacker");

    expect(first.statusCode).toBe(201);
    expect(first.json().link.userId).toBe(harness.member._id);
    expect(replay.statusCode).toBe(400);
    expect(harness.external.mappings).toHaveLength(1);
  });

  it("refuses redemption from a browser session (only a service identity may assert it)", async () => {
    const { raw, sid, csrf } = await mintLink(harness);

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/identity/external-links/redeem",
      payload: { linkToken: raw, provider: "slack", externalSubject: "U123" },
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: csrf },
      headers: { [CSRF_HEADER]: csrf },
    });

    expect(response.statusCode).toBe(403);
    expect(harness.external.mappings).toHaveLength(0);
  });

  it("refuses redemption without any credential", async () => {
    const { raw } = await mintLink(harness);

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/identity/external-links/redeem",
      payload: { linkToken: raw, provider: "slack", externalSubject: "U123" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("does not let one user unlink another user's mapping", async () => {
    const { raw } = await mintLink(harness);
    await redeem(harness, credential, raw, "U123");
    const { sid, csrf } = await login(harness, "admin@example.com");

    const response = await harness.app.inject({
      method: "DELETE",
      url: "/api/v1/identity/external-links/slack/U123",
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: csrf },
      headers: { [CSRF_HEADER]: csrf },
    });

    expect(response.statusCode).toBe(404);
    expect(harness.external.mappings).toHaveLength(1);
  });
});

describe("oidc sign-in", () => {
  it("stays closed when no provider is configured", async () => {
    const harness = await makeHarness();

    const start = await harness.app.inject({ method: "GET", url: "/api/v1/auth/oidc/start" });

    expect(start.statusCode).toBe(503);
    await harness.app.close();
  });

  it("signs in a mapped subject and issues an oidc session", async () => {
    const harness = await makeHarness({ withOidc: true });
    await harness.external.upsertMapping({
      provider: "acme-oidc",
      externalSubject: "sub-1",
      userId: harness.member._id,
      verifiedAt: new Date(),
      expiresAt: null,
    });
    const start = await harness.app.inject({ method: "GET", url: "/api/v1/auth/oidc/start" });
    const state = new URL(start.headers.location as string).searchParams.get("state") as string;

    const callback = await harness.app.inject({
      method: "GET",
      url: `/api/v1/auth/oidc/callback?code=abc&state=${encodeURIComponent(state)}`,
    });

    expect(callback.statusCode).toBe(200);
    const sid = cookiesFrom(callback)[SESSION_COOKIE];
    expect((await harness.store.read(sid))?.authMethods).toEqual(["oidc"]);
    await harness.app.close();
  });

  it("denies a replayed callback", async () => {
    const harness = await makeHarness({ withOidc: true });
    await harness.external.upsertMapping({
      provider: "acme-oidc",
      externalSubject: "sub-1",
      userId: harness.member._id,
      verifiedAt: new Date(),
      expiresAt: null,
    });
    const start = await harness.app.inject({ method: "GET", url: "/api/v1/auth/oidc/start" });
    const url = `/api/v1/auth/oidc/callback?code=abc&state=${encodeURIComponent(
      new URL(start.headers.location as string).searchParams.get("state") as string
    )}`;

    await harness.app.inject({ method: "GET", url });
    const replay = await harness.app.inject({ method: "GET", url });

    expect(replay.statusCode).toBe(401);
    await harness.app.close();
  });

  it("denies an unmapped subject instead of provisioning one", async () => {
    const harness = await makeHarness({ withOidc: true });
    const start = await harness.app.inject({ method: "GET", url: "/api/v1/auth/oidc/start" });
    const state = new URL(start.headers.location as string).searchParams.get("state") as string;

    const callback = await harness.app.inject({
      method: "GET",
      url: `/api/v1/auth/oidc/callback?code=abc&state=${encodeURIComponent(state)}`,
    });

    expect(callback.statusCode).toBe(403);
    expect(callback.cookies.find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
    expect(harness.users.users).toHaveLength(2);
    await harness.app.close();
  });

  it("denies a subject mapped to a disabled user", async () => {
    const harness = await makeHarness({ withOidc: true });
    harness.users.users[1].status = "disabled";
    await harness.external.upsertMapping({
      provider: "acme-oidc",
      externalSubject: "sub-1",
      userId: harness.member._id,
      verifiedAt: new Date(),
      expiresAt: null,
    });
    const start = await harness.app.inject({ method: "GET", url: "/api/v1/auth/oidc/start" });
    const state = new URL(start.headers.location as string).searchParams.get("state") as string;

    const callback = await harness.app.inject({
      method: "GET",
      url: `/api/v1/auth/oidc/callback?code=abc&state=${encodeURIComponent(state)}`,
    });

    expect(callback.statusCode).toBe(403);
    await harness.app.close();
  });
});

describe("step-up authentication", () => {
  it("refuses every method when no verifier is registered", async () => {
    const harness = await makeHarness();
    const { sid, csrf } = await login(harness, "member@example.com");

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/auth/step-up",
      payload: { method: "totp", proof: "123456" },
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: csrf },
      headers: { [CSRF_HEADER]: csrf },
    });

    expect(response.statusCode).toBe(400);
    expect((await harness.store.read(sid))?.mfaVerifiedAt).toBeNull();
    await harness.app.close();
  });

  it("rotates the session and records the factor on success", async () => {
    const verifier: MfaVerifier = { method: "totp", verify: async () => true };
    const harness = await makeHarness({ mfa: [verifier] });
    const { sid, csrf } = await login(harness, "member@example.com");

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/auth/step-up",
      payload: { method: "totp", proof: "123456" },
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: csrf },
      headers: { [CSRF_HEADER]: csrf },
    });

    expect(response.statusCode).toBe(200);
    const newSid = cookiesFrom(response)[SESSION_COOKIE];
    expect(newSid).not.toBe(sid);
    expect(await harness.store.read(sid)).toBeNull();
    const elevated = await harness.store.read(newSid);
    expect(elevated?.authMethods).toEqual(["password", "totp"]);
    expect(elevated?.mfaVerifiedAt).toBeInstanceOf(Date);
    await harness.app.close();
  });

  it("keeps the session unelevated when the proof is rejected", async () => {
    const verifier: MfaVerifier = { method: "totp", verify: async () => false };
    const harness = await makeHarness({ mfa: [verifier] });
    const { sid, csrf } = await login(harness, "member@example.com");

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/auth/step-up",
      payload: { method: "totp", proof: "000000" },
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: csrf },
      headers: { [CSRF_HEADER]: csrf },
    });

    expect(response.statusCode).toBe(401);
    const session = await harness.store.read(sid);
    expect(session?.mfaVerifiedAt).toBeNull();
    expect(session?.authMethods).toEqual(["password"]);
    await harness.app.close();
  });

  it("refuses step-up for a credential with no interactive session", async () => {
    const harness = await makeHarness({ mfa: [{ method: "totp", verify: async () => true }] });
    const { doc, secret } = await createApiClient(harness.apiClients, {
      name: "adapter",
      ownerUserId: harness.admin._id,
    });

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/auth/step-up",
      payload: { method: "totp", proof: "123456" },
      headers: { authorization: `Bearer ${formatApiClientCredential(doc.clientId, secret)}` },
    });

    expect(response.statusCode).toBe(403);
    await harness.app.close();
  });
});

describe("channel identity bind links", () => {
  let harness: Harness;

  const offer = (sender: string) =>
    issueChannelBindToken(
      { repo: harness.external, signingKey: async () => Buffer.alloc(32, 3) },
      { slug: "chatapp", senderId: sender }
    );

  const post = (path: string, token: string, session?: { sid: string; csrf: string }) =>
    harness.app.inject({
      method: "POST",
      url: `/api/v1/identity/channel-links/${path}`,
      payload: { token },
      ...(session
        ? {
            cookies: { [SESSION_COOKIE]: session.sid, [CSRF_COOKIE]: session.csrf },
            headers: { [CSRF_HEADER]: session.csrf },
          }
        : {}),
    });

  beforeEach(async () => {
    harness = await makeHarness();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it("refuses to open a bind link without a session, so a leaked link binds nothing", async () => {
    const { token } = await offer("EXT1");

    const preview = await post("preview", token);
    const confirm = await post("confirm", token);

    expect(preview.statusCode).toBe(401);
    expect(confirm.statusCode).toBe(401);
    expect(harness.external.mappings).toHaveLength(0);
  });

  it("names the sender and the account before anything is bound", async () => {
    // The person confirming has to see exactly what they are claiming, and as whom.
    const session = await login(harness, "member@example.com");
    const { token } = await offer("EXT1");

    const response = await post("preview", token, session);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      slug: "chatapp",
      senderId: "EXT1",
      account: { userId: harness.member._id, email: "member@example.com" },
    });
    // Previewing does not bind.
    expect(harness.external.mappings).toHaveLength(0);
  });

  it("binds the sender to the confirming session, never to whoever the link names", async () => {
    // The token carries no user id at all; the account comes from the session and nothing else.
    const session = await login(harness, "member@example.com");
    const { token } = await offer("EXT1");

    const response = await post("confirm", token, session);

    expect(response.statusCode).toBe(201);
    expect(response.json().link).toMatchObject({
      provider: "chatapp",
      externalSubject: "EXT1",
      userId: harness.member._id,
    });
  });

  it("refuses a link already redeemed, leaving the first claim standing", async () => {
    const first = await login(harness, "member@example.com");
    const second = await login(harness, "admin@example.com");
    const { token } = await offer("EXT1");

    expect((await post("confirm", token, first)).statusCode).toBe(201);
    const replay = await post("confirm", token, second);

    expect(replay.statusCode).toBe(400);
    expect(harness.external.mappings).toHaveLength(1);
    expect(harness.external.mappings[0]?.userId).toBe(harness.member._id);
  });

  it("refuses an expired link", async () => {
    const session = await login(harness, "member@example.com");
    const { token } = await offer("EXT1");

    harness.external.now = () => new Date(Date.now() + CHANNEL_BIND_TTL_MS + 1_000);

    const response = await post("confirm", token, session);

    expect(response.statusCode).toBe(400);
    expect(harness.external.mappings).toHaveLength(0);
  });

  it("says the same thing about a forged link as about a spent one", async () => {
    const session = await login(harness, "member@example.com");

    const response = await post(
      "preview",
      `${Buffer.from("{}").toString("base64url")}.deadbeef`,
      session
    );

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "bind link is not usable" });
  });
});
