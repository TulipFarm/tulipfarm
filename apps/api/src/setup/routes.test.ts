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
import { parse } from "yaml";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { MemorySessionStore } from "../auth/session-store";
import { AdminAlreadyExistsError, type UserDoc, type UserRepo } from "../auth/users";
import type { PaginatedResult } from "../pagination";

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
  // Mirrors the production `users_single_admin_idx` invariant (PgUserRepo.insert) so tests
  // can exercise the first-admin race without a real Postgres connection (#172).
  async insert(u: UserDoc) {
    if (u.role === "admin" && this.users.some((existing) => existing.role === "admin")) {
      throw new AdminAlreadyExistsError();
    }
    this.users.push(u);
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
  return buildApp({
    sessionStore: new MemorySessionStore(),
    userRepo: new FakeUserRepo(),
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
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "setup-"));
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

  it("business step persists name + description to soul.yaml", async () => {
    const cookies = await createAdmin();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/setup/business",
      headers: authHeaders(cookies),
      payload: { name: "Acme Tulips", description: "We sell tulips." },
    });
    expect(res.statusCode).toBe(204);
    const cfg = parse(await fs.readFile(path.join(dir, "soul", "soul.yaml"), "utf8")) as {
      businessName?: string;
      businessDescription?: string;
    };
    expect(cfg.businessName).toBe("Acme Tulips");
    expect(cfg.businessDescription).toBe("We sell tulips.");
  });

  it("llm step stores the key (no live call in unit tests)", async () => {
    const cookies = await createAdmin();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/setup/llm",
      headers: authHeaders(cookies),
      payload: { provider: "anthropic", apiKey: "sk-ant-test" },
    });
    // In unit tests the generateText call will fail (no real API); it's a transient error
    // so the route returns 204 anyway (key kept)
    expect(res.statusCode).toBe(204);
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

  it("complete marks setupComplete=true in soul.yaml", async () => {
    const cookies = await createAdmin();
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
