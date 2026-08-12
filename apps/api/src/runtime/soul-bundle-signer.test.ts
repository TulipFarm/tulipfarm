import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  resolveSoulBundleSigner,
  resolveSoulBundleVerifier,
  SOUL_BUNDLE_PRIVATE_KEY,
  SOUL_BUNDLE_PUBLIC_KEY,
  SOUL_BUNDLE_SIGNING_KEY_ID,
  type SoulBundleKeyStore,
} from "./soul-bundle-signer";

class MemoryBundleKeys implements SoulBundleKeyStore {
  readonly values = new Map<string, string>();
  readonly set = vi.fn(async (key: string, value: string, _type: "auto-generated") => {
    this.values.set(key, value);
  });
  lockAcquisitions = 0;
  writesOutsideLock = 0;
  private locked = false;

  // Deliberately pass-through rather than serializing: the concurrency tests below must exercise
  // the worst case where two replicas provision with NO mutual exclusion, proving the read-back
  // and re-derive logic converges on its own. Production supplies a real advisory lock on top.
  async withProvisioningLock<T>(operation: () => Promise<T>): Promise<T> {
    this.lockAcquisitions += 1;
    this.locked = true;
    try {
      return await operation();
    } finally {
      this.locked = false;
    }
  }

  async list() {
    return [...this.values.keys()].map((key) => ({ key }));
  }

  async get(key: string) {
    const value = this.values.get(key);
    if (!this.locked && key === SOUL_BUNDLE_PRIVATE_KEY) this.writesOutsideLock += 1;
    if (value === undefined) throw new Error("missing key");
    return value;
  }
}

function generateTestKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

