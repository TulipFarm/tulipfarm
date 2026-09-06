import type { OimManifest } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { knowledgeManifestFixture } from "../knowledge/oim-manifest.fixture";
import { describeOimCapabilities } from "./review";

function withOperations(extra: OimManifest["operations"]): OimManifest {
  const manifest = knowledgeManifestFixture();
  return { ...manifest, operations: [...manifest.operations, ...extra] };
}

describe("describeOimCapabilities", () => {
  it("reports the package identity and a digest of the exact manifest", () => {
    const manifest = knowledgeManifestFixture();
    const review = describeOimCapabilities(manifest);

    expect(review.integrationId).toBe("wiki");
    expect(review.version).toBe("2.1.0");
    expect(review.license).toBe("Apache-2.0");
    expect(review.packageDigest).toMatch(/^[0-9a-f]{64}$/);

    const renamed = describeOimCapabilities({
      ...manifest,
      metadata: { ...manifest.metadata, version: "2.1.1" },
    });
    expect(renamed.packageDigest).not.toBe(review.packageDigest);
  });

  it("deduplicates destinations down to hosts", () => {
    const review = describeOimCapabilities(knowledgeManifestFixture());
    expect(review.destinations).toEqual(["wiki.example"]);
  });

  it("lists every host when operations reach more than one", () => {
    const manifest = knowledgeManifestFixture();
    const [first] = manifest.operations;
    const review = describeOimCapabilities(
      withOperations([
        {
          ...first,
          id: "audit-log",
          source: { ...first.source, baseUrl: "https://audit.example" },
        } as OimManifest["operations"][number],
      ])
    );
    expect(review.destinations).toEqual(["audit.example", "wiki.example"]);
  });

  it("marks writing operations as mutating and read-only ones as not", () => {
    const manifest = knowledgeManifestFixture();
    const [first] = manifest.operations;
    const review = describeOimCapabilities(
      withOperations([
        { ...first, id: "delete-page", effect: "delete" } as OimManifest["operations"][number],
      ])
    );

    expect(review.operations.find((op) => op.id === "delete-page")?.mutating).toBe(true);
    expect(review.operations.filter((op) => op.effect === "read").every((op) => !op.mutating)).toBe(
      true
    );
    expect(review.effects).toEqual(["delete", "read"]);
  });

  it("summarises the Knowledge profile a reviewer is approving", () => {
    const review = describeOimCapabilities(knowledgeManifestFixture());
    expect(review.knowledge?.sourceKinds).toContain("space");
    expect(review.knowledge?.propagatesDeletions).toBe(true);
  });

  it("omits the Knowledge block when the package declares none", () => {
    const manifest = knowledgeManifestFixture();
    const { knowledge: _dropped, ...withoutKnowledge } = manifest;
    expect(describeOimCapabilities(withoutKnowledge as OimManifest).knowledge).toBeUndefined();
  });

  it("flags a package that ships a hook file", () => {
    const manifest = knowledgeManifestFixture();
    expect(describeOimCapabilities(manifest).declaresHooks).toBe(false);

    const withHook = describeOimCapabilities({
      ...manifest,
      files: [
        ...(manifest.files ?? []),
        { path: "hooks.js", role: "hook", sha256: "a".repeat(64) },
      ],
    } as OimManifest);
    expect(withHook.declaresHooks).toBe(true);
    expect(withHook.files.map((file) => file.path)).toContain("hooks.js");
  });

  it("reports ingress when the package accepts deliveries", () => {
    const manifest = knowledgeManifestFixture();
    const review = describeOimCapabilities({
      ...manifest,
      events: {
        path: "/wiki",
        verification: { scheme: "hmac_sha256", secretSlot: "signing" },
        deduplication: { kind: "body_pointer", bodyPointer: "/id" },
        eventTypes: [
          {
            type: "page.updated",
            selector: { pointer: "/type", equals: "page.updated" },
            schema: { type: "object" },
          },
        ],
      },
    } as OimManifest);

    expect(review.ingress?.path).toBe("/wiki");
    expect(review.ingress?.verification).toBe("hmac_sha256");
    expect(review.ingress?.eventTypes).toEqual(["page.updated"]);
  });

  it("reports a base URL that will not parse rather than hiding it", () => {
    const manifest = knowledgeManifestFixture();
    const [first] = manifest.operations;
    const review = describeOimCapabilities({
      ...manifest,
      operations: [{ ...first, source: { ...first.source, baseUrl: "not a url" } }],
    } as OimManifest);
    expect(review.destinations).toEqual(["not a url"]);
  });
});
