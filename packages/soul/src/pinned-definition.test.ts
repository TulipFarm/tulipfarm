import { generateKeyPairSync } from "node:crypto";
import { ARTIFACT_LAYOUTS } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { InMemoryBundleStore } from "./bundle";
import { compileExecutionBundle } from "./compiler";
import {
  assertLiveAuthorityKind,
  LiveAuthorityTemporalClassError,
  PinnedDefinitionLoader,
  type PinnedDefinitionRef,
  PinnedDefinitionTemporalClassError,
} from "./pinned-definition";
import {
  createEd25519BundleSigner,
  createEd25519BundleVerifier,
  signExecutionBundle,
} from "./signatures";

type UnsafePinnedDefinitionRef = Omit<PinnedDefinitionRef, "kind"> & { readonly kind: string };

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

function createVerifierFixture() {
  const keyId = "bundle-key";
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey
    .export({
      format: "pem",
      type: "pkcs8",
    })
    .toString();
  const publicKeyPem = publicKey
    .export({
      format: "pem",
      type: "spki",
    })
    .toString();

  return {
    signer: createEd25519BundleSigner(keyId, privateKeyPem),
    verifier: createEd25519BundleVerifier([{ keyId, publicKeyPem }]),
  };
}

function pinnedRef(
  bundleDigest: string,
  override: Partial<UnsafePinnedDefinitionRef> = {}
): PinnedDefinitionRef {
  return {
    businessId: "business-1",
    bundleDigest,
    kind: "Routine",
    definitionId: "00000000-0000-4000-8000-000000000101",
    authoredVersion: 3,
    ...override,
  } as PinnedDefinitionRef;
}

async function fixture() {
  const { signer, verifier } = createVerifierFixture();
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
  return { loader: new PinnedDefinitionLoader(bundles, verifier), record };
}

describe("PinnedDefinitionLoader", () => {
  it("opens the exact signed definition pinned by a Run", async () => {
    const { loader, record } = await fixture();

    const loaded = await loader.load(pinnedRef(record.digest));

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

    await expect(loader.load(pinnedRef(record.digest, override))).resolves.toBeUndefined();
  });

  it("refuses an unknown digest", async () => {
    const { loader } = await fixture();

    await expect(loader.load(pinnedRef("missing"))).resolves.toBeUndefined();
  });

  it("refuses every live artifact kind and unknown kind before opening a pinned bundle", async () => {
    const { loader, record } = await fixture();
    const liveLayouts = ARTIFACT_LAYOUTS.filter((layout) => layout.temporalClass === "live");

    expect(liveLayouts.length).toBeGreaterThan(0);

    for (const layout of liveLayouts) {
      await expect(loader.load(pinnedRef(record.digest, { kind: layout.kind }))).rejects.toThrow(
        PinnedDefinitionTemporalClassError
      );
    }

    await expect(loader.load(pinnedRef(record.digest, { kind: "GarbageKind" }))).rejects.toThrow(
      PinnedDefinitionTemporalClassError
    );
  });

  it("does not refuse any pinned artifact kind on temporal-class grounds", async () => {
    const { loader, record } = await fixture();
    const pinnedLayouts = ARTIFACT_LAYOUTS.filter((layout) => layout.temporalClass === "pinned");

    expect(pinnedLayouts.length).toBeGreaterThan(0);

    for (const layout of pinnedLayouts) {
      const loaded = await loader.load(pinnedRef(record.digest, { kind: layout.kind }));

      if (layout.kind === "Routine") {
        expect(loaded?.definition.kind).toBe("Routine");
      } else {
        expect(loaded).toBeUndefined();
      }
    }
  });
});

describe("assertLiveAuthorityKind", () => {
  it("refuses every pinned artifact kind and unknown kind", () => {
    const pinnedLayouts = ARTIFACT_LAYOUTS.filter((layout) => layout.temporalClass === "pinned");

    expect(pinnedLayouts.length).toBeGreaterThan(0);

    for (const layout of pinnedLayouts) {
      expect(() => assertLiveAuthorityKind(layout.kind)).toThrow(LiveAuthorityTemporalClassError);
    }

    expect(() => assertLiveAuthorityKind("GarbageKind")).toThrow(LiveAuthorityTemporalClassError);
  });

  it("accepts every live artifact kind", () => {
    const liveLayouts = ARTIFACT_LAYOUTS.filter((layout) => layout.temporalClass === "live");

    expect(liveLayouts.length).toBeGreaterThan(0);

    for (const layout of liveLayouts) {
      expect(() => assertLiveAuthorityKind(layout.kind)).not.toThrow();
    }
  });
});
