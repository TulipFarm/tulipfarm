import crypto, { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type SecretDoc,
  type SecretEnvelopeFields,
  type SecretMeta,
  type SecretRepo,
  SecretsService,
} from "@tulipfarm/secrets";
import { GitSyncService } from "@tulipfarm/soul";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { MemorySessionStore } from "../auth/session-store";
import { AdminAlreadyExistsError, type UserDoc, type UserRepo } from "../auth/users";
import type { PaginatedResult } from "../pagination";
import type { SetupAdminCreator } from "./first-admin";

/**
 * The setup probe is a live model call, which makes the branch that *rejects* a credential the one
 * hardest to test and the one that matters most — it is the whole reason the step exists. Stubbing
 * `createModel` lets the outcome be chosen deterministically, with no network and no real CLI.
 */
const probeOutcome: { mode: "accepts" | "auth-failure" | "transient" } = { mode: "accepts" };

vi.mock("@tulipfarm/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tulipfarm/llm")>();
  return {
    ...actual,
    createModel: async () => ({
      specificationVersion: "v4",
      provider: "stub",
      modelId: "stub",
      supportedUrls: {},
      async doGenerate() {
        if (probeOutcome.mode === "auth-failure") {
          throw new actual.LlmProviderError(
            "model_authentication_failed",
            new Error("token expired")
          );
        }
        if (probeOutcome.mode === "transient") throw new Error("socket hang up");
        return {
          content: [{ type: "text" as const, text: "pong" }],
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        };
      },
    }),
  };
});

class FakeUserRepo implements UserRepo {
  users: UserDoc[] = [];
  async findByEmail(e: string) {
    return this.users.find((u) => u.email === e.trim().toLowerCase()) ?? null;
  }
  async findById(id: string) {
    return this.users.find((u) => u._id === id) ?? null;
  }
  async count() {
    return this.users.length;
  }
  async insert(u: UserDoc) {
    if (u.setupBootstrap && this.users.some((existing) => existing.setupBootstrap)) {
      throw new AdminAlreadyExistsError();
    }
    this.users.push(u);
  }
}

class FakeSetupAdminCreator implements SetupAdminCreator {
  constructor(private readonly users: FakeUserRepo) {}

  async create(user: UserDoc): Promise<void> {
    await this.users.insert(user);
    ownerPrincipalIds.push(user._id);
  }
}

class StubTokenRepo implements TokenRepo {
  async create() {}
  async findByHash() {
    return null;
  }
  async findByUserId() {
    return [];
  }
  async findAll() {
    return [];
  }
  async findById() {
    return null;
  }
  async deleteById() {}
  async findAllPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
  async findByUserIdPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
}

class FakeSecretRepo implements SecretRepo {
  map = new Map<string, SecretDoc>();
  async list(): Promise<SecretMeta[]> {
    return [...this.map.values()].map((d) => ({
      key: d.key,
      type: d.type,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    }));
  }
  async findByKey(key: string) {
    return this.map.get(key) ?? null;
  }
  async upsert(key: string, fields: SecretEnvelopeFields) {
    const now = new Date();
    const prev = this.map.get(key);
    this.map.set(key, {
      _id: key,
      key,
      ...fields,
      dekId: fields.dekId ?? null,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    });
  }
  async delete(key: string) {
    this.map.delete(key);
  }
  async listLegacyKeys() {
    return [];
  }
}

function cookieHeader(cookies: { name: string; value: string }[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function makeApp(dir: string): Promise<FastifyInstance> {
  const soulPath = path.join(dir, "soul");
  vi.stubEnv("SOUL_PATH", soulPath);
  vi.stubEnv("ENCRYPTION_KEY", crypto.randomBytes(32).toString("base64"));
  const userRepo = new FakeUserRepo();
  const setupAdminCreator = new FakeSetupAdminCreator(userRepo);
  return buildApp({
    sessionStore: new MemorySessionStore(),
    userRepo,
    setupAdminCreator,
    tokenRepo: new StubTokenRepo(),
    secretsService: new SecretsService(new FakeSecretRepo(), {
      dekId: randomUUID(),
      key: randomBytes(32),
    }),
    gitSync: new GitSyncService(soulPath, undefined, async () => undefined, console),
  });
}

let dir: string;
let app: FastifyInstance;
let ownerPrincipalIds: string[];
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "setup-"));
  ownerPrincipalIds = [];
  probeOutcome.mode = "accepts";
  app = await makeApp(dir);
});
afterEach(async () => {
  await app.close();
  await fs.rm(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function createAdmin(): Promise<{ name: string; value: string }[]> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/setup/admin",
    payload: { email: "admin@acme.io", password: "supersecret" },
  });
  expect(res.statusCode).toBe(201);
  return res.cookies;
}

/**
 * Writes a minimal `llm:` key straight into the fixture soul.yaml. `POST /setup/complete` refuses
 * without one, and going through the real LLM config route would drag a live provider probe into
 * tests that are about setup completion, not model routing.
 */
