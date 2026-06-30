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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import type { UserDoc, UserRepo } from "../auth/users";
import { bootstrapFromEnv } from "./bootstrap";

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
    this.map.set(key, {
      _id: key,
      key,
      ...fields,
      dekId: fields.dekId ?? null,
      createdAt: now,
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

let dir: string;
function deps() {
  return {
    userRepo: new FakeUserRepo(),
    secretsService: new SecretsService(new FakeSecretRepo(), {
      dekId: randomUUID(),
      key: randomBytes(32),
    }),
    soulPath: path.join(dir, "soul"),
  };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "bootstrap-"));
  vi.stubEnv("ENCRYPTION_KEY", crypto.randomBytes(32).toString("base64"));
  vi.stubEnv("NODE_ENV", "production");
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("bootstrapFromEnv", () => {
  it("no env vars → no-op (wizard handles first-run)", async () => {
    const d = deps();
    await bootstrapFromEnv(d);
    expect(await d.userRepo.count()).toBe(0);
  });

  it("seeds admin + business + llm from env and marks setupComplete (idempotent)", async () => {
    vi.stubEnv("ADMIN_EMAIL", "admin@acme.io");
    vi.stubEnv("ADMIN_PASSWORD", "supersecret");
    vi.stubEnv("BUSINESS_NAME", "Acme");
    vi.stubEnv("LLM_API_KEY", "sk-ant-xyz");
    const d = deps();
    await bootstrapFromEnv(d);
    await bootstrapFromEnv(d); // second call is a no-op (user already exists)
    expect(await d.userRepo.count()).toBe(1);
    const cfg = parse(await fs.readFile(path.join(dir, "soul", "soul.yaml"), "utf8")) as {
      businessName?: string;
      setupComplete?: boolean;
    };
    expect(cfg.businessName).toBe("Acme");
    expect(cfg.setupComplete).toBe(true);
    expect(await d.secretsService.get("anthropic-api-key")).toBe("sk-ant-xyz");
  });

  it("production: admin creds set but LLM_API_KEY missing → fail loud", async () => {
    vi.stubEnv("ADMIN_EMAIL", "admin@acme.io");
    vi.stubEnv("ADMIN_PASSWORD", "supersecret");
    // LLM_API_KEY intentionally omitted
    await expect(bootstrapFromEnv(deps())).rejects.toThrow(/LLM_API_KEY/);
  });

  it("non-production: admin creds set, LLM_API_KEY missing → seed admin + mark complete", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ADMIN_EMAIL", "admin@acme.io");
    vi.stubEnv("ADMIN_PASSWORD", "supersecret");
    const d = deps();
    await bootstrapFromEnv(d);
    expect(await d.userRepo.count()).toBe(1);
    const cfg = parse(await fs.readFile(path.join(dir, "soul", "soul.yaml"), "utf8")) as {
      setupComplete?: boolean;
    };
    expect(cfg.setupComplete).toBe(true);
  });
});
