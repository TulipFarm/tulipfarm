// The anonymous visitor token for the public guide. Signup step 1 gets it (for the website lookup) and the onboarding
// chat reuses it, so the visitor passes one bot check. It lives in this tab only and lapses before the API's 24 hours.
import { z } from 'zod';
import { apiOrigin } from '@/lib/auth';

const key = 'tulipfarm:guide-visitor';
const storedSchema = z.object({ token: z.string(), expiresAt: z.number() });
let pending: Promise<string> | null = null;

export function cachedVisitor() {
  try {
    const stored = storedSchema.safeParse(JSON.parse(sessionStorage.getItem(key) ?? 'null'));
    if (stored.success && stored.data.expiresAt > Date.now()) return stored.data.token;
  } catch {}
  return null;
}

/** The cached token, or a new one from a solved bot check. Concurrent callers share one request. */
export function guideVisitor(challengeToken: string | null) {
  const cached = cachedVisitor();
  if (cached) return Promise.resolve(cached);
  if (pending) return pending;
  if (challengeToken === null) return Promise.reject(new Error('guide-challenge-pending'));
  pending = fetch(`${apiOrigin}/v1/public/guide/session`, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeToken }),
  })
    .then(async response => {
      if (!response.ok) throw new Error('guide-session-unavailable');
      const { token, expiresIn } = z.object({ token: z.string(), expiresIn: z.number() }).parse(await response.json());
      try {
        sessionStorage.setItem(key, JSON.stringify({ token, expiresAt: Date.now() + (expiresIn - 3600) * 1000 }));
      } catch {}
      return token;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** Finds the business's website from its name; null when the search finds nothing that clearly matches. */
export async function findWebsite(visitor: string, name: string, signal: AbortSignal) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const response = await fetch(`${apiOrigin}/v1/public/guide/website`, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${visitor}` },
    body: JSON.stringify({ name, language: navigator.language, ...(timeZone && { timeZone }) }),
    signal,
  });
  if (!response.ok) throw new Error(`guide-website-${response.status}`);
  return z.object({ website: z.string().nullable() }).parse(await response.json()).website;
}
