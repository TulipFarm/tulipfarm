import { randomBytes, randomUUID } from "node:crypto";
import {
  type ActiveDek,
  encryptSecret,
  type SecretDoc,
  type SecretRepo,
  SecretsService,
} from "@tulipfarm/secrets";
import { SOUL_BUNDLE_PRIVATE_KEY, SOUL_BUNDLE_PUBLIC_KEY } from "@tulipfarm/soul";
import { describe, expect, it } from "vitest";
import {
  GuardedWorkerSecretsService,
  isWorkerForbiddenSecret,
  WorkerSecretForbiddenError,
} from "./secrets-guard";

// The GitHub App private key is a real private key the worker legitimately reads to mint
// installation tokens — the guard must not confuse it with bundle signing material.
const GITHUB_APP_PRIVATE_KEY = "integration.github.GITHUB_APP_PRIVATE_KEY";
// LLM `api_key_ref`s are Soul-authored and unbounded; the guard must leave them alone.
const LLM_API_KEY = "llm.openai.api-key";

class FakeRepo implements SecretRepo {
  readonly docs = new Map<string, SecretDoc>();
  async list() {
    return [];
  }
  async findByKey(key: string) {
    return this.docs.get(key) ?? null;
  }
  async upsert() {}
  async delete() {}
  async listLegacyKeys() {
    return [];
  }
}

function seed(repo: FakeRepo, dek: ActiveDek, key: string, plaintext: string): void {
  const env = encryptSecret(plaintext, dek.key);
  const now = new Date();
  repo.docs.set(key, {
    _id: key,
    key,
    encryptedValue: env.encryptedValue,
    iv: env.iv,
    authTag: env.authTag,
    type: "user-provided",
    dekId: dek.dekId,
    createdAt: now,
    updatedAt: now,
  });
}

function fixture() {
  const dek: ActiveDek = { dekId: randomUUID(), key: randomBytes(32) };
  const repo = new FakeRepo();
  seed(repo, dek, SOUL_BUNDLE_PRIVATE_KEY, "PRIVATE-SIGNING-MATERIAL");
  seed(repo, dek, SOUL_BUNDLE_PUBLIC_KEY, "PUBLIC-VERIFY-KEY");
  seed(repo, dek, GITHUB_APP_PRIVATE_KEY, "GITHUB-PEM");
  seed(repo, dek, LLM_API_KEY, "LLM-TOKEN");
  return { repo, dek };
}

describe("isWorkerForbiddenSecret", () => {
  it("denies the bundle signing key and any other soul-bundle secret, allows public keys", () => {
    expect(isWorkerForbiddenSecret(SOUL_BUNDLE_PRIVATE_KEY)).toBe(true);
    expect(isWorkerForbiddenSecret("soul-bundle.ed25519-v2.private-key")).toBe(true);
    expect(isWorkerForbiddenSecret(SOUL_BUNDLE_PUBLIC_KEY)).toBe(false);
    expect(isWorkerForbiddenSecret("soul-bundle.ed25519-v2.public-key")).toBe(false);
  });

  it("leaves Integration and LLM credentials the worker legitimately reads alone", () => {
    expect(isWorkerForbiddenSecret(GITHUB_APP_PRIVATE_KEY)).toBe(false);
    expect(isWorkerForbiddenSecret(LLM_API_KEY)).toBe(false);
  });
});

describe("GuardedWorkerSecretsService", () => {
  it("refuses the bundle signing private key at runtime, naming the key not the value", async () => {
    const { repo, dek } = fixture();
    const secrets = new GuardedWorkerSecretsService(repo, dek);

    const result = await secrets.get(SOUL_BUNDLE_PRIVATE_KEY).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(WorkerSecretForbiddenError);
    const error = result as WorkerSecretForbiddenError;
    expect(error.key).toBe(SOUL_BUNDLE_PRIVATE_KEY);
    expect(error.message).toContain(SOUL_BUNDLE_PRIVATE_KEY);
    expect(error.message).not.toContain("PRIVATE-SIGNING-MATERIAL");
  });

  it("still serves every secret the worker legitimately reads", async () => {
    const { repo, dek } = fixture();
    const secrets = new GuardedWorkerSecretsService(repo, dek);

    expect(await secrets.get(SOUL_BUNDLE_PUBLIC_KEY)).toBe("PUBLIC-VERIFY-KEY");
    expect(await secrets.get(GITHUB_APP_PRIVATE_KEY)).toBe("GITHUB-PEM");
    expect(await secrets.get(LLM_API_KEY)).toBe("LLM-TOKEN");
  });

  it("witness: the unguarded base service would hand over the signing key", async () => {
    const { repo, dek } = fixture();
    const base = new SecretsService(repo, dek);

    expect(await base.get(SOUL_BUNDLE_PRIVATE_KEY)).toBe("PRIVATE-SIGNING-MATERIAL");
  });
});
