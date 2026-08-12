import { createPublicKey, generateKeyPairSync } from "node:crypto";
import {
  type BundleSigner,
  type BundleVerifier,
  createEd25519BundleSigner,
  createEd25519BundleVerifier,
  SOUL_BUNDLE_PRIVATE_KEY,
  SOUL_BUNDLE_PUBLIC_KEY,
  SOUL_BUNDLE_SIGNING_KEY_ID,
} from "@tulipfarm/soul";

export {
  SOUL_BUNDLE_PRIVATE_KEY,
  SOUL_BUNDLE_PUBLIC_KEY,
  SOUL_BUNDLE_SIGNING_KEY_ID,
} from "@tulipfarm/soul";

export interface SoulBundleKeyStore {
  list(): Promise<readonly { readonly key: string }[]>;
  get(key: string): Promise<string>;
  set(key: string, plaintext: string, type: "auto-generated"): Promise<void>;
  /**
   * Required, not optional: provisioning generates a keypair whose loss orphans every signed
   * bundle, so a composition that forgets mutual exclusion must fail to compile rather than
   * silently race two replicas into divergent keys.
   */
  withProvisioningLock<T>(operation: () => Promise<T>): Promise<T>;
}

function generateBundleKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

function publicKeyFromPrivate(privateKeyPem: string): string {
  return createPublicKey(privateKeyPem).export({ format: "pem", type: "spki" }).toString();
}

function provisioningError(detail: string): Error {
  return new Error(
    `Soul bundle signing key provisioning is inconsistent: ${detail}. ` +
      "This is a provisioning failure, not bundle tampering. Restore the matching Ed25519 " +
      "private/public keypair; do not regenerate it or existing signed bundles will be orphaned."
  );
}

async function readExistingKey(
  secrets: Pick<SoulBundleKeyStore, "get">,
  key: string
): Promise<string | undefined> {
  try {
    return await secrets.get(key);
  } catch {
    return undefined;
  }
}

function deriveProvisionedPublicKey(privateKeyPem: string): string {
  try {
    return publicKeyFromPrivate(privateKeyPem);
  } catch {
    throw provisioningError("the stored private signing key cannot derive a public key");
  }
}

function assertStoredKeyPairMatches(privateKeyPem: string, publicKeyPem: string): void {
  const derivedPublicKeyPem = deriveProvisionedPublicKey(privateKeyPem);
  if (derivedPublicKeyPem !== publicKeyPem) {
    throw provisioningError("the stored public key does not match the stored private key");
  }
}

async function assertProvisionedKeyPair(secrets: SoulBundleKeyStore): Promise<void> {
  const privateKeyPem = await readExistingKey(secrets, SOUL_BUNDLE_PRIVATE_KEY);
  const publicKeyPem = await readExistingKey(secrets, SOUL_BUNDLE_PUBLIC_KEY);
  if (!privateKeyPem || !publicKeyPem) {
    throw provisioningError("the signing keypair is only partially provisioned");
  }
  assertStoredKeyPairMatches(privateKeyPem, publicKeyPem);
}

async function convergePublicKeyFromPersistedPrivate(secrets: SoulBundleKeyStore): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const privateKeyPem = await readExistingKey(secrets, SOUL_BUNDLE_PRIVATE_KEY);
    if (!privateKeyPem) {
      throw provisioningError("the private signing key is missing and cannot be recovered");
    }

    const derivedPublicKeyPem = deriveProvisionedPublicKey(privateKeyPem);
    const publicKeyPem = await readExistingKey(secrets, SOUL_BUNDLE_PUBLIC_KEY);
    if (publicKeyPem !== derivedPublicKeyPem) {
      await secrets.set(SOUL_BUNDLE_PUBLIC_KEY, derivedPublicKeyPem, "auto-generated");
    }

    try {
      await assertProvisionedKeyPair(secrets);
      return;
    } catch (error) {
      if (attempt === 4) throw error;
    }
  }
}

async function ensureBundleKeyPairUnlocked(secrets: SoulBundleKeyStore): Promise<void> {
  const known = new Set((await secrets.list()).map((secret) => secret.key));
  const hasPrivate = known.has(SOUL_BUNDLE_PRIVATE_KEY);
  const hasPublic = known.has(SOUL_BUNDLE_PUBLIC_KEY);
  if (hasPrivate && hasPublic) {
    await assertProvisionedKeyPair(secrets);
    return;
  }
  if (!hasPrivate && hasPublic) {
    throw provisioningError(
      "the public verification key exists but the private signing key is missing"
    );
  }
  if (hasPrivate) {
    await convergePublicKeyFromPersistedPrivate(secrets);
    return;
  }
  const keyPair = generateBundleKeyPair();
  await secrets.set(SOUL_BUNDLE_PRIVATE_KEY, keyPair.privateKeyPem, "auto-generated");
  await convergePublicKeyFromPersistedPrivate(secrets);
}

async function ensureBundleKeyPair(secrets: SoulBundleKeyStore): Promise<string> {
  return secrets.withProvisioningLock(async () => {
    await ensureBundleKeyPairUnlocked(secrets);
    // Read inside the critical section so the signer is built from exactly the material that was
    // just validated, rather than from whatever a concurrent writer left behind afterwards.
    return secrets.get(SOUL_BUNDLE_PRIVATE_KEY);
  });
}

/**
 * Resolve the API-only private signing key. The paired public key is stored separately so workers
 * can verify bundles without holding material that can forge them.
 */
export async function resolveSoulBundleSigner(secrets: SoulBundleKeyStore): Promise<BundleSigner> {
  return createEd25519BundleSigner(SOUL_BUNDLE_SIGNING_KEY_ID, await ensureBundleKeyPair(secrets));
}

/** Resolve only public verification material for runtime bundle readers. */
export async function resolveSoulBundleVerifier(
  secrets: Pick<SoulBundleKeyStore, "get">
): Promise<BundleVerifier> {
  return createEd25519BundleVerifier([
    {
      keyId: SOUL_BUNDLE_SIGNING_KEY_ID,
      publicKeyPem: await secrets.get(SOUL_BUNDLE_PUBLIC_KEY),
    },
  ]);
}
