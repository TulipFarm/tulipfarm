import { createHash } from "node:crypto";
import type { BundledIntegration, SoulIntegration, SoulLoader } from "@tulipfarm/soul";

/**
 * A bundled integration (GitHub, Slack) is code-owned: install writes only `connection.yaml`
 * into Soul, never `manifest.yml` (`integrations/routes.ts`'s install path refuses to). So
 * `soulLoader.integrations` alone never carries a bundled integration's `manifest.ingress`
 * declaration or its classifier source — only live connection state. The ingress webhook route
 * and the Worker's delivery-host callback both need the bundled manifest and handler merged back
 * in, and computed live (not cached at boot) so a reinstall or disconnect is reflected
 * immediately, the same way `soulLoader.integrations` itself is live.
 */
export function resolveIngressIntegration(
  soulLoader: SoulLoader,
  bundled: ReadonlyMap<string, BundledIntegration>,
  slug: string
): SoulIntegration | undefined {
  const bundledEntry = bundled.get(slug);
  const soulEntry = soulLoader.integrations.get(slug);
  if (!bundledEntry) return soulEntry;

  const handlerFile = bundledEntry.ingressHandlerFile;
  return {
    slug,
    sourceIntegration: bundledEntry.manifest.name,
    manifest: bundledEntry.manifest,
    connection: soulEntry?.connection,
    setupGuide: bundledEntry.setupGuide ?? soulEntry?.setupGuide,
    ingressHandler: handlerFile
      ? {
          source: handlerFile.raw,
          hash: createHash("sha256").update(handlerFile.raw).digest("hex"),
        }
      : undefined,
    egressSpec: bundledEntry.egressSpec,
  };
}
