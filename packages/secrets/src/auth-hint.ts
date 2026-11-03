import { containsSecret } from './reflection.ts';

export const AUTH_HINT_STATUSES = [401, 403, 407] as const;
const MAX_EXCERPT = 500;

export type AuthHint = { status: number; challenge: string | null; excerpt: string | null };

/**
 * Summarises an authentication failure for the agent, so it can ask the member for the right secret and
 * placement. Anything that echoes a secret already sent is dropped.
 */
export function authHint(
  response: { status: number; headers: Readonly<Record<string, string>>; body?: string },
  sent: readonly string[] = [],
): AuthHint | null {
  if (!(AUTH_HINT_STATUSES as readonly number[]).includes(response.status)) return null;
  const header = Object.entries(response.headers).find(([name]) =>
    ['www-authenticate', 'proxy-authenticate'].includes(name.toLowerCase()),
  )?.[1];
  const challenge = header && !containsSecret(header, sent) ? header.slice(0, MAX_EXCERPT) : null;
  const text = response.body?.replace(/\s+/g, ' ').trim().slice(0, MAX_EXCERPT) || null;
  const excerpt = text && !containsSecret(text, sent) ? text : null;
  return { status: response.status, challenge, excerpt };
}
