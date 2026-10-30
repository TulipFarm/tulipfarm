import { z } from 'zod';
import { packageMarketplaceOrigin } from '@tulipfarm/config/package-links';
import { systemPackageSchema, type SystemPackage } from '@tulipfarm/agents/system-package-contracts';

export const packageCatalogOrigin = packageMarketplaceOrigin;
const catalogUrl = `${packageCatalogOrigin}/catalog.json`;
const entrySchema = z.object({
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
  packages: z.array(entrySchema),
});

export type PublicPackage = z.infer<typeof entrySchema>;
export type PublicPackageDetails = { entry: PublicPackage; document: SystemPackage; source: string };

export async function loadPublicPackages(signal: AbortSignal): Promise<PublicPackage[]> {
  const response = await fetch(catalogUrl, {
    signal,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    redirect: 'error',
  });
  if (!response.ok) throw new Error('Public package catalog unavailable');
  const catalog = catalogSchema.parse(await response.json());
  const identities = new Set<string>();
  return catalog.packages.map(entry => {
    const identity = `${entry.name}/${entry.version}`;
    if (identities.has(identity)) throw new Error('Duplicate public package version');
    identities.add(identity);
    const base = `${packageCatalogOrigin}/packages/${identity}/`;
    const page = new URL(entry.page, catalogUrl).href;
    const url = new URL(entry.url, catalogUrl).href;
    if (page !== base || url !== `${base}package.json`) throw new Error('Invalid public package links');
    return { ...entry, page, url };
  });
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
