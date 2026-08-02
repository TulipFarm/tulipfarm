import { describe, expect, it } from "vitest";
import { InMemoryBundleStore } from "./bundle";
import { compileExecutionBundle } from "./compiler";
import { PinnedDefinitionLoader } from "./pinned-definition";
import { createHmacBundleSigner, signExecutionBundle } from "./signatures";

const signer = createHmacBundleSigner("bundle-key", "test-secret");

function routine() {
  return {
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
}

async function fixture() {
  const bundles = new InMemoryBundleStore();
  const record = signExecutionBundle(
    compileExecutionBundle({
      businessId: "business-1",
      changesetId: "changeset-1",
      commitSha: "commit-1",
      documents: [routine()],
    }),
    signer
  );
  await bundles.put(record);
  return { loader: new PinnedDefinitionLoader(bundles, signer), record };
}

describe("PinnedDefinitionLoader", () => {
  it("opens the exact signed definition pinned by a Run", async () => {
    const { loader, record } = await fixture();

    const loaded = await loader.load({
      businessId: "business-1",
      bundleDigest: record.digest,
      kind: "Routine",
      definitionId: "00000000-0000-4000-8000-000000000101",
      authoredVersion: 3,
    });

    expect(loaded?.bundle.digest).toBe(record.digest);
    expect(loaded?.definition.document).toEqual(routine());
  });

  it.each([
    ["another business", { businessId: "business-2" }],
    ["another definition", { definitionId: "routine-2" }],
    ["another kind", { kind: "Agent" }],
    ["another version", { authoredVersion: 4 }],
  ])("refuses %s rather than widening an exact pin", async (_name, override) => {
    const { loader, record } = await fixture();

    await expect(
      loader.load({
        businessId: "business-1",
        bundleDigest: record.digest,
        kind: "Routine",
        definitionId: "00000000-0000-4000-8000-000000000101",
        authoredVersion: 3,
        ...override,
      })
    ).resolves.toBeUndefined();
  });

  it("refuses an unknown digest", async () => {
    const { loader } = await fixture();

    await expect(
      loader.load({
        businessId: "business-1",
        bundleDigest: "missing",
        kind: "Routine",
        definitionId: "00000000-0000-4000-8000-000000000101",
        authoredVersion: 3,
      })
    ).resolves.toBeUndefined();
  });
});
