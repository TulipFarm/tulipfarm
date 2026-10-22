import { createAuthClient } from 'better-auth/react';
import { inferAdditionalFields, magicLinkClient } from 'better-auth/client/plugins';
import { resolveApiOrigin } from './api-origin';
import { workspaceSlugError } from './workspace-slug';
import { invitationTokenSchema } from '@tulipfarm/workspaces/governance-contracts';
import { workspaceSetupSchema } from '@tulipfarm/workspaces/contracts';

export const apiOrigin =
  resolveApiOrigin(import.meta.env.VITE_API_URL, import.meta.env.DEV, globalThis.location?.origin) ?? '';
export const authClient = createAuthClient({
  baseURL: apiOrigin,
  basePath: '/v1/auth',
  plugins: [
    magicLinkClient(),
    inferAdditionalFields({ user: { lastModelFamilyId: { type: 'string', required: false } } }),
  ],
  fetchOptions: { credentials: 'include' },
  sessionOptions: { refetchInterval: 300, refetchOnWindowFocus: true },
});

function hasUnsafeCharacters(value: string) {
  return /[\\\s]/.test(value) || Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

// Signed-in pages outside a workspace. Their first segments are reserved from workspace slugs.
function isAccountDestination(pathname: string) {
  if (
    pathname === '/create-workspace' ||
    pathname === '/onboarding' ||
    pathname === '/onboarding/chat' ||
    pathname === '/account/workspace-recovery'
  )
    return true;
  const [, root, setupId, ...rest] = pathname.split('/');
  return root === 'workspace-setups' && rest.length === 0 && workspaceSetupSchema.shape.id.safeParse(setupId).success;
}

export function safeAuthRedirect(value: unknown) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || hasUnsafeCharacters(value))
    return '/';
  try {
    const url = new URL(value, globalThis.location?.origin ?? 'http://localhost');
    const path = decodeURIComponent(url.pathname);
    if (path === '/invite') {
      const token = invitationTokenSchema.safeParse(url.searchParams.get('token'));
      return url.pathname === '/invite' && token.success && [...url.searchParams.keys()].length === 1 && !url.hash
        ? `/invite?token=${token.data}`
        : '/';
    }
    const firstSegment = path.split('/')[1] ?? '';
    if (path !== '/' && !isAccountDestination(url.pathname) && workspaceSlugError(firstSegment)) return '/';
    if (hasUnsafeCharacters(path)) return '/';
    return url.pathname + url.search + url.hash;
  } catch {
    return '/';
  }
}

export function authCallbackURLs(destination: unknown, origin: string) {
  const redirect = safeAuthRedirect(destination);
  const callbackURL = new URL(redirect, origin).href;
  const errorURL = new URL('/login', origin);
  errorURL.searchParams.set('error', 'sign_in_failed');
  errorURL.searchParams.set('redirect', redirect);
  return { callbackURL, newUserCallbackURL: callbackURL, errorCallbackURL: errorURL.href };
}

export function magicLinkDestination(callback: string | null, origin: string) {
  if (!callback) return '/';
  try {
    const url = new URL(callback, origin);
    return url.origin === origin ? safeAuthRedirect(url.pathname + url.search + url.hash) : '/';
  } catch {
    return '/';
  }
}

type Session = typeof authClient.$Infer.Session;
interface SessionState {
  data: Session | null;
  error: { status?: number } | null;
  isPending: boolean;
  isRefetching: boolean;
  refetch: () => Promise<void>;
}
interface SessionStore {
  get(): SessionState;
  listen(listener: (value: SessionState) => void): () => void;
}
// The store behind authClient.useSession(). Route guards read it too, so a guard check
// and the mounted hook share one request instead of fetching the session separately.
const sessionAtom = authClient.$store.atoms.session;
if (!sessionAtom) throw new Error('Better Auth session store is unavailable');
const sessionStore: SessionStore = sessionAtom;
let guardHold: (() => void) | undefined;
let pendingCheck: Promise<Session | null> | undefined;
let checkedIdentity: string | undefined;

export function sessionIdentity(session: Session | null) {
  return session ? JSON.stringify([session.session.id, session.user.id, session.user.name]) : 'signed-out';
}

/** True when route guards already evaluated this identity or are evaluating the current session now. */
export function routeGuardsSaw(identity: string) {
  return pendingCheck !== undefined || checkedIdentity === identity;
}

function settledSession() {
  const current = sessionStore.get();
  if (!current.isPending && !current.isRefetching) return Promise.resolve(current);
  return new Promise<SessionState>(resolve => {
    const stop = sessionStore.listen(value => {
      if (value.isPending || value.isRefetching) return;
      stop();
      resolve(value);
    });
  });
}

async function checkSession() {
  try {
    // Mounting starts the store's refresh manager; its mount fetch joins the refetch below.
    guardHold ??= sessionStore.listen(() => {});
    // Join a request already in flight; a refetch would cancel it after it reached the API.
    if (!sessionStore.get().isRefetching) await sessionStore.get().refetch();
    const { data, error } = await settledSession();
    if (error) throw new Error('Could not check your session. Please try again.');
    checkedIdentity = sessionIdentity(data);
    return data;
  } finally {
    pendingCheck = undefined;
  }
}

/** Guards keep the session store mounted until the session layout subscribes, so mounting it does not refetch. */
export function releaseGuardSessionHold() {
  guardHold?.();
  guardHold = undefined;
}

export function loadSession() {
  return (pendingCheck ??= checkSession());
}