async function seedLlmConfig(): Promise<void> {
  const file = path.join(dir, "soul", "soul.yaml");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const current = parse(await fs.readFile(file, "utf8").catch(() => "")) ?? {};
  await fs.writeFile(
    file,
    stringify({
      ...current,
      llm: {
        tiers: {
          quick: { providers: [{ provider: "anthropic", model: "claude-3" }] },
          standard: { providers: [{ provider: "anthropic", model: "claude-3" }] },
          complex: { providers: [{ provider: "anthropic", model: "claude-3" }] },
        },
        presets: { default: "balanced" },
      },
    }),
    "utf8"
  );
}

function authHeaders(cookies: { name: string; value: string }[]) {
  return {
    cookie: cookieHeader(cookies),
    [CSRF_HEADER]: cookies.find((c) => c.name === CSRF_COOKIE)?.value ?? "",
  };
}

describe("setup routes", () => {
  it("status reports needsSetup=true before any admin", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/setup/status" });
    expect(res.json()).toEqual({ needsSetup: true });
  });

  it("status reports needsSetup=false when setupComplete is set in soul.yaml", async () => {
    // Simulate a dev setup (setup-dev.sh writes setupComplete: true)
    await fs.mkdir(path.join(dir, "soul"), { recursive: true });
    await fs.writeFile(path.join(dir, "soul", "soul.yaml"), "setupComplete: true\n", "utf8");
    // Rebuild app so it reads the pre-existing soul
    await app.close();
    app = await makeApp(dir);
    const res = await app.inject({ method: "GET", url: "/api/v1/setup/status" });
    expect(res.json()).toEqual({ needsSetup: false });
  });

  it("creates the first admin, auto-logs in, then locks (403)", async () => {
    const cookies = await createAdmin();
    expect(cookies.some((c) => c.name === "tf_sid")).toBe(true);
    expect(ownerPrincipalIds).toHaveLength(1);
    const status = await app.inject({ method: "GET", url: "/api/v1/setup/status" });
    // admin exists but setupComplete not set yet
    expect(status.json()).toEqual({ needsSetup: false });
    const again = await app.inject({
      method: "POST",
      url: "/api/v1/setup/admin",
      payload: { email: "evil@acme.io", password: "supersecret" },
    });
    expect(again.statusCode).toBe(403);
  });

  it("concurrent first-admin requests: exactly one wins, the loser gets 403 with no session cookie (#172)", async () => {
    const [first, second] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/v1/setup/admin",
        payload: { email: "winner@acme.io", password: "supersecret" },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/setup/admin",
        payload: { email: "attacker@acme.io", password: "supersecret" },
      }),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([201, 403]);
    const loser = first.statusCode === 403 ? first : second;
    expect(loser.cookies.some((c) => c.name === "tf_sid")).toBe(false);
    expect(loser.json()).toEqual({ error: "setup already complete" });
  });

  it("business step persists name + description + website to soul.yaml", async () => {
    const cookies = await createAdmin();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/setup/business",
      headers: authHeaders(cookies),
      payload: {
        name: "Acme Tulips",
        description: "We sell tulips.",
        website: "https://acmetulips.example",
      },
    });
    expect(res.statusCode).toBe(204);
    const cfg = parse(await fs.readFile(path.join(dir, "soul", "soul.yaml"), "utf8")) as {
      businessName?: string;
      businessDescription?: string;
      businessWebsite?: string;
    };
    expect(cfg.businessName).toBe("Acme Tulips");
    expect(cfg.businessDescription).toBe("We sell tulips.");
    expect(cfg.businessWebsite).toBe("https://acmetulips.example");
  });

  const submitLlm = async (
    cookies: { name: string; value: string }[],
    provider: string,
    apiKey: string
  ) =>
    app.inject({
      method: "POST",
      url: "/api/v1/setup/llm",
      headers: authHeaders(cookies),
      payload: { provider, apiKey },
    });

  /**
   * There is no `GET /api/v1/secrets/:key` — values are write-only — so presence is read from the
   * status listing. An earlier version of these tests fetched the key directly, which always 404s,
   * making every assertion about a *kept* credential vacuously true.
   */
  const secretExists = async (cookies: { name: string; value: string }[], key: string) => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/secrets/status",
      headers: authHeaders(cookies),
    });
    const body = res.json() as { secrets?: Array<{ key: string }> };
    return (body.secrets ?? []).some((secret) => secret.key === key);
  };

  it("keeps a key the probe accepted", async () => {
    const cookies = await createAdmin();
    probeOutcome.mode = "accepts";

    const res = await submitLlm(cookies, "anthropic", "sk-ant-test");

    expect(res.statusCode).toBe(204);
    expect(await secretExists(cookies, "anthropic-api-key")).toBe(true);
  });

  it("deletes a Subscription Provider credential the probe rejected as a hard auth failure", async () => {
    // A Subscription Provider never raises LlmCredentialError — the CLI rejects a stale token from
    // inside the turn, as an LlmProviderError. Before this branch existed the wizard filed that
    // under "transient" and kept the credential, so the step whose only job is to validate a
    // credential never actually rejected one.
    const cookies = await createAdmin();
    probeOutcome.mode = "auth-failure";

    const res = await submitLlm(cookies, "claude-code", "sk-ant-oat01-stale");

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/invalid/i);
    expect(await secretExists(cookies, "claude-code-oauth-token")).toBe(false);
  });

  it("keeps a key when the probe failed for a transient reason", async () => {
    // The opposite error: a network blip must not throw away a credential that may be perfectly
    // good, or an offline install could never finish setup.
    const cookies = await createAdmin();
    probeOutcome.mode = "transient";

    const res = await submitLlm(cookies, "anthropic", "sk-ant-test");

    expect(res.statusCode).toBe(204);
    expect(await secretExists(cookies, "anthropic-api-key")).toBe(true);
  });

  it("rejects a Codex credential that is not a subscription auth.json", async () => {
    const cookies = await createAdmin();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/setup/llm",
      headers: authHeaders(cookies),
      payload: {
        provider: "codex",
        apiKey: JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-live" }),
      },
    });

    // Rejected before it is stored, and before the probe spends thirty seconds discovering it.
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/subscription-only/);
    const stored = await app.inject({
      method: "GET",
      url: "/api/v1/secrets/codex-auth-json",
      headers: authHeaders(cookies),
    });
    expect(stored.statusCode).toBe(404);
  });

  it("llm step rejects an empty key", async () => {
    const cookies = await createAdmin();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/setup/llm",
      headers: authHeaders(cookies),
      payload: { provider: "anthropic", apiKey: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("git step stores remote URL in soul.yaml, credential as a secret, and syncs immediately", async () => {
    const cookies = await createAdmin();
    const configureRemote = vi
      .spyOn(GitSyncService.prototype, "configureRemote")
      .mockResolvedValue(undefined);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/setup/git",
      headers: authHeaders(cookies),
      payload: { remoteUrl: "https://github.com/acme/soul.git", credentials: "ghp_test" },
    });
    expect(res.statusCode).toBe(204);
    expect(configureRemote).toHaveBeenCalledWith(
      "https://github.com/acme/soul.git",
      expect.any(Function)
    );
    await expect(configureRemote.mock.calls[0][1]()).resolves.toBe("ghp_test");
    const cfg = parse(await fs.readFile(path.join(dir, "soul", "soul.yaml"), "utf8")) as {
      gitRemoteUrl?: string;
    };
    expect(cfg.gitRemoteUrl).toBe("https://github.com/acme/soul.git");
    configureRemote.mockRestore();
  });

  it("git step surfaces a sync failure (bad remote/credential) as 400", async () => {
    const cookies = await createAdmin();
    const configureRemote = vi
      .spyOn(GitSyncService.prototype, "configureRemote")
      .mockRejectedValue(new Error("Authentication failed"));
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/setup/git",
      headers: authHeaders(cookies),
      payload: { remoteUrl: "https://github.com/acme/soul.git", credentials: "bad_token" },
    });
    expect(res.statusCode).toBe(400);
    configureRemote.mockRestore();
  });

  it("business step requires auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/setup/business",
      payload: { name: "X" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("wizard steps lock once setup is complete", async () => {
    const cookies = await createAdmin();
    await seedLlmConfig();
    await app.inject({
      method: "POST",
      url: "/api/v1/setup/complete",
      headers: authHeaders(cookies),
    });
    const after = await app.inject({
      method: "POST",
      url: "/api/v1/setup/business",
      headers: authHeaders(cookies),
      payload: { name: "Late" },
    });
    expect(after.statusCode).toBe(403);
  });

  it("completes setup with no llm config — the LLM step is optional and skippable", async () => {
    const cookies = await createAdmin();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/setup/complete",
      headers: authHeaders(cookies),
    });
    expect(res.statusCode).toBe(204);
    const status = await app.inject({ method: "GET", url: "/api/v1/setup/status" });
    expect(status.json()).toEqual({ needsSetup: false });
  });

  it("complete marks setupComplete=true in soul.yaml", async () => {
    const cookies = await createAdmin();
    await seedLlmConfig();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/setup/complete",
      headers: authHeaders(cookies),
    });
    expect(res.statusCode).toBe(204);
    const cfg = parse(await fs.readFile(path.join(dir, "soul", "soul.yaml"), "utf8")) as {
      setupComplete?: boolean;
    };
    expect(cfg.setupComplete).toBe(true);
    const status = await app.inject({ method: "GET", url: "/api/v1/setup/status" });
    expect(status.json()).toEqual({ needsSetup: false });
  });

  it("headless boot: status returns 200 needsSetup=false even when wizard routes absent", async () => {
    await app.close();
    vi.stubEnv("ADMIN_EMAIL", "admin@acme.io");
    vi.stubEnv("ADMIN_PASSWORD", "supersecret");
    vi.stubEnv("LLM_API_KEY", "sk-ant-test");
    app = await makeApp(dir);
    const res = await app.inject({ method: "GET", url: "/api/v1/setup/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ needsSetup: false });
    // Wizard step routes remain absent in headless mode
    const adminRes = await app.inject({ method: "POST", url: "/api/v1/setup/admin", payload: {} });
    expect(adminRes.statusCode).toBe(404);
  });
});
