import { z } from 'zod';
import { callbackSchema } from '@tulipfarm/github/contracts';

// GitHub sends people back to one of these pages, never to the page where they started.
export const githubReturnPaths = ['/github/callback', '/integrations/github'] as const;
const storageKey = 'tulipfarm:github-return';
const maxAge = 60 * 60 * 1000;
const storedSchema = z.object({ workspaceId: z.uuid(), path: z.string().nullable(), at: z.number() });
const setupActionSchema = z.enum(['install', 'update', 'request']);

export type GitHubCallbackInput = z.infer<typeof callbackSchema>;
export type GitHubReturnParams =
  | { kind: 'oauth'; input: GitHubCallbackInput; workspaceId: string }
  | { kind: 'setup'; action: z.infer<typeof setupActionSchema> | null }
  | { kind: 'invalid'; workspaceId: string | null };

function appPath(value: string | null) {
  if (!value?.startsWith('/') || value.startsWith('//')) return null;
  const pathname = value.split(/[?#]/)[0] ?? '';
  return githubReturnPaths.some(path => pathname === path) ? null : value;
}

function read() {
  try {
    const parsed = storedSchema.safeParse(JSON.parse(window.localStorage.getItem(storageKey) ?? 'null'));
    return parsed.success && Date.now() - parsed.data.at <= maxAge ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Remembers where a GitHub sign-in or App installation started, so the return page can link back. */
export function rememberGitHubReturn(workspaceId: string) {
  const here = appPath(window.location.pathname + window.location.search);
  const previous = read();
  const path = here ?? (previous?.workspaceId === workspaceId ? previous.path : null);
  try {
    window.localStorage.setItem(storageKey, JSON.stringify({ workspaceId, path, at: Date.now() }));
  } catch {
    /* Storage can be disabled by the browser; the return page then links to GitHub accounts only. */
  }
}

export function githubReturn(workspaceId?: string) {
  const stored = read();
  if (!stored || (workspaceId && stored.workspaceId !== workspaceId)) return null;
  return { workspaceId: stored.workspaceId, path: appPath(stored.path) };
}

const workspaceOf = (state: unknown) => {
  const id = z.uuid().safeParse(typeof state === 'string' ? state.slice(0, 36) : undefined);
  return id.success ? id.data : null;
};

/**
 * Sorts a GitHub return URL into a sign-in callback, an App installation return, or an invalid
 * request. GitHub adds `installation_id` and `setup_action` when an installation happens in the
 * same trip; they prove nothing on their own, so they are dropped before the callback is checked.
 */
export function parseGitHubReturn(pathname: string, search: string): GitHubReturnParams {
  const params = new URLSearchParams(search);
  const values = Object.fromEntries(params);
  if ([...params.keys()].some(key => params.getAll(key).length !== 1))
    return { kind: 'invalid', workspaceId: workspaceOf(values.state) };
  const { installation_id: installation, setup_action: setupAction, ...rest } = values;
  if (installation !== undefined && !/^[1-9][0-9]{0,19}$/.test(installation))
    return { kind: 'invalid', workspaceId: workspaceOf(values.state) };
  const callback = callbackSchema.safeParse(rest);
  if (callback.success)
    return { kind: 'oauth', input: callback.data, workspaceId: callback.data.state.slice(0, 36).toLowerCase() };
  const action = setupActionSchema.safeParse(setupAction);
  // An installation that also asked for sign-in returns a code without our state; it cannot be
  // tied to a consent attempt, so it is treated as an installation return.
  if (
    (action.success ||
      (pathname === '/integrations/github' && !installation && !setupAction && !Object.keys(rest).length)) &&
    Object.keys(rest).every(key => key === 'code')
  )
    return { kind: 'setup', action: action.success ? action.data : null };
  return { kind: 'invalid', workspaceId: workspaceOf(values.state) };
}
