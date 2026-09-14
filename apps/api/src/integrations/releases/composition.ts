import type {
  OimPackageCatalogEntry,
  ReviewedCommunityIntegrationInstaller,
} from "@tulipfarm/integrations";
import type { OimReleaseControlPlane } from "./control-plane";

export function liveOimPackageCatalog(
  read: () => readonly OimPackageCatalogEntry[]
): readonly OimPackageCatalogEntry[] {
  return new Proxy([] as OimPackageCatalogEntry[], {
    get(_target, property) {
      const catalog = read();
      const value = Reflect.get(catalog, property, catalog);
      return typeof value === "function" ? value.bind(catalog) : value;
    },
  });
}

export function synchronizeOimReleaseControlPlane(
  controlPlane: OimReleaseControlPlane,
  sync: () => void
): OimReleaseControlPlane {
  const mutating = new Set([
    "install",
    "uninstall",
    "recover",
    "setAutoPatchPreference",
    "addTrustRoot",
    "disableTrustRoot",
    "setRevocationFeed",
    "disableRevocationFeed",
    "acceptRevocationList",
    "runMaintenance",
  ]);
  return new Proxy(controlPlane, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (!mutating.has(String(property))) return value.bind(target);
      return async (...args: unknown[]) => {
        const result = await value.apply(target, args);
        sync();
        return result;
      };
    },
  });
}

export function synchronizeReviewedCommunityInstaller(
  installer: ReviewedCommunityIntegrationInstaller,
  sync: () => void
): ReviewedCommunityIntegrationInstaller {
  return {
    async install(input) {
      const result = await installer.install(input);
      if (result.success) sync();
      return result;
    },
  };
}
