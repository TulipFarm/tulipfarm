import { describe, expect, it } from "vitest";
import type { KmsPort, MasterKeyRef, WrappedKey } from "./kms";

// A deterministic in-memory KMS proves the port wraps/unwraps a DEK without ever
// exposing master-key material or a provider-specific type across the boundary.
function fakeKms(keyId: string): KmsPort {
  const ref: MasterKeyRef = { keyId, provider: "local" };
  return {
    activeKey: () => ref,
    wrap: async (dek) => ({ keyId, ciphertext: Buffer.from(dek).toString("base64") }),
    unwrap: async (wrapped: WrappedKey) =>
      new Uint8Array(Buffer.from(wrapped.ciphertext, "base64")),
  };
}

describe("KmsPort", () => {
  it("round-trips a data-encryption key through wrap/unwrap", async () => {
    const kms = fakeKms("kek-1");
    const dek = new Uint8Array([1, 2, 3, 4]);
    const wrapped = await kms.wrap(dek);
    expect(wrapped.keyId).toBe("kek-1");
    const unwrapped = await kms.unwrap(wrapped);
    expect([...unwrapped]).toEqual([1, 2, 3, 4]);
  });

  it("exposes only an opaque master-key reference, never key material", () => {
    const ref = fakeKms("kek-1").activeKey();
    expect(ref).toEqual({ keyId: "kek-1", provider: "local" });
    // The reference is a discriminator for rotation/audit — it carries no bytes.
    expect(Object.keys(ref).sort()).toEqual(["keyId", "provider"]);
  });
});
