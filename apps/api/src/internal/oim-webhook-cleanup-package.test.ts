import type { OimReleasePackage } from "@tulipfarm/integrations";
import { type OimManifest, oimFileDigest } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import {
  captureOimWebhookCleanupPackage,
  loadOimWebhookCleanupPackage,
} from "./oim-webhook-cleanup-package";

function packageWith(
  version: string,
  files: ReadonlyMap<string, string> = new Map()
): OimReleasePackage {
  const manifest: OimManifest = {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "acme",
      name: "Acme",
      version,
      description: "Acme package.",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0" },
    operations: [
      {
        id: "read",
        name: "acme_read",
        description: "Read Acme.",
        effect: "read",
        identityMode: "shared_only",
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://api.acme.example",
          path: "/read",
        },
        response: { schema: { type: "object" }, maxBytes: 4096 },
      },
    ],
    ...(files.size === 0
      ? {}
      : {
          files: [...files].map(([path, content]) => ({
            path,
            role: "guide" as const,
            sha256: oimFileDigest(content),
          })),
        }),
  };
  return { manifest, files };
}

describe("OIM webhook cleanup package snapshots", () => {
  it("retains exact bundled and installed bytes after the live package changes", () => {
    const bundled = captureOimWebhookCleanupPackage(packageWith("1.0.0"));
    const installed = captureOimWebhookCleanupPackage(
      packageWith("1.1.0", new Map([["setup-guide.md", "old bytes"]]))
    );
    const updated = packageWith("1.2.0", new Map([["setup-guide.md", "new bytes"]]));

    expect(updated.manifest.metadata.version).toBe("1.2.0");
    expect(loadOimWebhookCleanupPackage("acme-v1", bundled).integration.oimManifest).toMatchObject({
      metadata: { version: "1.0.0" },
    });
    expect(loadOimWebhookCleanupPackage("acme-v1", installed).integration.oimPackageFiles).toEqual({
      "setup-guide.md": Buffer.from("old bytes"),
    });
  });

  it("rejects changed manifest or companion bytes", () => {
    const snapshot = captureOimWebhookCleanupPackage(
      packageWith("1.1.0", new Map([["setup-guide.md", "approved bytes"]]))
    );

    expect(() =>
      loadOimWebhookCleanupPackage("acme-v1", {
        ...snapshot,
        manifestText: snapshot.manifestText.replace("Acme package.", "Changed package."),
      })
    ).toThrow("oim_webhook_cleanup_package_invalid");
    expect(() =>
      loadOimWebhookCleanupPackage("acme-v1", {
        ...snapshot,
        files: snapshot.files.map((file) => ({
          ...file,
          contentBase64: Buffer.from("tampered bytes").toString("base64"),
        })),
      })
    ).toThrow();
  });
});
