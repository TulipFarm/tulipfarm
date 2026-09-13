import type { SecretsService } from "@tulipfarm/secrets";
import { describe, expect, it, vi } from "vitest";
import { createOimCredentialVault } from "./oim-credential-vault";

describe("createOimCredentialVault", () => {
  it("uses opaque Secret references and deletes credentials before final revocation", async () => {
    const values = new Map<string, string>();
    const secrets = {
      set: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
      get: vi.fn(async (key: string) => {
        const value = values.get(key);
        if (value === undefined) throw new Error("Secret not found");
        return value;
      }),
      delete: vi.fn(async (key: string) => {
        values.delete(key);
      }),
    } as unknown as SecretsService;
    const vault = createOimCredentialVault(secrets);
    const reference = await vault.create("acme", "access_token", "secret-value");

    expect(reference).toMatch(/^secret:\/\/[0-9a-f-]{36}$/);
    await expect(vault.read(reference)).resolves.toBe("secret-value");

    const persistRevocation = vi.fn(async () => undefined);
    await vault.revokeConnection("connection-1", { access_token: reference }, persistRevocation);

    expect(secrets.delete).toHaveBeenCalledOnce();
    expect(persistRevocation).toHaveBeenCalledOnce();
    await expect(vault.read(reference)).rejects.toThrow("Secret not found");
  });
});
