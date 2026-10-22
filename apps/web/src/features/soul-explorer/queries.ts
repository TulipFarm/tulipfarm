import { useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { featureReadOptions } from '@/lib/query';
import { useFeatureContext } from '@/lib/query/provider';

export function useSoulRead<T>(key: readonly unknown[], load: (signal: AbortSignal) => Promise<T>) {
  const { runtime, scope, current } = useFeatureContext();
  useSyncExternalStore(runtime.subscribeAuthority, runtime.authoritySnapshot, runtime.authoritySnapshot);
  const read = useQuery({
    ...featureReadOptions(runtime, scope, { key: ['soul-explorer', ...key], load, staleTime: Infinity }, current),
    gcTime: 0,
    retry: false,
    refetchOnMount: 'always',
  });
  return { ...read, data: current() && !read.error ? read.data : undefined };
}
