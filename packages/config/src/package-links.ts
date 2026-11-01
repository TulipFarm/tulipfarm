import { z } from 'zod';

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

export const marketplaceCatalogUrl = `${packageMarketplaceOrigin}/catalog.json`;

const catalogEntrySchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  license: z.string().trim().min(1),
  category: z.string().trim().min(1),
  tags: z.array(z.string().trim().min(1)),
  url: z.string(),
  page: z.string(),
});
const catalogSchema = z.object({
  schema: z.literal('https://tulipfarm.ai/schemas/system-package.v1.json'),
  packages: z.array(catalogEntrySchema),
});

/** A catalog entry with absolute links: `page` is the versioned package page and `url` its package.json. */
export type MarketplaceCatalogEntry = z.infer<typeof catalogEntrySchema>;

/** Parses catalog.json, rejecting duplicate versions and links that leave the package's own path. */
export function parseMarketplaceCatalog(value: unknown): MarketplaceCatalogEntry[] {
  const catalog = catalogSchema.parse(value);
  const identities = new Set<string>();
  return catalog.packages.map(entry => {
    const identity = `${entry.name}/${entry.version}`;
    if (identities.has(identity)) throw new Error('Duplicate public package version');
    identities.add(identity);
    const base = `${packageMarketplaceOrigin}/packages/${identity}/`;
    const page = new URL(entry.page, marketplaceCatalogUrl).href;
    const url = new URL(entry.url, marketplaceCatalogUrl).href;
    // The site links the latest version from an unversioned page; older catalogs linked the versioned one.
    if (![base, `${packageMarketplaceOrigin}/packages/${entry.name}/`].includes(page) || url !== `${base}package.json`)
      throw new Error('Invalid public package links');
    return { ...entry, page: base, url };
  });
}
