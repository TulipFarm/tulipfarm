import { generateKeyPairSync } from "node:crypto";
import {
  compileExecutionBundle,
  createEd25519BundleSigner,
  InMemoryBundleStore,
  SOUL_BUNDLE_PUBLIC_KEY,
  SOUL_BUNDLE_SIGNING_KEY_ID,
  signExecutionBundle,
} from "@tulipfarm/soul";
import { describe, expect, it, vi } from "vitest";
import { WorkerPinnedDefinitionReader } from "./pinned-definitions";

const definition = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "Routine",
  metadata: {
    id: "00000000-0000-4000-8000-000000000101",
    slug: "daily-digest",
    schemaVersion: 1,
    authoredVersion: 3,
    lifecycle: "published",
  },
  spec: {
    owner: "agent:assistant",
    start: "Finish",
    states: [{ type: "branch", name: "Finish", conditions: [{ condition: "true", end: true }] }],
  },
};

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

describe("WorkerPinnedDefinitionReader", () => {
  it("reads the API-provisioned public key once and verifies exact bundles", async () => {
    const bundles = new InMemoryBundleStore();
    const keys = keyPair();
    const signer = createEd25519BundleSigner(SOUL_BUNDLE_SIGNING_KEY_ID, keys.privateKeyPem);
    const record = signExecutionBundle(
      compileExecutionBundle({
        businessId: "business-1",
        changesetId: "changeset-1",
        commitSha: "commit-1",
        documents: [definition],
      }),
      signer
    );
    await bundles.put(record);
    const get = vi.fn(async () => keys.publicKeyPem);
    const secrets = vi.fn(async () => ({ get }));
    const reader = new WorkerPinnedDefinitionReader(bundles, secrets);
    const ref = {
      businessId: "business-1",
      bundleDigest: record.digest,
      kind: "Routine" as const,
      definitionId: definition.metadata.id,
      authoredVersion: 3,
    };

    expect((await reader.load(ref))?.definition.id).toBe(definition.metadata.id);
    expect((await reader.load(ref))?.bundle.digest).toBe(record.digest);
    expect(secrets).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith(SOUL_BUNDLE_PUBLIC_KEY);
  });

  it("fails closed when the stored bundle was signed by different material", async () => {
    const bundles = new InMemoryBundleStore();
    const signingKeys = keyPair();
    const verifyingKeys = keyPair();
    const record = signExecutionBundle(
      compileExecutionBundle({
        businessId: "business-1",
        changesetId: "changeset-1",
        commitSha: "commit-1",
        documents: [definition],
      }),
      createEd25519BundleSigner(SOUL_BUNDLE_SIGNING_KEY_ID, signingKeys.privateKeyPem)
    );
    await bundles.put(record);
    const reader = new WorkerPinnedDefinitionReader(bundles, async () => ({
      get: async () => verifyingKeys.publicKeyPem,
    }));

    await expect(
      reader.load({
        businessId: "business-1",
        bundleDigest: record.digest,
        kind: "Routine",
        definitionId: definition.metadata.id,
        authoredVersion: 3,
      })
    ).rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
  });
});
