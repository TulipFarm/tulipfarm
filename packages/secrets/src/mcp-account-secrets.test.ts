import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { SecretsService } from "./encrypted-store";
import { SecretLeakError, SecretLeaseDeniedError } from "./lease";
import { McpAccountSecrets } from "./mcp-account-secrets";
import type { SecretDoc, SecretEnvelopeFields, SecretRepo } from "./repo";
import { secretStorageKey } from "./secret-reference";

class AccountSecretRepo implements SecretRepo {
  readonly rows = new Map<string, SecretDoc>();
  private revision = 0;
  async list() {
    return [...this.rows.values()];
  }
  async findByKey(key: string) {
    return this.rows.get(key) ?? null;
  }
  async upsert(key: string, fields: SecretEnvelopeFields) {
    const at = new Date(++this.revision);
    this.rows.set(key, {
      _id: key,
      key,
      ...fields,
      dekId: fields.dekId ?? null,
      createdAt: at,
      updatedAt: at,
    });
  }
  async delete(key: string) {
    this.rows.delete(key);
  }
  async findRevision(key: string) {
    return this.rows.get(key)?.updatedAt ?? null;
  }
  async listLegacyKeys() {
    return [];
  }
}

const scope = {
  businessId: "business",
  accountId: "account",
  accountRevision: 1,
  definitionDigest: "a".repeat(64),
  principalId: "owner",
  destination: "https://mcp.example.test",
  purpose: "tool",
};

function fixture() {
  const repo = new AccountSecretRepo();
  const dek = { dekId: randomUUID(), key: randomBytes(32) };
  const service = new SecretsService(repo, dek);
  return { repo, service, vault: new McpAccountSecrets(service), dek };
}

describe("MCP account Secrets", () => {
  it("stores opaque encrypted references and rejects a plaintext escape", async () => {
    const f = fixture();
    const bindings = await f.vault.write({ accessToken: "do-not-leak" });
    expect(bindings.accessToken).toMatch(/^secret:\/\/[a-f0-9-]{36}$/);
    expect(JSON.stringify([...f.repo.rows.values()])).not.toContain("do-not-leak");
    await expect(
      f.vault.use(
        bindings,
        scope,
        async () => {},
        async (values) => values.accessToken
      )
    ).rejects.toBeInstanceOf(SecretLeakError);
  });

  it("rechecks authority before redemption rather than trusting the account lookup", async () => {
    const f = fixture();
    const bindings = await f.vault.write({ accessToken: "private-token" });
    let checks = 0;
    const called = vi.fn(async () => "safe result");
    await expect(
      f.vault.use(
        bindings,
        scope,
        async () => {
          if (++checks >= 3) throw new Error("grant revoked");
        },
        called
      )
    ).rejects.toBeInstanceOf(SecretLeaseDeniedError);
    expect(called).not.toHaveBeenCalled();
  });

  it("reads current durable values rather than a previously cached credential", async () => {
    const f = fixture();
    const bindings = await f.vault.write({ accessToken: "old-token" });
    const reference = bindings.accessToken;
    if (!reference) throw new Error("missing reference");
    await f.service.get(secretStorageKey(reference));
    const anotherProcess = new SecretsService(f.repo, f.dek);
    await anotherProcess.set(secretStorageKey(reference), "new-token");
    await f.vault.use(
      bindings,
      scope,
      async () => {},
      async (values) => {
        expect(values.accessToken).toBe("new-token");
      }
    );
    await anotherProcess.delete(secretStorageKey(reference));
    await expect(
      f.vault.use(
        bindings,
        scope,
        async () => {},
        async () => {}
      )
    ).rejects.toBeInstanceOf(SecretLeaseDeniedError);
  });

  it("supports unauthenticated accounts without manufacturing fake Secrets", async () => {
    const f = fixture();
    const authorized = vi.fn(async () => {});
    await f.vault.use({}, scope, authorized, async (values) => {
      expect(values).toEqual({});
    });
    expect(authorized).toHaveBeenCalledOnce();
    expect(f.repo.rows.size).toBe(0);
  });

  it.each(["rotation", "deletion"])(
    "refuses %s after pinning a Secret revision",
    async (change) => {
      const f = fixture();
      const bindings = await f.vault.write({ accessToken: "old-token" });
      const reference = bindings.accessToken;
      if (!reference) throw new Error("missing reference");
      const anotherProcess = new SecretsService(f.repo, f.dek);
      let checks = 0;
      const called = vi.fn(async () => "safe result");

      await expect(
        f.vault.use(
          bindings,
          scope,
          async () => {
            if (++checks !== 3) return;
            if (change === "rotation") {
              await anotherProcess.set(secretStorageKey(reference), "rotated-token");
            } else {
              await anotherProcess.delete(secretStorageKey(reference));
            }
          },
          called
        )
      ).rejects.toBeInstanceOf(SecretLeaseDeniedError);
      expect(called).not.toHaveBeenCalled();
    }
  );

  it("leases distinct account slots together and removes every referenced Secret", async () => {
    const f = fixture();
    const bindings = await f.vault.write({ apiKey: "private-key", accessToken: "private-token" });
    await f.vault.use(
      bindings,
      scope,
      async () => {},
      async (values) => {
        expect(values).toEqual({ apiKey: "private-key", accessToken: "private-token" });
        expect(Object.isFrozen(values)).toBe(true);
      }
    );
    await f.vault.remove(bindings);
    expect(f.repo.rows.size).toBe(0);
    const called = vi.fn(async () => {});
    await expect(f.vault.use(bindings, scope, async () => {}, called)).rejects.toBeInstanceOf(
      SecretLeaseDeniedError
    );
    expect(called).not.toHaveBeenCalled();
  });
});