function publicKeyFromPrivate(privateKeyPem: string): string {
  return createPublicKey(privateKeyPem).export({ format: "pem", type: "spki" }).toString();
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class RacingBundleKeys extends MemoryBundleKeys {
  private readonly bothListed = deferred();
  private readonly firstPrivateCanReturn = deferred();
  private listCalls = 0;
  private privateWrites = 0;

  override async list() {
    this.listCalls += 1;
    if (this.listCalls === 2) this.bothListed.resolve();
    await this.bothListed.promise;
    return [];
  }

  override readonly set = vi.fn(async (key: string, value: string, _type: "auto-generated") => {
    if (key === SOUL_BUNDLE_PRIVATE_KEY) {
      this.privateWrites += 1;
      this.values.set(key, value);
      if (this.privateWrites === 1) {
        await this.firstPrivateCanReturn.promise;
      } else {
        this.firstPrivateCanReturn.resolve();
      }
      return;
    }
    if (key === SOUL_BUNDLE_PUBLIC_KEY) {
      this.values.set(key, value);
      return;
    }

    this.values.set(key, value);
  });
}

class DroppingFirstPublicWriteKeys extends MemoryBundleKeys {
  private droppedPublicWrite = false;

  override readonly set = vi.fn(async (key: string, value: string, _type: "auto-generated") => {
    if (key === SOUL_BUNDLE_PUBLIC_KEY && !this.droppedPublicWrite) {
      this.droppedPublicWrite = true;
      return;
    }
    this.values.set(key, value);
  });
}

describe("resolveSoulBundleSigner / resolveSoulBundleVerifier", () => {
  it("provisions one Ed25519 keypair and returns stable signing material", async () => {
    const keys = new MemoryBundleKeys();
    const first = await resolveSoulBundleSigner(keys);
    const second = await resolveSoulBundleSigner(keys);

    expect(first.keyId).toBe(SOUL_BUNDLE_SIGNING_KEY_ID);
    expect(first.sign("payload")).toBe(second.sign("payload"));
    expect(keys.set).toHaveBeenCalledTimes(2);
    expect(keys.values.get(SOUL_BUNDLE_PRIVATE_KEY)).toContain("BEGIN PRIVATE KEY");
    expect(keys.values.get(SOUL_BUNDLE_PUBLIC_KEY)).toContain("BEGIN PUBLIC KEY");
  });

  it("uses only the public key to build a verifier", async () => {
    const keys = new MemoryBundleKeys();
    const signer = await resolveSoulBundleSigner(keys);
    const verifier = await resolveSoulBundleVerifier(keys);
    const signature = { keyId: signer.keyId, value: signer.sign("payload") };

    expect(verifier.trustedKeyIds).toEqual([SOUL_BUNDLE_SIGNING_KEY_ID]);
    expect(verifier.verify("payload", signature)).toBe(true);
    expect(verifier.verify("tampered", signature)).toBe(false);
  });

  it("derives the public key when only the private key exists", async () => {
    const keys = new MemoryBundleKeys();
    await resolveSoulBundleSigner(keys);
    const privateKey = await keys.get(SOUL_BUNDLE_PRIVATE_KEY);
    keys.values.clear();
    keys.values.set(SOUL_BUNDLE_PRIVATE_KEY, privateKey);
    keys.set.mockClear();

    await resolveSoulBundleSigner(keys);

    expect(keys.set).toHaveBeenCalledOnce();
    expect(keys.values.get(SOUL_BUNDLE_PUBLIC_KEY)).toContain("BEGIN PUBLIC KEY");
  });

  it("re-reads and retries when healing a private key without a public key", async () => {
    const seeded = new MemoryBundleKeys();
    await resolveSoulBundleSigner(seeded);
    const privateKey = await seeded.get(SOUL_BUNDLE_PRIVATE_KEY);
    const keys = new DroppingFirstPublicWriteKeys();
    keys.values.set(SOUL_BUNDLE_PRIVATE_KEY, privateKey);

    await resolveSoulBundleSigner(keys);

    expect(keys.set).toHaveBeenCalledTimes(2);
    expect(keys.values.get(SOUL_BUNDLE_PUBLIC_KEY)).toBe(publicKeyFromPrivate(privateKey));
  });

  it("fails boot when stored Ed25519 key halves do not match", async () => {
    const keys = new MemoryBundleKeys();
    const first = generateTestKeyPair();
    const second = generateTestKeyPair();
    keys.values.set(SOUL_BUNDLE_PRIVATE_KEY, first.privateKeyPem);
    keys.values.set(SOUL_BUNDLE_PUBLIC_KEY, second.publicKeyPem);

    await expect(resolveSoulBundleSigner(keys)).rejects.toThrow(
      /stored public key does not match the stored private key/
    );
  });

  it("fails boot when only the public verification key exists", async () => {
    const keys = new MemoryBundleKeys();
    keys.values.set(SOUL_BUNDLE_PUBLIC_KEY, generateTestKeyPair().publicKeyPem);

    await expect(resolveSoulBundleSigner(keys)).rejects.toThrow(
      /public verification key exists but the private signing key is missing/
    );
  });

  it("provisions under the caller's mutual exclusion rather than unlocked", async () => {
    const keys = new MemoryBundleKeys();

    await resolveSoulBundleSigner(keys);

    // Losing the lock silently would let two replicas generate divergent keypairs and orphan every
    // bundle the loser signed, so provisioning must never run outside the critical section.
    expect(keys.lockAcquisitions).toBe(1);
    expect(keys.writesOutsideLock).toBe(0);
  });

  it("converges concurrent provisioning on one consistent keypair", async () => {
    const keys = new RacingBundleKeys();
    const [first, second] = await Promise.all([
      resolveSoulBundleSigner(keys),
      resolveSoulBundleSigner(keys),
    ]);
    const verifier = await resolveSoulBundleVerifier(keys);
    const privateKeyPem = await keys.get(SOUL_BUNDLE_PRIVATE_KEY);
    const publicKeyPem = await keys.get(SOUL_BUNDLE_PUBLIC_KEY);

    expect(publicKeyPem).toBe(publicKeyFromPrivate(privateKeyPem));
    expect(first.sign("payload")).toBe(second.sign("payload"));
    expect(verifier.verify("payload", { keyId: first.keyId, value: first.sign("payload") })).toBe(
      true
    );
  });
});
