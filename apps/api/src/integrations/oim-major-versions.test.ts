import type { OimManifest } from "@tulipfarm/schema";
import type { SoulIntegration } from "@tulipfarm/soul";
import { describe, expect, it } from "vitest";
import {
  oimConnectionMatchesManifest,
  oimMajorStorageSlug,
  oimManifestMajor,
  oimPinnedToolId,
  requireOimConnectionForManifest,
  resolveOimMajorArtifact,
  resolveOimMajorInstallTarget,
  resolveOimUnversionedAlias,
} from "./oim-major-versions";

function manifest(version: string): OimManifest {
  return {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "acme",
      name: "Acme",
      version,
      description: "Acme API",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0" },
    operations: [
      {
        id: "tickets-list",
        name: "tickets_list",
        description: "List tickets",
        effect: "read",
        identityMode: "shared_only",
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://api.acme.example",
          path: "/tickets",
        },
        requestSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        response: {
          mode: "json",
          schema: {},
          maxBytes: 1_000_000,
        },
      },
    ],
  };
}

function installed(version: string, slug: string): SoulIntegration {
  const oimManifest = manifest(version);
  return {
    slug,
    sourceIntegration: oimManifest.metadata.id,
    oimManifest,
  };
}

describe("OIM major lifecycle", () => {
  it("installs the first major on the original slug and another major beside it", () => {
    const first = resolveOimMajorInstallTarget(manifest("1.4.0"), []);
    expect(first).toEqual({
      slug: "acme",
      integrationId: "acme",
      majorVersion: 1,
      disposition: "install",
    });

    const second = resolveOimMajorInstallTarget(manifest("2.0.0"), [
      installed("1.4.0", first.slug),
    ]);
    expect(second).toEqual({
      slug: "acme-v2",
      integrationId: "acme",
      majorVersion: 2,
      disposition: "install",
    });
    expect(second.slug).not.toContain("@");
  });

  it("keeps the exact original slug for an update within the same major", () => {
    expect(
      resolveOimMajorInstallTarget(manifest("1.9.0"), [installed("1.2.0", "acme-original")])
    ).toEqual({
      slug: "acme-original",
      integrationId: "acme",
      majorVersion: 1,
      disposition: "update",
    });
  });

  it("does not overwrite a colliding artifact or lock key", () => {
    const v1 = installed("1.0.0", "acme");
    const other = {
      ...installed("2.0.0", "other"),
      slug: "acme-v2",
      sourceIntegration: "other",
      oimManifest: {
        ...manifest("2.0.0"),
        metadata: { ...manifest("2.0.0").metadata, id: "other", name: "Other" },
      },
    };

    expect(() => resolveOimMajorInstallTarget(manifest("2.0.0"), [v1, other])).toThrowError(
      expect.objectContaining({ code: "slug_collision" })
    );
    expect(() => resolveOimMajorInstallTarget(manifest("2.0.0"), [v1], ["acme-v2"])).toThrowError(
      expect.objectContaining({ code: "slug_collision" })
    );
  });

  it("refuses a legacy-to-OIM format change", () => {
    const legacy = {
      slug: "acme",
      sourceIntegration: "acme",
      manifest: {
        name: "acme",
        version: "1.0.0",
        egress: { type: "none" },
      },
    } satisfies SoulIntegration;

    expect(() => resolveOimMajorInstallTarget(manifest("2.0.0"), [legacy])).toThrowError(
      expect.objectContaining({ code: "format_collision" })
    );
  });

  it("refuses duplicate copies of one integration major", () => {
    expect(() =>
      resolveOimMajorArtifact([installed("1.0.0", "acme"), installed("1.1.0", "acme-v1")], {
        id: "acme",
        majorVersion: 1,
      })
    ).toThrowError(expect.objectContaining({ code: "duplicate_major" }));
  });

  it("resolves exact majors and refuses an ambiguous friendly alias", () => {
    const v1 = installed("1.7.0", "acme");
    const v2 = installed("2.1.0", "acme-v2");
    const both = [v1, v2];

    expect(resolveOimMajorArtifact(both, { id: "acme", majorVersion: 1 })?.slug).toBe("acme");
    expect(resolveOimMajorArtifact(both, { id: "acme", majorVersion: 2 })?.slug).toBe("acme-v2");
    expect(() => resolveOimUnversionedAlias(both, "acme")).toThrowError(
      expect.objectContaining({ code: "ambiguous_alias" })
    );
  });

  it("keeps rollback and removal scoped to the exact artifact", () => {
    const v1 = installed("1.7.0", "acme");
    const v2 = installed("2.1.0", "acme-v2");

    const afterV2Removal = [v1, v2].filter((entry) => entry.slug !== "acme-v2");
    expect(resolveOimMajorArtifact(afterV2Removal, { id: "acme", majorVersion: 1 })?.slug).toBe(
      "acme"
    );

    const afterV1Removal = [v1, v2].filter((entry) => entry.slug !== "acme");
    expect(resolveOimMajorArtifact(afterV1Removal, { id: "acme", majorVersion: 2 })?.slug).toBe(
      "acme-v2"
    );
  });

  it("keeps pinned Tool identity and Connection binding on the old major", () => {
    const v1 = manifest("1.9.0");
    const v2 = manifest("2.0.0");
    const pinned = {
      toolId: oimPinnedToolId(v1, "tickets-list"),
      connectionId: "connection-v1",
    };
    const oldConnection = {
      id: pinned.connectionId,
      integration: { id: "acme", majorVersion: 1 },
    };
    const newConnection = {
      id: "connection-v2",
      integration: { id: "acme", majorVersion: 2 },
    };

    expect(pinned.toolId).toBe("oim.acme.v1.tickets-list");
    expect(oimPinnedToolId(v1, "tickets-list")).toBe(pinned.toolId);
    expect(oimPinnedToolId(v2, "tickets-list")).toBe("oim.acme.v2.tickets-list");
    expect(oimConnectionMatchesManifest(oldConnection, v1)).toBe(true);
    expect(oimConnectionMatchesManifest(newConnection, v1)).toBe(false);
    expect(() => requireOimConnectionForManifest(newConnection, v1)).toThrowError(
      expect.objectContaining({ code: "connection_mismatch" })
    );
  });

  it("rejects an unreadable version suffix instead of inventing another slug format", () => {
    expect(oimMajorStorageSlug("acme", 12)).toBe("acme-v12");
    expect(() => oimMajorStorageSlug("a".repeat(63), 2)).toThrowError(
      expect.objectContaining({ code: "invalid_slug" })
    );
    expect(() => oimManifestMajor(manifest("latest"))).toThrowError(
      expect.objectContaining({ code: "invalid_version" })
    );
  });
});
