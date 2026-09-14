import {
  type OimReleaseInstallSnapshot,
  type OimReleasePackage,
  verifyOimReleasePackage,
} from "@tulipfarm/integrations";
import { canonicalize, type OimPackageContent, parseOimManifest } from "@tulipfarm/schema";
import type { SoulIntegration } from "@tulipfarm/soul";
import type { OimWebhookCleanupPackageSnapshot } from "@tulipfarm/storage";

function contentBytes(content: OimPackageContent): Buffer {
  return typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
}

export function captureOimWebhookCleanupPackage(
  package_: OimReleasePackage
): OimWebhookCleanupPackageSnapshot {
  const manifest = structuredClone(package_.manifest);
  const files = new Map<string, OimPackageContent>();
  for (const [path, content] of package_.files) {
    files.set(path, typeof content === "string" ? content : new Uint8Array(content));
  }
  const verified = verifyOimReleasePackage({ manifest, files });
  const snapshot = {
    ...verified,
    majorVersion: Number(verified.version.split(".", 1)[0]),
    manifestText: canonicalize(manifest),
    files: verified.files.map((file) => {
      const content = files.get(file.path);
      if (content === undefined) throw new Error("verified_oim_companion_missing");
      return { ...file, contentBase64: contentBytes(content).toString("base64") };
    }),
  } satisfies OimReleaseInstallSnapshot;
  return Object.freeze(snapshot);
}

export function loadOimWebhookCleanupPackage(
  integrationKey: string,
  snapshot: OimWebhookCleanupPackageSnapshot
): { readonly key: string; readonly integration: SoulIntegration } {
  try {
    const manifest = parseOimManifest(snapshot.manifestText);
    const files = new Map<string, OimPackageContent>();
    for (const file of snapshot.files) {
      const bytes = Buffer.from(file.contentBase64, "base64");
      if (bytes.toString("base64") !== file.contentBase64 || files.has(file.path)) {
        throw new Error("invalid_file");
      }
      files.set(file.path, bytes);
    }
    const verified = verifyOimReleasePackage({ manifest, files });
    if (
      snapshot.manifestText !== canonicalize(manifest) ||
      snapshot.integrationId !== verified.integrationId ||
      snapshot.version !== verified.version ||
      snapshot.majorVersion !== Number(verified.version.split(".", 1)[0]) ||
      snapshot.packageDigest !== verified.packageDigest ||
      snapshot.files.length !== verified.files.length ||
      snapshot.files.some((file, index) => {
        const expected = verified.files[index];
        return (
          expected === undefined ||
          file.path !== expected.path ||
          file.role !== expected.role ||
          file.sha256 !== expected.sha256
        );
      })
    ) {
      throw new Error("oim_webhook_cleanup_package_invalid");
    }
    return {
      key: integrationKey,
      integration: {
        slug: integrationKey,
        sourceIntegration: verified.integrationId,
        oimManifest: manifest,
        oimPackageFiles: Object.fromEntries(files),
      },
    };
  } catch (error) {
    throw new Error("oim_webhook_cleanup_package_invalid", { cause: error });
  }
}
