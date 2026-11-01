import {
  marketplaceCatalogUrl,
  parseMarketplaceCatalog,
  type MarketplaceCatalogEntry,
} from '@tulipfarm/config/package-links';
import { fetchPublicFile } from './web-fetch.ts';

const catalogLifetimeMs = 10 * 60_000;
let cached: { at: number; entries: MarketplaceCatalogEntry[] } | undefined;

const stopWords = new Set(
  'a an and app are build can create for from help how in into is it let lets manage me my need of on or our set setup system team that the this to track tracker want we with workspace'.split(
    ' ',
  ),
);

function stem(word: string) {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

const terms = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map(stem)
      .filter(word => word.length > 1 && !stopWords.has(word)),
  );

/**
 * Ranks catalog entries by how many of the need's words appear in each entry, weighting the name and
 * tags above the title, and the title above the category and description. Weak tails are dropped.
 */
export function rankMarketplacePackages(entries: readonly MarketplaceCatalogEntry[], need: string, limit = 3) {
  const wanted = terms(need);
  const scored = entries
    .map(entry => {
      const fields: [Set<string>, number][] = [
        [terms(`${entry.name} ${entry.tags.join(' ')}`), 4],
        [terms(entry.title), 3],
        [terms(entry.category), 1],
        [terms(entry.description), 1],
      ];
      let score = 0;
      for (const word of wanted)
        score += Math.max(0, ...fields.map(([words, weight]) => (words.has(word) ? weight : 0)));
      return { entry, score };
    })
    .filter(item => item.score >= 4)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
  const best = scored[0]?.score ?? 0;
  return scored
    .filter(item => item.score * 2 > best)
    .slice(0, limit)
    .map(item => item.entry);
}

async function loadCatalog(signal: AbortSignal) {
  if (cached && Date.now() - cached.at < catalogLifetimeMs) return cached.entries;
  const fetched = await fetchPublicFile(marketplaceCatalogUrl, signal, { redirect: 'error' });
  if (fetched.kind !== 'file') return { error: fetched.kind === 'failed' ? fetched.reason : 'catalog-json-required' };
  let entries: MarketplaceCatalogEntry[];
  try {
    entries = parseMarketplaceCatalog(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fetched.bytes)));
  } catch {
    return { error: 'catalog-invalid' };
  }
  cached = { at: Date.now(), entries };
  return entries;
}

export async function recommendMarketplacePackages(need: string, signal: AbortSignal) {
  const catalog = await loadCatalog(signal);
  if (!Array.isArray(catalog)) return { ...catalog, packages: [] };
  const packages = rankMarketplacePackages(catalog, need).map(entry => ({
    title: entry.title,
    description: entry.description,
    category: entry.category,
    url: entry.page,
  }));
  return {
    untrusted: true,
    installed: false,
    packages,
    instruction: packages.length
      ? 'These ready-made packages may fit. Offer only the ones that match the request, with one plain sentence on what each gives the person and its exact url. Then ask with present.choice whether to use a package or build a custom setup. The person opens the url to review and install it; do not install it or build its parts yourself.'
      : 'No marketplace package matches this request. Continue with a custom setup and do not mention packages.',
  };
}

/** Clears the cached catalog. For tests only. */
export function resetMarketplaceCatalogCache() {
  cached = undefined;
}
