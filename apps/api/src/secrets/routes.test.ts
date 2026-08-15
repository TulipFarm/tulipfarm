import { randomBytes, randomUUID } from "node:crypto";
import type { SecretDoc, SecretEnvelopeFields, SecretMeta, SecretRepo } from "@tulipfarm/secrets";
import { SecretsService } from "@tulipfarm/secrets";
import type { PaginatedResult } from "@tulipfarm/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/routes";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";

const TEST_CSRF = "a".repeat(64);

// ── Fake dependencies ────────────────────────────────────────────────────────

class FakeUserRepo implements UserRepo {
  private users: UserDoc[] = [];
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
  private tokens: TokenDoc[] = [];
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
  async findAllPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
  async findByUserIdPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
}

class FakeSecretRepo implements SecretRepo {
  readonly docs = new Map<string, SecretDoc>();

  async list(): Promise<SecretMeta[]> {
    return [...this.docs.values()].map(({ key, type, createdAt, updatedAt }) => ({
      key,
      type,
      createdAt,
      updatedAt,
    }));
  }

  async findByKey(key: string): Promise<SecretDoc | null> {
    return this.docs.get(key) ?? null;
  }

  async upsert(key: string, fields: SecretEnvelopeFields): Promise<void> {
    const now = new Date();
    const existing = this.docs.get(key);
    this.docs.set(key, {
      _id: existing?._id ?? key,
      key,
      encryptedValue: fields.encryptedValue,
      iv: fields.iv,
      authTag: fields.authTag,
      type: fields.type,
      dekId: fields.dekId ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async delete(key: string): Promise<void> {
    this.docs.delete(key);
  }

  async listLegacyKeys(): Promise<string[]> {
    return [...this.docs.values()].filter((d) => d.dekId === null).map((d) => d.key);
  }
}

// ── Test setup ───────────────────────────────────────────────────────────────

describe("secrets routes", () => {
  let app: FastifyInstance;
  let store: MemorySessionStore;
  let userRepo: FakeUserRepo;
  let tokenRepo: FakeTokenRepo;
  let secretRepo: FakeSecretRepo;
  let adminSid: string;
  let memberSid: string;

  beforeEach(async () => {
    store = new MemorySessionStore();
    userRepo = new FakeUserRepo();
    tokenRepo = new FakeTokenRepo();
    secretRepo = new FakeSecretRepo();

    const admin = await createUser(userRepo, "admin@example.com", "pass", "admin");
    const member = await createUser(userRepo, "member@example.com", "pass", "member");
    adminSid = await store.create(admin._id);
    memberSid = await store.create(member._id);

    const secretsService = new SecretsService(secretRepo, {
      dekId: randomUUID(),
      key: randomBytes(32),
    });
    app = await buildApp({ sessionStore: store, userRepo, tokenRepo, secretsService });
  });

  afterEach(async () => {
    await app.close();
  });

  // ── GET /secrets/status ───────────────────────────────────────────────────

  describe("GET /api/v1/secrets/status", () => {
    it("returns 401 without auth", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/secrets/status" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 200 with empty list when no secrets exist", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/secrets/status",
        cookies: { [SESSION_COOKIE]: adminSid },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ secrets: [] });
    });

    it("returns keys and metadata but never plaintext values", async () => {
      // Write a secret directly via the service first
      await secretRepo.upsert("OPENAI_API_KEY", {
        encryptedValue: "encrypted",
        iv: "iv",
        authTag: "tag",
        type: "user-provided",
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/secrets/status",
        cookies: { [SESSION_COOKIE]: memberSid },
      });
      expect(res.statusCode).toBe(200);
      const { secrets } = res.json();
      expect(secrets).toHaveLength(1);
      expect(secrets[0].key).toBe("OPENAI_API_KEY");
      expect(secrets[0].type).toBe("user-provided");
      expect(secrets[0]).not.toHaveProperty("encryptedValue");
      expect(secrets[0]).not.toHaveProperty("iv");
      expect(secrets[0]).not.toHaveProperty("authTag");
    });

    it("member can also list secrets (not admin-only)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/secrets/status",
        cookies: { [SESSION_COOKIE]: memberSid },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  // ── PUT /secrets/:key ─────────────────────────────────────────────────────

  describe("PUT /api/v1/secrets/:key", () => {
    it("returns 401 without auth", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/secrets/MY_KEY",
        payload: { value: "secret" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 403 for non-admin", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/secrets/MY_KEY",
        cookies: { [SESSION_COOKIE]: memberSid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: { value: "secret" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("returns 400 when value is missing", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/secrets/MY_KEY",
        cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for an invalid key (spaces)", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/secrets/bad%20key",
        cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: { value: "secret" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a Codex credential that is not a subscription auth.json", async () => {
      // The only secret whose contents the product depends on. Validating on write means a paste
      // of the wrong file is refused here, with a useful message, rather than inside a chat turn.
      const bad = await app.inject({
        method: "PUT",
        url: "/api/v1/secrets/codex-auth-json",
        cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: { value: JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-live" }) },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toMatch(/subscription-only/);
      expect(bad.body).not.toContain("sk-live");

      const good = await app.inject({
        method: "PUT",
        url: "/api/v1/secrets/codex-auth-json",
        cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: { value: JSON.stringify({ tokens: { refresh_token: "rt", access_token: "at" } }) },
      });
      expect(good.statusCode).toBe(200);
    });

    it("returns 200 for admin and secret appears in GET /status", async () => {
      const put = await app.inject({
        method: "PUT",
        url: "/api/v1/secrets/OPENAI_API_KEY",
        cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: { value: "sk-abc123" },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toEqual({ key: "OPENAI_API_KEY" });

      const status = await app.inject({
        method: "GET",
        url: "/api/v1/secrets/status",
        cookies: { [SESSION_COOKIE]: adminSid },
      });
      const { secrets } = status.json();
      expect(secrets.some((s: { key: string }) => s.key === "OPENAI_API_KEY")).toBe(true);
    });

    it("response never contains the plaintext value", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/secrets/OPENAI_API_KEY",
        cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: { value: "sk-abc123" },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.stringify(res.json())).not.toContain("sk-abc123");
    });
  });

  // ── DELETE /secrets/:key ──────────────────────────────────────────────────

  describe("DELETE /api/v1/secrets/:key", () => {
    it("returns 401 without auth", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/secrets/MY_KEY",
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 403 for non-admin", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/secrets/MY_KEY",
        cookies: { [SESSION_COOKIE]: memberSid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
      });
      expect(res.statusCode).toBe(403);
    });

    it("returns 204 for admin and key is gone from GET /status", async () => {
      await app.inject({
        method: "PUT",
        url: "/api/v1/secrets/TO_DELETE",
        cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: { value: "bye" },
      });

      const del = await app.inject({
        method: "DELETE",
        url: "/api/v1/secrets/TO_DELETE",
        cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
      });
      expect(del.statusCode).toBe(204);

      const status = await app.inject({
        method: "GET",
        url: "/api/v1/secrets/status",
        cookies: { [SESSION_COOKIE]: adminSid },
      });
      const { secrets } = status.json();
      expect(secrets.some((s: { key: string }) => s.key === "TO_DELETE")).toBe(false);
    });

    it("returns 204 even when key does not exist (idempotent)", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/secrets/NONEXISTENT",
        cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
      });
      expect(res.statusCode).toBe(204);
    });
  });
});
