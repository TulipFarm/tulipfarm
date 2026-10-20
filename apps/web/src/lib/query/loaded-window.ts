import { useRef } from 'react';
import type { QueryKey } from '@tanstack/react-query';
import type { ReadState } from '../../features/tables/request-state';
import { useFeatureContext, useFeatureScope } from './provider';
import { featureKey } from './scope';

/** Keeps a prior result on screen while the same collection refreshes, loads another page, or changes filters. */
export function useLoadedWindow<T>(state: ReadState<T>, identity: string, pages: number, key: QueryKey): ReadState<T> {
  const scope = useFeatureScope();
  const { runtime } = useFeatureContext();
  identity = JSON.stringify([scope, identity]);
  const previous = useRef<{
    identity: string;
    pages: number;
    key: QueryKey;
    state: Extract<ReadState<T>, { kind: 'ready' }>;
  } | null>(null);
  if (
    state.kind === 'unavailable' ||
    previous.current?.identity !== identity ||
    runtime.client.getQueryData(featureKey(scope, previous.current.key)) === undefined
  )
    previous.current = null;
  if (state.kind === 'ready') previous.current = { identity, pages, key, state };
  const retained = previous.current;
  if (retained && (state.kind === 'loading' || state.kind === 'error')) {
    return {
      kind: 'ready',
      data: retained.state.data,
      refreshing: state.kind === 'loading',
      error: state.kind === 'error' ? state.message : null,
    };
  }
  return state;
}
