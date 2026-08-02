import { randomBytes } from "node:crypto";
import { type BundleSigner, createHmacBundleSigner } from "@tulipfarm/soul";

/** Encrypted Secret holding the HMAC material shared by bundle publication and verification. */
export const SOUL_BUNDLE_SIGNING_KEY = "soul-bundle.signing-key";

/** Stable public key identity recorded beside every signed execution bundle. */
export const SOUL_BUNDLE_SIGNING_KEY_ID = "soul-bundle-v1";

export interface SoulBundleSigningKeyStore {
  list(): Promise<readonly { readonly key: string }[]>;
  get(key: string): Promise<string>;
  set(key: string, plaintext: string, type: "auto-generated"): Promise<void>;
}

/**
 * Resolve one durable signing key, provisioning it on first boot. The value is re-read after the
 * write so the signer always uses the encrypted material that actually persisted.
 */
export async function resolveSoulBundleSigner(
  secrets: SoulBundleSigningKeyStore
): Promise<BundleSigner> {
  const known = await secrets.list();
  if (!known.some((secret) => secret.key === SOUL_BUNDLE_SIGNING_KEY)) {
    await secrets.set(
      SOUL_BUNDLE_SIGNING_KEY,
      randomBytes(32).toString("base64"),
      "auto-generated"
    );
  }
  return createHmacBundleSigner(
    SOUL_BUNDLE_SIGNING_KEY_ID,
    await secrets.get(SOUL_BUNDLE_SIGNING_KEY)
  );
}
