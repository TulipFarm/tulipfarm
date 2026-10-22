import { useNavigate } from '@tanstack/react-router';
import { BrandIcon } from '@tulipfarm/sprout/brand-icon';
import type { RichTextKeyword } from '@tulipfarm/sprout/rich-text-editor';
import { integrations } from './catalog';
import { statusOf, useIntegrationStatus, type Status } from './status';

// Loading and failed reads stay neutral, so a chip only says "disconnected" when that is known.
const disconnected = new Set<Status['kind']>(['off', 'attention', 'unavailable']);

/** Integration names typed in a message show as chips with the app's logo and whether it is connected. */
export function useIntegrationKeywords(workspaceId: string, workspaceSlug: string, returnChat?: string) {
  const navigate = useNavigate();
  const { statuses } = useIntegrationStatus(workspaceId);
  const keywords: RichTextKeyword[] = integrations.flatMap(app => {
    const status = statusOf(statuses, app);
    if (!status) return [];
    return [
      {
        id: app.id,
        label: app.name,
        icon: <BrandIcon brand={app.brand} size="inline" />,
        connected: !disconnected.has(status.kind),
        account: status.kind === 'connected' ? (status.detail ?? undefined) : undefined,
      },
    ];
  });
  const connect = (keyword: RichTextKeyword) =>
    void navigate({
      to: '/$workspaceSlug/integrations',
      params: { workspaceSlug },
      search: { returnChat },
      hash: keyword.id,
    });
  return { keywords, connect };
}
