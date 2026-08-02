import { randomBytes } from "node:crypto";
import {
  type BundleSigner,
  createHmacBundleSigner,
  SOUL_BUNDLE_SIGNING_KEY,
  SOUL_BUNDLE_SIGNING_KEY_ID,
} from "@tulipfarm/soul";

export { SOUL_BUNDLE_SIGNING_KEY, SOUL_BUNDLE_SIGNING_KEY_ID } from "@tulipfarm/soul";

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
