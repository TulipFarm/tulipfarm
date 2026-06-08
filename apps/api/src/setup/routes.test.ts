import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type SecretDoc,
  type SecretEnvelopeFields,
  type SecretMeta,
  type SecretRepo,
  SecretsService,
  loadEncryptionKeys,
} from "@tulipfarm/secrets";
import { GitSyncService } from "@tulipfarm/soul";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { MemorySessionStore } from "../auth/session-store";
import type { UserDoc, UserRepo } from "../auth/users";
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
  async insert(u: UserDoc) {
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
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    });
  }
  async delete(key: string) {
    this.map.delete(key);
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
    secretsService: new SecretsService(new FakeSecretRepo(), loadEncryptionKeys()),
    gitSync: new GitSyncService(soulPath, undefined, undefined, console),
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
  it("status reports needsSetup before any admin", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/setup/status" });
    expect(res.json()).toEqual({ needsSetup: true });
  });

  it("creates the first admin, auto-logs-in, then locks (403)", async () => {
    const cookies = await createAdmin();
    expect(cookies.some((c) => c.name === "tf_sid")).toBe(true);
    const status = await app.inject({ method: "GET", url: "/api/v1/setup/status" });
    expect(status.json()).toEqual({ needsSetup: false });
    const again = await app.inject({
      method: "POST",
      url: "/api/v1/setup/admin",
      payload: { email: "evil@acme.io", password: "supersecret" },
    });
    expect(again.statusCode).toBe(403);
  });

  it("business step persists to soul.yaml", async () => {
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
    };
    expect(cfg.businessName).toBe("Acme Tulips");
  });

  it("llm step stores the key (no live call)", async () => {
    const cookies = await createAdmin();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/setup/llm",
      headers: authHeaders(cookies),
      payload: { provider: "anthropic", apiKey: "sk-ant-test" },
    });
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

  it("business requires auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/setup/business",
      payload: { name: "X" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("locks wizard steps once setup is complete", async () => {
    const cookies = await createAdmin();
    const done = await app.inject({
      method: "POST",
      url: "/api/v1/setup/complete",
      headers: authHeaders(cookies),
    });
    expect(done.statusCode).toBe(204);
    const after = await app.inject({
      method: "POST",
      url: "/api/v1/setup/business",
      headers: authHeaders(cookies),
      payload: { name: "Late" },
    });
    expect(after.statusCode).toBe(403);
  });

  it("managed mode does not register setup routes (404)", async () => {
    await app.close();
    vi.stubEnv("SETUP_MODE", "managed");
    app = await makeApp(dir);
    const res = await app.inject({ method: "GET", url: "/api/v1/setup/status" });
    expect(res.statusCode).toBe(404);
  });
});
