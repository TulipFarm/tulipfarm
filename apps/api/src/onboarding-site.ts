// Reads the website a visitor gave in signup step 1 so TulipFarm's first message can be about their business. The
// homepage goes through the same public page reader as agents (Huntsman, public addresses only, https only). Its text
// is untrusted: it only shapes the opening and never becomes instructions.
import { fetchPublicText } from '@tulipfarm/agents/web-fetch';

export type OnboardingSite = { title: string; description: string; text: string };

/** How long the chat's first message waits for the homepage before going on without it. */
export const siteReadLimits = { deadlineMs: 12_000, textChars: 4000 };

const clean = (value: string, length: number) => value.replace(/\s+/g, ' ').trim().slice(0, length);

/** Page Markdown as plain lines: images dropped, links reduced to their text, heading and list marks removed. */
function plainLines(markdown: string) {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .split('\n')
    .map(line =>
      line
        .replace(/^\s*(#+|[-*+>]|\d+\.)\s+/, '')
        .replace(/[*_`]/g, '')
        .trim(),
    )
    .filter(Boolean);
}

const boilerplate = /cookie|javascript|skip to|sign in|log in|privacy|accept|subscribe/i;

export async function readOnboardingSite(website: string, signal: AbortSignal): Promise<OnboardingSite | null> {
  const timeout = new Promise<null>(resolve => {
    const timer = setTimeout(() => resolve(null), siteReadLimits.deadlineMs);
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve(null)), { once: true });
  });
  const read = fetchPublicText(website)
    .then(result => {
      const page = result.pages[0];
      if (!page || page.status !== 'read') return null;
      const site = {
        title: clean(page.title, 200),
        description: clean(page.description, 400),
        text: plainLines(page.text).join('\n').slice(0, siteReadLimits.textChars),
      };
      return site.title || site.description || site.text ? site : null;
    })
    .catch(() => null);
  return Promise.race([read, timeout]);
}

/**
 * The short line the rules quote back when no model is available: the page's description, else its first sentence-like
 * line that is not a cookie banner or navigation. A bare title says too little to quote.
 */
export function siteLine(site: OnboardingSite | null) {
  if (!site) return null;
  if (site.description.length >= 30) return clean(site.description, 200);
  const line = site.text
    .split('\n')
    .find(text => text.length >= 30 && text.length <= 240 && text.includes(' ') && !boilerplate.test(text));
  return line ? clean(line, 200) : null;
}
