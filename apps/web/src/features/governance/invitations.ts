import { useEffect, useSyncExternalStore } from 'react';
import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';
import { invitationListSchema, invitationSchema } from '@tulipfarm/workspaces/governance-contracts';
import { featureKey } from '@/lib/query';
import { useFeatureContext } from '@/lib/query/provider';
import { governancePath, governanceRequest } from '@/lib/governance';
import { requestSignal } from '@/lib/http';
import { governanceKeys } from './queries';

export type Invitation = ReturnType<typeof invitationSchema.parse>;
type Page = ReturnType<typeof invitationListSchema.parse>;
const listKey = [...governanceKeys.invitations, 'list'] as const;

export function useInvitations(workspaceId: string, authorized: boolean, onAccessLost: () => void, search = '') {
  const { runtime, scope, current } = useFeatureContext();
  useSyncExternalStore(runtime.subscribeAuthority, runtime.authoritySnapshot, runtime.authoritySnapshot);
  const normalizedSearch = search.trim().toLowerCase();
  const key = featureKey(scope, normalizedSearch ? [...listKey, { search: normalizedSearch }] : listKey);
  const query = useInfiniteQuery({
    queryKey: key,
    enabled: authorized && current(),
    initialPageParam: null as string | null,
    getNextPageParam: (page: Page) => page.nextCursor,
    queryFn: async ({ signal, pageParam }) => {
      const admitted = runtime.fence(scope, current);
      if (!admitted()) throw new DOMException('Authority changed', 'AbortError');
      const deadline = requestSignal(signal);
      const params = new URLSearchParams();
      if (normalizedSearch) params.set('search', normalizedSearch);
      if (pageParam) params.set('after', pageParam);
      const page = invitationListSchema.parse(
        await governanceRequest(
          `${governancePath(workspaceId)}/invitations${params.size ? `?${params}` : ''}`,
          'GET',
          undefined,
          deadline,
        ),
      );
      deadline.throwIfAborted();
      if (!admitted()) throw new DOMException('Authority changed', 'AbortError');
      return page;
    },
  });
  const denied =
    authorized &&
    query.error !== null &&
    'status' in query.error &&
    [401, 403, 404].includes(Number(query.error.status));
  useEffect(() => {
    if (denied) onAccessLost();
  }, [denied]);
  const data = authorized && current() && !denied ? query.data : undefined;
  return {
    data: data
      ? {
          items: [...new Map(data.pages.flatMap(page => page.items).map(item => [item.id, item])).values()],
          nextCursor: data.pages.at(-1)?.nextCursor ?? null,
        }
      : null,
    error: !!query.error,
    busy: query.isFetching,
    refresh: async (after?: string) => {
      if (!authorized || !current()) return;
      if (after) await query.fetchNextPage({ cancelRefetch: false });
      else await runtime.change(scope, { keys: [governanceKeys.invitations] });
    },
    record: (value: Invitation, predecessor?: Invitation) => {
      if (!current()) return;
      // Parse only the public invitation DTO. Link responses never enter this cache.
      const item = invitationSchema.parse(value);
      void runtime.client.cancelQueries({ queryKey: key, exact: true });
      runtime.client.setQueryData<InfiniteData<Page, string | null>>(key, previous => {
        const pages = previous?.pages ?? [{ items: [], nextCursor: null }];
        const exists = pages.some(page => page.items.some(row => row.id === item.id));
        return {
          pageParams: previous?.pageParams ?? [null],
          pages: pages.map((page, index) => ({
            ...page,
            items: [
              ...(!exists && index === 0 ? [item] : []),
              ...page.items.map(row =>
                row.id === item.id
                  ? item
                  : predecessor && row.id === predecessor.id && predecessor.id !== item.id
                    ? { ...row, status: 'revoked' as const, canCopy: false }
                    : row,
              ),
            ],
          })),
        };
      });
      void runtime.change(scope, { keys: [governanceKeys.invitations] });
    },
  };
}
