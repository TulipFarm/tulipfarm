export const packageMarketplaceOrigin = 'https://packages.tulipfarm.ai';

export type MarketplacePackage = { name: string; version: string; url: string };

export function marketplaceInstallRequest(text: string): MarketplacePackage | null {
  const match = /^install\s+(\S+)$/i.exec(text.trim());
  return match ? marketplacePackage(match[1]!) : null;
}

export function marketplacePackage(input: string): MarketplacePackage | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.origin !== packageMarketplaceOrigin || url.username || url.password) return null;
  const match =
    /^\/packages\/([a-z][a-z0-9-]{0,63})\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:\/(?:package\.json)?)?$/.exec(
      url.pathname,
    );
  if (!match) return null;
  const [, name, version] = match;
  return {
    name: name!,
    version: version!,
    url: `${packageMarketplaceOrigin}/packages/${name}/${version}/package.json`,
  };
}

export function marketplacePackagesInPrompt(text: string): MarketplacePackage[] {
  const packages = new Map<string, MarketplacePackage>();
  for (const match of text.matchAll(/https:\/\/[^\s<>"`]+/gi)) {
    const entry = marketplacePackage(match[0].replace(/[)\]}>.,;!?]+$/, ''));
    if (entry) packages.set(entry.url, entry);
  }
  return [...packages.values()];
}
