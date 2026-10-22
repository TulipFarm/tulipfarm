import { useLayoutEffect } from 'react';
import { hashKey, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { featureKey } from '@/lib/query';
import { useFeatureContext } from '@/lib/query/provider';
import { TableRequestError } from './request-state';
import { tableKeys } from './queries';

export function concealTableQueries(client: QueryClient, keys: readonly QueryKey[], error: Error) {
  for (const queryKey of keys) {
    void client.cancelQueries({ queryKey });
    for (const query of client.getQueryCache().findAll({ queryKey })) {
      query.setState({ data: undefined, dataUpdatedAt: 0, error, status: 'error', fetchStatus: 'idle' });
    }
  }
}

const subscriptions = new WeakMap<QueryClient, Map<string, { users: number; unsubscribe: () => void }>>();

// A denied definition also denies its retained pages, histories and relationship readers.
export function useTableAuthority() {
  const { runtime, scope } = useFeatureContext();
  const prefix = featureKey(scope, tableKeys.all);
  const hash = hashKey(prefix);
  useLayoutEffect(() => {
    let scopes = subscriptions.get(runtime.client);
    if (!scopes) {
      scopes = new Map();
      subscriptions.set(runtime.client, scopes);
    }
    let entry = scopes.get(hash);
    if (!entry) {
      const unsubscribe = runtime.client.getQueryCache().subscribe(event => {
        if (event.type !== 'updated' || event.action.type !== 'error') return;
        const key = event.query.queryKey;
        if (hashKey(key.slice(0, prefix.length)) !== hash) return;
        const error = event.action.error;
        if (!(error instanceof TableRequestError) || ![403, 404].includes(error.status)) return;
        const family = key[prefix.length],
          id = key[prefix.length + 1],
          read = key[prefix.length + 2];
        if (family === 'detail' && typeof id === 'string' && read === 'definition') {
          concealTableQueries(runtime.client, [featureKey(scope, tableKeys.detail(id))], error);
        }
        if (family === 'detail' && typeof id === 'string' && read === 'records') {
          concealTableQueries(
            runtime.client,
            [
              featureKey(scope, tableKeys.records(id)),
              featureKey(scope, [...tableKeys.detail(id), 'record-history']),
              featureKey(scope, [...tableKeys.detail(id), 'deleted']),
            ],
            error,
          );
        }
        if (family === 'proposals') {
          concealTableQueries(runtime.client, [key.slice(0, prefix.length + 3)], error);
        }
      });
      entry = { users: 0, unsubscribe };
      scopes.set(hash, entry);
    }
    entry.users++;
    return () => {
      if (--entry.users === 0) {
        entry.unsubscribe();
        scopes.delete(hash);
      }
    };
  }, [runtime, hash]);
}
