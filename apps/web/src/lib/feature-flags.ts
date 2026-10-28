import { configuredFeatureFlag, type FeatureFlag, type FeatureFlagSnapshot } from '@tulipfarm/config/feature-flags';
import { useSyncExternalStore } from 'react';
import { apiOrigin } from './auth';

// The API evaluates flags for the signed-in user and workspace (GET /v1/feature-flags), once per page
// load for each workspace. A flag changed in the provider shows after the next reload. Until the API
// answers, or when it fails, a flag uses its declared default for this build.
const buildEnv = { NODE_ENV: import.meta.env.PROD ? 'production' : 'development' };
const listeners = new Set<() => void>();
const snapshots = new Map<string, Partial<FeatureFlagSnapshot>>();
const requested = new Set<string>();
let workspace: string | undefined;

const notify = () => {
  for (const listener of listeners) listener();
};

function load(slug: string | undefined) {
  const key = slug ?? '';
  if (requested.has(key) || typeof window === 'undefined') return;
  requested.add(key);
  const url = new URL('/v1/feature-flags', apiOrigin);
  if (slug) url.searchParams.set('workspace', slug);
  void fetch(url, { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(5000) })
    .then(async response => {
      if (!response.ok) {
        if (response.status !== 401) console.warn(`Feature flag evaluation failed (HTTP ${response.status})`);
        return;
      }
      const result = (await response.json()) as Record<string, unknown>;
      snapshots.set(
        key,
        Object.fromEntries(
          Object.entries(result).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
        ),
      );
      notify();
    })
    .catch(error => {
      console.warn(`Feature flag evaluation failed (${error instanceof Error ? error.name : 'UnknownError'})`);
    });
}

/** Evaluates flags in this workspace (by slug) from now on. */
export function setFlagWorkspace(slug: string) {
  if (workspace === slug) return;
  workspace = slug;
  load(slug);
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Child readers subscribe before the workspace page's effect names the workspace, so wait for it.
  queueMicrotask(() => load(workspace));
  return () => {
    listeners.delete(listener);
  };
}

const fallback = (flag: FeatureFlag) => configuredFeatureFlag(flag, buildEnv);

export function useFlag(flag: FeatureFlag) {
  return useSyncExternalStore(
    subscribe,
    () => snapshots.get(workspace ?? '')?.[flag] ?? fallback(flag),
    () => fallback(flag),
  );
}
