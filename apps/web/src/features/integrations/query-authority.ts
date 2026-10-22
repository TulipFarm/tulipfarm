import { useEffect } from 'react';
import { hashKey, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { featureKey, useFeatureRead } from '@/lib/query';
import { useFeatureContext } from '@/lib/query/provider';

const subscriptions = new WeakMap<QueryClient, Set<string>>();

export function concealQueries(client: QueryClient, keys: readonly QueryKey[]) {
  const queries = new Set(keys.flatMap(queryKey => client.getQueryCache().findAll({ queryKey })));
  for (const query of queries) {
    void client.cancelQueries({ queryKey: query.queryKey, exact: true });
    query.setState({ data: undefined, dataUpdatedAt: 0, error: null, status: 'pending' });
  }
}

// One subscription per authority family, even when several panels share its reads.
export function useProviderAuthority(
  marker: QueryKey,
  authorities: readonly QueryKey[],
  dependents: readonly QueryKey[],
  binding: (data: unknown) => unknown = data => data,
) {
  useFeatureRead({ key: marker, load: async () => null, staleTime: Infinity });
  const { runtime, scope } = useFeatureContext();
  const identity = hashKey(featureKey(scope, marker));
  useEffect(() => {
    const client = runtime.client;
    let registered = subscriptions.get(client);
    if (!registered) {
      registered = new Set();
      subscriptions.set(client, registered);
    }
    if (!registered.has(identity)) {
      const keys = new Set([marker, ...authorities].map(key => hashKey(featureKey(scope, key))));
      const bindings = new Map<string, string>();
      const denials = new Set<string>();
      for (const query of client.getQueryCache().getAll()) {
        if (keys.has(query.queryHash) && query.state.data !== undefined)
          bindings.set(query.queryHash, JSON.stringify(binding(query.state.data)));
      }
      const stop = client.getQueryCache().subscribe(event => {
        if (event.type === 'removed' && event.query.queryHash === identity) {
          stop();
          registered.delete(identity);
          return;
        }
        if (event.type !== 'updated' || !keys.has(event.query.queryHash)) return;
        const before = bindings.get(event.query.queryHash);
        const after = JSON.stringify(binding(event.query.state.data));
        const markerChanged = event.action.type === 'invalidate' && event.query.queryHash === identity;
        if (markerChanged) {
          bindings.clear();
          denials.clear();
        }
        if (event.action.type === 'success') {
          bindings.set(event.query.queryHash, after);
          denials.delete(event.query.queryHash);
        }
        const changed = event.action.type === 'success' && before !== undefined && before !== after;
        const error = event.query.state.error;
        const denied =
          event.action.type === 'error' &&
          error !== null &&
          typeof error === 'object' &&
          'status' in error &&
          [401, 403, 404].includes(Number(error.status));
        if (denied) {
          if (denials.has(event.query.queryHash)) return;
          denials.add(event.query.queryHash);
        }
        if (!markerChanged && !changed && !denied) return;
        // Cache observations are local. Only confirmed feature changes broadcast.
        void runtime.applyChange(scope, { kind: 'conceal', keys: dependents });
      });
      registered.add(identity);
    }
    // Inactive protected queries still need cross-tab concealment until cache removal.
  }, [runtime, scope, identity]);
}
