import crypto, { randomBytes, randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type SecretDoc,
  type SecretEnvelopeFields,
  type SecretMeta,
  type SecretRepo,
  SecretsService,
} from "@tulipfarm/secrets";
import { makeSoulWriterDouble, mergeLlmConfigIntoSoulYaml } from "@tulipfarm/soul";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import type { UserDoc, UserRepo } from "../auth/users";
import { bootstrapFromEnv } from "./bootstrap";
import type { SetupAdminCreator } from "./first-admin";

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

class FakeSetupAdminCreator implements SetupAdminCreator {
  ownerPrincipalIds: string[] = [];

  constructor(private readonly users: FakeUserRepo) {}

  async create(user: UserDoc): Promise<void> {
    await this.users.insert(user);
    this.ownerPrincipalIds.push(user._id);
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
  async findRevision(key: string): Promise<Date | null> {
    return this.map.get(key)?.updatedAt ?? null;
  }
}

let dir: string;
function deps() {
  const userRepo = new FakeUserRepo();
  const setupAdminCreator = new FakeSetupAdminCreator(userRepo);
  const soul = makeSoulWriterDouble();
  return {
    userRepo,
    setupAdminCreator,
    secretsService: new SecretsService(new FakeSecretRepo(), {
      dekId: randomUUID(),
      key: randomBytes(32),
    }),
    soulPath: path.join(dir, "soul"),
    soulWriter: soul.writer,
    soul,
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
    expect(d.setupAdminCreator.ownerPrincipalIds).toHaveLength(1);
    const cfg = parse(d.soulWriter.read("Settings") ?? "") as {
      businessName?: string;
      setupComplete?: boolean;
      llm?: { tiers?: Record<string, { providers?: { provider: string; model: string }[] }> };
    };
    expect(cfg.businessName).toBe("Acme");
    expect(cfg.setupComplete).toBe(true);
    expect(await d.secretsService.get("anthropic-api-key")).toBe("sk-ant-xyz");
    // A credential alone leaves the instance unroutable: this path also hides the wizard, so it
    // must publish a chain too or every Run fails with `unknown_profile`.
    expect(Object.keys(cfg.llm?.tiers ?? {}).sort()).toEqual(["complex", "quick", "standard"]);
    expect(cfg.llm?.tiers?.standard?.providers?.[0]).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    expect(d.soul.applied).toHaveLength(1);
    expect(d.soul.applied[0]?.expectedBaseCommit).toBe("0".repeat(40));
  });

  it("never overwrites an LLM config the operator already tuned", async () => {
    vi.stubEnv("ADMIN_EMAIL", "admin@acme.io");
    vi.stubEnv("ADMIN_PASSWORD", "supersecret");
    vi.stubEnv("LLM_API_KEY", "sk-ant-xyz");
    const d = deps();
    await bootstrapFromEnv(d);
    const tuned = mergeLlmConfigIntoSoulYaml(d.soulWriter.read("Settings"), {
      tiers: {
        quick: { providers: [{ provider: "openai", model: "gpt-4o" }] },
        standard: { providers: [{ provider: "openai", model: "gpt-4o" }] },
        complex: { providers: [{ provider: "openai", model: "gpt-4o" }] },
      },
    });
    d.soul.put("Settings", undefined, tuned);
    await bootstrapFromEnv(d); // a later boot must not revert it
    const cfg = parse(d.soulWriter.read("Settings") ?? "") as {
      llm?: { tiers?: Record<string, { providers?: { provider: string; model: string }[] }> };
    };
    expect(cfg.llm?.tiers?.standard?.providers?.[0]?.model).toBe("gpt-4o");
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
    const cfg = parse(d.soulWriter.read("Settings") ?? "") as {
      setupComplete?: boolean;
    };
    expect(cfg.setupComplete).toBe(true);
  });

