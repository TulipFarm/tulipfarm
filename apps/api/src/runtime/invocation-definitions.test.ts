import type { VersionedSchemaDocument } from "@tulipfarm/schema";
import {
  compileExecutionBundle,
  createHmacBundleSigner,
  InMemoryBundleStore,
  SoulPublicationCoordinator,
  signExecutionBundle,
} from "@tulipfarm/soul";
import { InMemorySoulPublicationStore } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { ActiveRoutineInvocationResolver } from "./invocation-definitions";

const BUSINESS_ID = "business-1";
const signer = createHmacBundleSigner("bundle-key-1", "secret");

function routine(
  lifecycle: "draft" | "published" = "published",
  start = "Collect"
): VersionedSchemaDocument {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "Routine",
    metadata: {
      id: "11111111-1111-4111-8111-111111111111",
      slug: "daily-digest",
      schemaVersion: 1,
      authoredVersion: 7,
      lifecycle,
    },
    spec: {
      owner: "platform",
      start,
      states: [{ type: "wait", name: "Collect", waitFor: { kind: "timer", durationMs: 1 } }],
    },
  } as VersionedSchemaDocument;
}

async function activeResolver(document: VersionedSchemaDocument) {
  const publications = new SoulPublicationCoordinator(
    new InMemorySoulPublicationStore(),
    new InMemoryBundleStore(),
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  );
  const bundle = compileExecutionBundle({
    businessId: BUSINESS_ID,
    changesetId: "changeset-1",
    commitSha: "c0ffee",
    documents: [document],
  });
  await publications.publish({ bundle: signExecutionBundle(bundle, signer) });
  await publications.drain("test");
  return new ActiveRoutineInvocationResolver(publications, signer);
}

describe("ActiveRoutineInvocationResolver", () => {
  it("pins the verified active digest, stable Routine identity, version, and start State", async () => {
    const resolver = await activeResolver(routine());

    await expect(
      resolver.resolve({
        businessId: BUSINESS_ID,
        definitionRef: "published:routine:daily-digest",
      })
    ).resolves.toEqual({
      bundle: {
        digest: expect.stringMatching(/^[0-9a-f]{64}$/),
        routineId: "11111111-1111-4111-8111-111111111111",
        routineVersion: "7",
      },
      startState: {
        key: "Collect",
        definitionRef: expect.stringMatching(
          /^bundle:[0-9a-f]{64}\/routines\/11111111-1111-4111-8111-111111111111@7\/states\/Collect$/
        ),
      },
    });
  });

  it("does not consult another source when no bundle is active", async () => {
    const publications = new SoulPublicationCoordinator(
      new InMemorySoulPublicationStore(),
      new InMemoryBundleStore(),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    );
    const resolver = new ActiveRoutineInvocationResolver(publications, signer);

    await expect(
      resolver.resolve({
        businessId: BUSINESS_ID,
        definitionRef: "published:routine:daily-digest",
      })
    ).resolves.toBeUndefined();
  });

  it.each([
    ["a draft Routine", routine("draft")],
    ["an unknown start State", routine("published", "Missing")],
  ])("refuses %s even when its bundle was activated", async (_label, document) => {
    const resolver = await activeResolver(document);
    await expect(
      resolver.resolve({
        businessId: BUSINESS_ID,
        definitionRef: "published:routine:daily-digest",
      })
    ).resolves.toBeUndefined();
  });

  it("refuses a non-Routine definition reference", async () => {
    const resolver = await activeResolver(routine());
    await expect(
      resolver.resolve({
        businessId: BUSINESS_ID,
        definitionRef: "published:agent:daily-digest",
      })
    ).resolves.toBeUndefined();
  });
});
