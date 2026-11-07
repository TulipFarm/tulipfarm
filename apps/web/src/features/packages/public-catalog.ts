import {
  marketplaceCatalogUrl,
  packageMarketplaceOrigin,
  parseMarketplaceCatalog,
  type MarketplaceCatalogEntry,
} from '@tulipfarm/config/package-links';
import { systemPackageSchema, type SystemPackage } from '@tulipfarm/agents/system-package-contracts';

export const packageCatalogOrigin = packageMarketplaceOrigin;

export type PublicPackage = MarketplaceCatalogEntry;
export type PublicPackageDetails = { entry: PublicPackage; document: SystemPackage; source: string };

export async function loadPublicPackages(signal: AbortSignal): Promise<PublicPackage[]> {
  const response = await fetch(marketplaceCatalogUrl, {
    signal,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    redirect: 'error',
  });
  if (!response.ok) throw new Error('Public package catalog unavailable');
  return parseMarketplaceCatalog(await response.json());
}

export async function loadPublicPackage(
  name: string,
  version: string,
  signal: AbortSignal,
): Promise<PublicPackageDetails> {
  const catalog = await loadPublicPackages(signal);
  const entry = catalog.find(item => item.name === name && item.version === version);
  if (!entry) throw Object.assign(new Error('Package not found'), { status: 404 });
  const response = await fetch(entry.url, {
    signal,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    redirect: 'error',
  });
  if (!response.ok) throw Object.assign(new Error('Package unavailable'), { status: response.status });
  const source = await response.text();
  const document = systemPackageSchema.parse(JSON.parse(source));
  if (document.package.name !== name || document.package.version !== version)
    throw new Error('Package identity does not match the catalog');
  return { entry, document, source };
}

export function publicPackageInstallPrompt(name: string, version: string) {
  return `Install ${packageCatalogOrigin}/packages/${name}/${version}/package.json`;
}
