// Finds the website of a business from its name, so signup step 1 can fill it in. It searches the public web (SearXNG),
// biased towards the visitor's region by their browser's locale and time zone, and only returns a homepage whose
// domain matches the name. A guess the visitor didn't make is worse than an empty field, so anything else is null.
import { searchPublicWeb } from '@tulipfarm/agents/web-fetch';

/** Sites that list or mention businesses but are not their own website. */
const directories =
  /(^|\.)(linkedin|facebook|instagram|x|twitter|youtube|tiktok|pinterest|reddit|wikipedia|wikidata|crunchbase|glassdoor|indeed|yelp|tripadvisor|justdial|indiamart|zaubacorp|tofler|bloomberg|zoominfo|apollo|amazon|flipkart|google|apple|bing|github|medium|quora|trustpilot|g2|capterra|yellowpages|mapquest|bbb)\.[a-z.]+$/i;
const noise = /\b(the|inc|llc|ltd|limited|pvt|private|co|company|corp|corporation|gmbh|plc|llp)\b/gi;

const compact = (value: string) =>
  value
    .toLowerCase()
    .replace(noise, '')
    .replace(/[^a-z0-9]/g, '');

/** The domain's name part, without www or the public suffix: "shop.acme.co.uk" gives "acme". */
function label(host: string) {
  const parts = host
    .toLowerCase()
    .replace(/^www\./, '')
    .split('.');
  const suffix = parts.length > 2 && parts.at(-2)!.length <= 3 ? 2 : 1;
  return parts.at(-(suffix + 1)) ?? parts[0]!;
}

export function matchesName(host: string, name: string) {
  const key = compact(name);
  const site = label(host).replace(/[^a-z0-9]/g, '');
  if (key.length < 3 || site.length < 3 || directories.test(host)) return false;
  return site === key || (site.length >= 4 && key.includes(site)) || (key.length >= 4 && site.includes(key));
}

export type WebsiteHint = { language?: string | undefined; timeZone?: string | undefined };

export async function findWebsite(name: string, hint: WebsiteHint, signal: AbortSignal): Promise<string | null> {
  // A city from the time zone, such as Kolkata from Asia/Kolkata, narrows a common name to the visitor's region.
  const city = hint.timeZone?.includes('/') ? hint.timeZone.split('/').at(-1)!.replaceAll('_', ' ') : null;
  for (const query of [`${name} official website`, ...(city ? [`${name} ${city}`] : [])]) {
    const result = await searchPublicWeb({ query, window: 'any', limit: 8, language: hint.language, signal }).catch(
      () => null,
    );
    for (const source of result?.sources ?? []) {
      const url = new URL(source.url);
      if (matchesName(url.hostname, name)) return `https://${url.hostname}/`;
    }
  }
  return null;
}
