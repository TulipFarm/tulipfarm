import { configuredFeatureFlag, type FeatureFlag, type FeatureFlagSnapshot } from '@tulipfarm/config/feature-flags';
import { useSyncExternalStore } from 'react';
import { apiOrigin, authClient } from './auth';

// The API evaluates flags for the signed-in user and workspace (GET /v1/feature-flags).
// Until it answers, or when it fails, a flag uses its declared default for this build.
const buildEnv = { NODE_ENV: import.meta.env.PROD ? 'production' : 'development' };
const listeners = new Set<() => void>();
let flags: Partial<FeatureFlagSnapshot> = {};
let user: string | undefined;
let workspace: string | undefined;
let context = '';
let request: Promise<void> | undefined;
let controller: AbortController | undefined;
let started = false;

const notify = () => {
  for (const listener of listeners) listener();
};

export function refreshFlags() {
  if (!user) return Promise.resolve();
  const next = `${user}\n${workspace ?? ''}`;
  if (request && context === next) return request;
  if (context !== next) {
    controller?.abort();
    flags = {};
    notify();
  }
  context = next;
  const current = new AbortController();
  controller = current;
  const url = new URL('/v1/feature-flags', apiOrigin);
  if (workspace) url.searchParams.set('workspace', workspace);
  request = fetch(url, {
    credentials: 'include',
    cache: 'no-store',
    signal: AbortSignal.any([current.signal, AbortSignal.timeout(5000)]),
  })
    .then(async response => {
      if (!response.ok) {
        console.warn(`Feature flag evaluation failed (HTTP ${response.status})`);
        return;
      }
      const result = (await response.json()) as Record<string, unknown>;
      if (current.signal.aborted || context !== next) return;
      flags = Object.fromEntries(
        Object.entries(result).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
      );
      notify();
    })
    .catch(error => {
      if (!current.signal.aborted)
        console.warn(`Feature flag evaluation failed (${error instanceof Error ? error.name : 'UnknownError'})`);
    })
    .finally(() => {
      if (controller === current) request = undefined;
    });
  return request;
}

function start() {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.addEventListener('focus', () => {
    void refreshFlags();
  });
  authClient.$store.atoms.session?.subscribe(({ data, isPending }) => {
    if (isPending) return;
    const next = data?.user.id;
    if (user && next !== user) workspace = undefined;
    user = next;
    if (!user) {
      controller?.abort();
      context = '';
      flags = {};
      notify();
      return;
    }
    void refreshFlags();
  });
}

/** Evaluates flags in this workspace (by slug) from now on. */
export function setFlagWorkspace(slug: string) {
  start();
  if (workspace === slug) return;
  workspace = slug;
  void refreshFlags();
}

function subscribe(listener: () => void) {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const fallback = (flag: FeatureFlag) => configuredFeatureFlag(flag, buildEnv);

export function useFlag(flag: FeatureFlag) {
  return useSyncExternalStore(
    subscribe,
    () => flags[flag] ?? fallback(flag),
    () => fallback(flag),
  );
}
