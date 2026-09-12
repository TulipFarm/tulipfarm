import { type OimManifest, validateOimManifest } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import {
  connectionMatchesPackage,
  type OimPackageCatalogEntry,
  resolveOimPackage,
} from "./catalog";

function manifest(id: string, version: string): OimManifest {
  return validateOimManifest({
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id,
      name: id,
      version,
      description: `${id} integration`,
      license: "Apache-2.0",
    },
    profiles: { core: "1.0" },
    operations: [
      {
        id: "read",
        name: "read",
        description: "Read data.",
        effect: "read",
        identityMode: "shared_only",
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://api.example.com",
          path: "/",
        },
        response: { schema: { type: "object" }, maxBytes: 1_024 },
      },
    ],
  });
}

describe("OIM package catalog resolution", () => {
  it("resolves the authoritative route key without parsing a version suffix", () => {
    const entries: OimPackageCatalogEntry[] = [
      { key: "acme", manifest: manifest("acme", "1.8.0") },
      { key: "acme-v2", manifest: manifest("acme", "2.1.0") },
      { key: "reports-v2", manifest: manifest("reports-v2", "1.0.0") },
    ];

    expect(resolveOimPackage(entries, "acme-v2")).toMatchObject({
      key: "acme-v2",
      identity: { id: "acme", majorVersion: 2 },
    });
    expect(resolveOimPackage(entries, "reports-v2")).toMatchObject({
      key: "reports-v2",
      identity: { id: "reports-v2", majorVersion: 1 },
    });
    expect(
      resolveOimPackage(
        [{ key: "reviewed", manifest: manifest("acme", "2.1.0"), packageDigest: "package-v1" }],
        "reviewed"
      )?.packageDigest
    ).toBe("package-v1");
  });

  it("matches Connections only to the exact Integration id and major", () => {
    const entry = resolveOimPackage(
      [{ key: "acme-v2", manifest: manifest("acme", "2.1.0") }],
      "acme-v2"
    );
    if (entry === undefined) throw new Error("expected package");

    expect(connectionMatchesPackage({ integration: { id: "acme", majorVersion: 2 } }, entry)).toBe(
      true
    );
    expect(connectionMatchesPackage({ integration: { id: "acme", majorVersion: 1 } }, entry)).toBe(
      false
    );
    expect(
      connectionMatchesPackage({ integration: { id: "acme-v2", majorVersion: 2 } }, entry)
    ).toBe(false);
  });
});
