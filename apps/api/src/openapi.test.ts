import { randomBytes, randomUUID } from "node:crypto";
import type { SecretEnvelopeFields, SecretMeta, SecretRepo } from "@tulipfarm/secrets";
import { SecretsService } from "@tulipfarm/secrets";
import { makeSoulWriterDouble } from "@tulipfarm/soul";
import type { PaginatedResult } from "@tulipfarm/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import type { TokenDoc, TokenRepo } from "./auth/api-tokens";
import { MemorySessionStore } from "./auth/session-store";
import type { UserDoc, UserRepo } from "./auth/users";

class FakeUserRepo implements UserRepo {
  async findByEmail(): Promise<UserDoc | null> {
    return null;
  }
  async findById(): Promise<UserDoc | null> {
    return null;
  }
  async count(): Promise<number> {
    return 0;
  }
  async insert(): Promise<void> {}
}

class FakeTokenRepo implements TokenRepo {
  async create(): Promise<void> {}
  async findByHash(): Promise<TokenDoc | null> {
    return null;
  }
  async findByUserId(): Promise<TokenDoc[]> {
    return [];
  }
  async findAll(): Promise<TokenDoc[]> {
    return [];
  }
  async findById(): Promise<TokenDoc | null> {
    return null;
  }
  async deleteById(): Promise<void> {}
  async findAllPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
  async findByUserIdPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
}

class FakeSecretRepo implements SecretRepo {
  async list(): Promise<SecretMeta[]> {
    return [];
  }
  async findByKey(): Promise<null> {
    return null;
  }
  async upsert(_key: string, _fields: SecretEnvelopeFields): Promise<void> {}
  async delete(): Promise<void> {}
  async listLegacyKeys(): Promise<string[]> {
    return [];
  }
  async findRevision(): Promise<Date | null> {
    return null;
  }
}

function makeFakeGitSync() {
  return {
    commit: async () => ({ sha: "abc", filesChanged: 0 }),
    push: async () => true,
  } as unknown as import("@tulipfarm/soul").GitSyncService;
}

function buildTestApp() {
  const secretsService = new SecretsService(new FakeSecretRepo(), {
    dekId: randomUUID(),
    key: randomBytes(32),
  });
  return buildApp({
    sessionStore: new MemorySessionStore(),
    userRepo: new FakeUserRepo(),
    tokenRepo: new FakeTokenRepo(),
    secretsService,
    gitSync: makeFakeGitSync(),
    soulWriter: makeSoulWriterDouble().writer,
  });
}

describe("OpenAPI spec", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /api/v1/openapi.json returns OpenAPI 3.1 spec", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    const spec = res.json();
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.title).toBe("TulipFarm API");
  });

  it("spec includes all documented paths", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    const spec = res.json();
    const paths = Object.keys(spec.paths ?? {});
    expect(paths).toContain("/health");
    expect(paths).toContain("/api/v1/auth/login");
    expect(paths).toContain("/api/v1/auth/logout");
    expect(paths).toContain("/api/v1/auth/session");
    expect(paths).toContain("/api/v1/auth/tokens");
    expect(paths).toContain("/api/v1/auth/tokens/{id}");
    expect(paths).toContain("/api/v1/secrets/status");
    expect(paths).toContain("/api/v1/secrets/{key}");
    expect(paths).toContain("/api/v1/soul/push");
  });

  it("GET /docs/ returns Scalar UI HTML", async () => {
    const res = await app.inject({ method: "GET", url: "/docs/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("<html");
  });
});
