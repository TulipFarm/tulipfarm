import {
  compileExecutionBundle,
  createHmacBundleSigner,
  InMemoryBundleStore,
  SOUL_BUNDLE_SIGNING_KEY,
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

describe("WorkerPinnedDefinitionReader", () => {
  it("reads the API-provisioned signing Secret once and verifies exact bundles", async () => {
    const bundles = new InMemoryBundleStore();
    const signer = createHmacBundleSigner(SOUL_BUNDLE_SIGNING_KEY_ID, "shared-secret");
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
    const get = vi.fn(async () => "shared-secret");
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
    expect(get).toHaveBeenCalledWith(SOUL_BUNDLE_SIGNING_KEY);
  });

  it("fails closed when the stored bundle was signed by different material", async () => {
    const bundles = new InMemoryBundleStore();
    const record = signExecutionBundle(
      compileExecutionBundle({
        businessId: "business-1",
        changesetId: "changeset-1",
        commitSha: "commit-1",
        documents: [definition],
      }),
      createHmacBundleSigner(SOUL_BUNDLE_SIGNING_KEY_ID, "publication-secret")
    );
    await bundles.put(record);
    const reader = new WorkerPinnedDefinitionReader(bundles, async () => ({
      get: async () => "wrong-secret",
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
