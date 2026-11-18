import { usageReportSchema } from '@tulipfarm/workspace-storage/model-usage-contracts';
import { useFeatureRead } from '@/lib/query';
import { settingsRequest } from '@/features/settings/api';
import type { ReportQuery } from './usage-model.ts';

// Under the credit keys, so anything that reports spending credits also refreshes the explorer.
const usageKeys = { report: (query: ReportQuery) => ['credits', 'usage', query] as const };

export function useUsageReport(workspaceId: string, query: ReportQuery) {
  return useFeatureRead({
    key: usageKeys.report(query),
    load: async signal => {
      const search = new URLSearchParams({
        from: query.from,
        to: query.to,
        group: query.group.join(','),
        tz: query.timeZone,
      });
      if (Object.keys(query.filters).length) search.set('filters', JSON.stringify(query.filters));
      return usageReportSchema.parse(
        await settingsRequest(`/workspaces/${encodeURIComponent(workspaceId)}/usage?${search}`, signal),
      );
    },
  });
}
