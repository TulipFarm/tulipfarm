import { useEffect } from 'react';
import { hashKey, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { featureKey, useFeatureChanges, useFeatureScope } from '@/lib/query';
import { tableKeys, type ProposalIdentity } from './queries';
import { useFeatureContext } from '@/lib/query/provider';
import type { ProposalView } from './review-contracts';
import { concealTableQueries } from './authority';
import { TableRequestError } from './request-state';

export const tableChangeKeys = {
  records: (tableId: string) => [
    tableKeys.detail(tableId),
    tableKeys.lists,
    tableKeys.picker,
    tableKeys.linked,
    tableKeys.proposals,
  ],
  definition: (tableId: string) => [
    tableKeys.detail(tableId),
    tableKeys.lists,
    tableKeys.picker,
    tableKeys.linked,
    ['tables', 'authoring-context'],
    tableKeys.proposals,
  ],
  proposal: (identity: ProposalIdentity) => [tableKeys.proposal(identity)],
  proposalResult: (identity: ProposalIdentity, result: Pick<ProposalView, 'plans'>) => [
    tableKeys.proposal(identity),
    ...result.plans.filter(plan => plan.receipt !== null).flatMap(plan => tableChangeKeys.definition(plan.tableId)),
  ],
};

export function useTableChanges() {
  const { change } = useFeatureChanges();
  const { runtime, scope, current } = useFeatureContext();
  return {
    records: (tableId: string) => change({ keys: tableChangeKeys.records(tableId) }),
    definition: (tableId: string) => change({ keys: tableChangeKeys.definition(tableId) }),
    proposal: (identity: ProposalIdentity) => change({ keys: tableChangeKeys.proposal(identity) }),
    proposalResult: (identity: ProposalIdentity, result: Pick<ProposalView, 'plans'>) =>
      change({ keys: tableChangeKeys.proposalResult(identity, result) }),
    denied: (error: unknown, keys: readonly (readonly unknown[])[]) => {
      if (!current() || !(error instanceof TableRequestError)) return;
      if (error.status === 401) runtime.revoke({ kind: 'account', userId: scope.userId }, true);
      if ([403, 404].includes(error.status))
        concealTableQueries(
          runtime.client,
          keys.map(key => featureKey(scope, key)),
          error,
        );
    },
    grants: async (membershipId: string) => {
      if (!current() || scope.kind !== 'workspace') return;
      if (scope.membershipId === membershipId) runtime.revoke(scope, true);
      else await change({ keys: [tableKeys.grants, tableKeys.proposals] });
    },
  };
}

// Share transition observations across duplicate readers and remounts in one client.
// This stores fingerprints only; response data belongs exclusively to Query.
const observations = new WeakMap<QueryClient, Map<string, string>>();
export function useTableTransition(
  identity: readonly unknown[],
  fingerprint: string | null,
  tableIds: readonly string[],
  initialChange = false,
) {
  const client = useQueryClient();
  const scope = useFeatureScope();
  const { change } = useFeatureChanges();
  const key = hashKey(featureKey(scope, identity));
  const ids = JSON.stringify(tableIds);
  useEffect(() => {
    if (fingerprint === null) return;
    let seen = observations.get(client);
    if (!seen) {
      seen = new Map();
      observations.set(client, seen);
    }
    const prior = seen.get(key);
    seen.set(key, fingerprint);
    if (prior === fingerprint || (prior === undefined && !initialChange)) return;
    void change({ keys: tableIds.flatMap(id => tableChangeKeys.definition(id)) });
  }, [client, key, fingerprint, ids, initialChange, change]);
}