  it("non-production: SKIP_ADMIN_BOOTSTRAP → no seed, so the wizard runs", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SKIP_ADMIN_BOOTSTRAP", "true");
    vi.stubEnv("ADMIN_EMAIL", "admin@acme.io");
    vi.stubEnv("ADMIN_PASSWORD", "supersecret");
    vi.stubEnv("LLM_API_KEY", "sk-ant-xyz");
    const d = deps();
    await bootstrapFromEnv(d);
    expect(await d.userRepo.count()).toBe(0);
    await expect(d.secretsService.get("anthropic-api-key")).rejects.toThrow();
    // setupComplete must stay unwritten, or the wizard this switch exists to reach never shows.
    expect(existsSync(path.join(dir, "soul", "soul.yaml"))).toBe(false);
  });

  it("non-production: a non-truthy SKIP_ADMIN_BOOTSTRAP still seeds", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SKIP_ADMIN_BOOTSTRAP", "false");
    vi.stubEnv("ADMIN_EMAIL", "admin@acme.io");
    vi.stubEnv("ADMIN_PASSWORD", "supersecret");
    const d = deps();
    await bootstrapFromEnv(d);
    expect(await d.userRepo.count()).toBe(1);
  });

  it("production: SKIP_ADMIN_BOOTSTRAP → fail loud rather than strand a headless deploy", async () => {
    vi.stubEnv("SKIP_ADMIN_BOOTSTRAP", "1");
    vi.stubEnv("ADMIN_EMAIL", "admin@acme.io");
    vi.stubEnv("ADMIN_PASSWORD", "supersecret");
    vi.stubEnv("LLM_API_KEY", "sk-ant-xyz");
    await expect(bootstrapFromEnv(deps())).rejects.toThrow(/SKIP_ADMIN_BOOTSTRAP/);
  });

  it("preserves the business profile and rotated provider key on later boots", async () => {
    vi.stubEnv("ADMIN_EMAIL", "admin@acme.io");
    vi.stubEnv("ADMIN_PASSWORD", "supersecret");
    vi.stubEnv("BUSINESS_NAME", "Seed name");
    vi.stubEnv("LLM_API_KEY", "seed-key");
    const d = deps();
    await bootstrapFromEnv(d);
    d.soul.put(
      "Settings",
      undefined,
      stringify({ businessName: "Updated name", businessDescription: "Updated description" })
    );
    await d.secretsService.set("anthropic-api-key", "rotated-key");
    await bootstrapFromEnv(d);
    expect(parse(d.soulWriter.read("Settings") ?? "")).toEqual({
      businessName: "Updated name",
      businessDescription: "Updated description",
    });
    expect(await d.secretsService.get("anthropic-api-key")).toBe("rotated-key");
    expect(d.soul.applied).toHaveLength(1);
  });

  it("does not require the seed model key again once an admin exists", async () => {
    vi.stubEnv("ADMIN_EMAIL", "admin@acme.io");
    vi.stubEnv("ADMIN_PASSWORD", "supersecret");
    vi.stubEnv("LLM_API_KEY", "seed-key");
    const d = deps();
    await bootstrapFromEnv(d);
    vi.stubEnv("LLM_API_KEY", "");
    await expect(bootstrapFromEnv(d)).resolves.toBeUndefined();
  });

  it("does not mark the instance bootstrapped when publication fails", async () => {
    vi.stubEnv("ADMIN_EMAIL", "admin@acme.io");
    vi.stubEnv("ADMIN_PASSWORD", "supersecret");
    vi.stubEnv("LLM_API_KEY", "seed-key");
    const d = deps();
    const apply = d.soulWriter.apply.bind(d.soulWriter);
    vi.spyOn(d.soulWriter, "apply").mockImplementation(async (request) => ({
      ...(await apply(request)),
      published: false,
      publicationError: "bundle store unavailable",
    }));
    await expect(bootstrapFromEnv(d)).rejects.toThrow(/publish/i);
    expect(await d.userRepo.count()).toBe(0);
  });
});
