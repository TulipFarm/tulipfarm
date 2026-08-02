import { describe, expect, it, vi } from "vitest";
import {
  resolveSoulBundleSigner,
  SOUL_BUNDLE_SIGNING_KEY,
  SOUL_BUNDLE_SIGNING_KEY_ID,
  type SoulBundleSigningKeyStore,
} from "./soul-bundle-signer";

class MemorySigningKeys implements SoulBundleSigningKeyStore {
  readonly values = new Map<string, string>();
  readonly set = vi.fn(async (key: string, value: string, _type: "auto-generated") => {
    this.values.set(key, value);
  });

  async list() {
    return [...this.values.keys()].map((key) => ({ key }));
  }

  async get(key: string) {
    const value = this.values.get(key);
    if (value === undefined) throw new Error("missing key");
    return value;
  }
}

describe("resolveSoulBundleSigner", () => {
  it("provisions one durable key and returns a stable signer", async () => {
    const keys = new MemorySigningKeys();
    const first = await resolveSoulBundleSigner(keys);
    const second = await resolveSoulBundleSigner(keys);

    expect(first.keyId).toBe(SOUL_BUNDLE_SIGNING_KEY_ID);
    expect(first.sign("payload")).toBe(second.sign("payload"));
    expect(keys.set).toHaveBeenCalledTimes(1);
    expect(keys.values.get(SOUL_BUNDLE_SIGNING_KEY)).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it("uses existing material without replacing it", async () => {
    const keys = new MemorySigningKeys();
    keys.values.set(SOUL_BUNDLE_SIGNING_KEY, "existing-secret");

    const signer = await resolveSoulBundleSigner(keys);

    expect(keys.set).not.toHaveBeenCalled();
    expect(signer.sign("payload")).toMatch(/^[0-9a-f]{64}$/);
  });
});
