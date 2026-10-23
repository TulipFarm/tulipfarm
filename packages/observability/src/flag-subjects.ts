import type { FeatureFlagScope } from '@tulipfarm/config/feature-flags';
import type { FlagSubject, FlagUserContext, FlagWorkspaceContext } from '@tulipfarm/extensions';

export type FlagUserInput = { readonly id: string; readonly email?: string | undefined };
export type FlagWorkspaceInput = {
  readonly id: string;
  readonly slug?: string | undefined;
  readonly name?: string | undefined;
  readonly createdAt?: string | undefined;
};

export type ResolvedFlagContext = {
  readonly user?: { readonly email?: string | undefined };
  readonly workspace?: {
    readonly slug?: string | undefined;
    readonly name?: string | undefined;
    readonly createdAt?: string | undefined;
  };
};

/**
 * Reads trusted targeting attributes from the app's own stores. It receives the user only when
 * the flag's scope uses one, and real (UUID) IDs only. A user's email is returned only when it may
 * be read in that context; a missing record returns nothing.
 */
export type FlagSubjectResolver = (lookup: {
  readonly userId?: string;
  readonly workspaceId?: string;
}) => Promise<ResolvedFlagContext>;

const ttlMs = 60_000;
const maxEntries = 1000;
const timeoutMs = 1000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Entry = { readonly expires: number; readonly value: Promise<ResolvedFlagContext> };
type State = { resolver?: FlagSubjectResolver; cache: Map<string, Entry> };
// Shared through globalThis so duplicate copies of this package still see one resolver.
const key = Symbol.for('tulipfarm.flag-subjects');
const holder = globalThis as { [key]?: State };
const state = (): State => (holder[key] ??= { cache: new Map() });

/** Registers the process's subject resolver. The api and worker call this at startup, before serving work. */
export function registerFlagSubjectResolver(resolver: FlagSubjectResolver) {
  const current = state();
  current.resolver = resolver;
  current.cache.clear();
}

/** Removes the resolver and its cache. For shutdown and tests. */
export function resetFlagSubjects() {
  holder[key] = { cache: new Map() };
}

function lookup(userId: string | undefined, workspaceId: string | undefined, onError: (error: unknown) => void) {
  const current = state();
  const resolver = current.resolver;
  const user = userId && uuid.test(userId) ? userId.toLowerCase() : undefined;
  const workspace = workspaceId && uuid.test(workspaceId) ? workspaceId.toLowerCase() : undefined;
  if (!resolver || (!user && !workspace)) return Promise.resolve<ResolvedFlagContext>({});
  const cacheKey = `${user ?? ''}|${workspace ?? ''}`;
  const now = Date.now();
  const hit = current.cache.get(cacheKey);
  if (hit && hit.expires > now) {
    current.cache.delete(cacheKey);
    current.cache.set(cacheKey, hit);
    return hit.value;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const value = Promise.race([
    resolver({ ...(user ? { userId: user } : {}), ...(workspace ? { workspaceId: workspace } : {}) }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Flag subject lookup timed out')), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
  const entry = { expires: now + ttlMs, value };
  current.cache.delete(cacheKey);
  current.cache.set(cacheKey, entry);
  while (current.cache.size > maxEntries) current.cache.delete(current.cache.keys().next().value!);
  return value.catch((error): ResolvedFlagContext => {
    // Only successful lookups stay cached.
    if (current.cache.get(cacheKey) === entry) current.cache.delete(cacheKey);
    onError(error);
    return {};
  });
}

const defined = <T extends object>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== '')) as T;

export function emailDomain(email: string | undefined) {
  const at = email?.lastIndexOf('@') ?? -1;
  const domain =
    at > 0
      ? email!
          .slice(at + 1)
          .trim()
          .toLowerCase()
      : '';
  return domain || undefined;
}

export type FlagContext = { readonly user?: FlagUserContext; readonly workspace?: FlagWorkspaceContext };

/**
 * The caller's user and workspace with missing attributes filled from the resolver. Values the
 * caller passes win; `emailDomain` follows the final email.
 */
export async function resolveFlagContext(
  user: FlagUserInput | undefined,
  workspace: FlagWorkspaceInput | undefined,
  onError: (error: unknown) => void,
): Promise<FlagContext> {
  const resolved = await lookup(user?.id, workspace?.id, onError);
  const email = user?.email || resolved.user?.email || undefined;
  return {
    ...(user && {
      user: defined({ id: user.id, email, emailDomain: emailDomain(email) }) as FlagUserContext,
    }),
    ...(workspace && {
      workspace: defined({ ...resolved.workspace, ...defined(workspace) }) as FlagWorkspaceContext,
    }),
  };
}

/** The provider subject for a scope, or undefined when the scope's required entity is missing. */
export function flagSubject(scope: FeatureFlagScope, context: FlagContext): FlagSubject | undefined {
  if (scope === 'global') return { scope, distinctId: 'global' };
  if (scope === 'workspace')
    return context.workspace
      ? { scope, distinctId: `workspace:${context.workspace.id}`, workspace: context.workspace }
      : undefined;
  return context.user
    ? {
        scope,
        distinctId: context.user.id,
        user: context.user,
        ...(context.workspace && { workspace: context.workspace }),
      }
    : undefined;
}
