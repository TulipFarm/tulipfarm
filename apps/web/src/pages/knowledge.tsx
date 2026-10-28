import { useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Button } from '@tulipfarm/sprout/button';
import {
  KnowledgeBase,
  KnowledgeBaseActivity,
  KnowledgeBaseDiagram,
  KnowledgeBaseHeader,
  KnowledgeBaseSources,
  KnowledgeBaseSummary,
  type KnowledgeBaseSource,
} from '@tulipfarm/sprout/knowledge-base';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { defaultKnowledgeProducts } from '@tulipfarm/knowledge/default-contracts';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { ReadFeedback, ReadError } from '@/components/read-feedback';
import { integrations } from '@/features/integrations/catalog';
import {
  defaultKnowledgeApi,
  defaultKnowledgeKeys,
  type DefaultKnowledgeAction,
  type DefaultKnowledgeIntent,
  type DefaultKnowledgeProduct,
} from '@/features/integrations/default-knowledge-api';
import { disclosures, indexing, problem, useDefaultKnowledge } from '@/features/integrations/default-knowledge';
import { searchablePercent } from '@/features/integrations/knowledge-meter';
import { CommandFeedback, useCommand } from '@/features/integrations/slack-knowledge-shared';
import { useFeatureChanges } from '@/lib/query';
import { workspaceRoute } from '@/router';

const units: Record<DefaultKnowledgeProduct, [string, string]> = {
  'google-drive': ['drive', 'drives'],
  gmail: ['mailbox', 'mailboxes'],
  slack: ['channel', 'channels'],
  github: ['repository', 'repositories'],
  jira: ['project', 'projects'],
  confluence: ['space', 'spaces'],
};

type Source = KnowledgeBaseSource & { product: DefaultKnowledgeProduct; intentId?: string };

function status(intent: DefaultKnowledgeIntent, failed: boolean): KnowledgeBaseSource['status'] {
  if (intent.state === 'opted-out') return 'paused';
  if (failed) return 'error';
  if (intent.syncState === 'queued' && intent.counts.total === 0) return 'queued';
  return indexing(intent) ? 'syncing' : 'connected';
}

function toSource(intent: DefaultKnowledgeIntent): Source {
  const app = integrations.find(item => item.id === intent.product);
  const disclosure = disclosures[intent.product];
  const issue = intent.state === 'active' ? problem(intent, disclosure.name, disclosure.scopes) : null;
  const included = intent.scopes.included;
  const value = status(intent, issue !== null);
  return {
    id: intent.intentId,
    intentId: intent.intentId,
    product: intent.product,
    name: disclosure.name,
    ...(app ? { brand: app.brand } : {}),
    detail: `${intent.accountLabel} · ${included} ${units[intent.product][included === 1 ? 0 : 1]}`,
    status: value,
    progress: value === 'syncing' || value === 'error' ? searchablePercent(intent.counts) : null,
    chunks: intent.counts.ready,
    ...(issue && value === 'error' ? { error: issue.message } : {}),
  };
}

function available(product: DefaultKnowledgeProduct): Source {
  const app = integrations.find(item => item.id === product);
  return {
    id: `available-${product}`,
    product,
    name: disclosures[product].name,
    ...(app ? { brand: app.brand } : {}),
    detail: disclosures[product].scope,
    status: 'available',
  };
}

export function sourcesOf(items: readonly DefaultKnowledgeIntent[]): Source[] {
  const connected = items.map(toSource);
  const missing = defaultKnowledgeProducts.filter(product => !items.some(item => item.product === product));
  return [...connected, ...missing.map(available)];
}

function KnowledgePanel({
  workspaceId,
  slug,
  items,
}: {
  workspaceId: string;
  slug: string;
  items: DefaultKnowledgeIntent[];
}) {
  const navigate = useNavigate();
  const api = useMemo(() => defaultKnowledgeApi(workspaceId), [workspaceId]);
  const { change } = useFeatureChanges();
  const command = useCommand(
    ({ intentId, action }: { intentId: string; action: DefaultKnowledgeAction }, signal: AbortSignal) =>
      api.manage(intentId, action, signal),
    () => change({ keys: [defaultKnowledgeKeys] }),
    [defaultKnowledgeKeys],
  );
  const sources = useMemo(() => sourcesOf(items), [items]);
  const manage = (action: DefaultKnowledgeAction) => (source: KnowledgeBaseSource) => {
    const intentId = (source as Source).intentId;
    if (intentId && !command.locked) void command.send({ intentId, action });
  };
  const open = (source: KnowledgeBaseSource) =>
    void navigate({
      to: '/$workspaceSlug/integrations/$integrationId',
      params: { workspaceSlug: slug, integrationId: (source as Source).product },
      search: { tab: 'knowledge' },
    });
  return (
    <div className="space-y-4">
      <CommandFeedback state={command.state} retry={command.retry} />
      <KnowledgeBase sources={sources}>
        <KnowledgeBaseHeader subtitle="Your automatic Knowledge" />
        <KnowledgeBaseDiagram>
          <KnowledgeBaseActivity />
        </KnowledgeBaseDiagram>
        <KnowledgeBaseSummary>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void navigate({ to: '/$workspaceSlug/integrations', params: { workspaceSlug: slug } })}
          >
            Manage integrations
          </Button>
        </KnowledgeBaseSummary>
        <KnowledgeBaseSources
          onConnect={open}
          onSettings={open}
          onRetry={manage('retry')}
          onPauseSync={manage('opt-out')}
          onResumeSync={manage('resume')}
        />
      </KnowledgeBase>
    </div>
  );
}

export default function KnowledgePage() {
  const { workspace } = workspaceRoute.useRouteContext();
  const { enabled, read } = useDefaultKnowledge(workspace.id);
  return (
    <PageContent>
      <PageHeader
        title="Knowledge"
        description="What TulipFarm reads from your connected apps, and how each source is syncing."
      />
      {!enabled ? (
        <StatePanel
          kind="empty"
          title="Automatic Knowledge is off"
          description="Connect sources from each integration's Knowledge tab."
        />
      ) : (
        <ReadFeedback
          state={read.state}
          loading={
            <div role="status" aria-label="Loading Knowledge" className="space-y-4 py-2">
              <Skeleton />
              <Skeleton />
              <Skeleton />
              <span className="sr-only">Loading Knowledge…</span>
            </div>
          }
          unavailable={() => (
            <StatePanel kind="error" title="Knowledge is unavailable" description="You can't view Knowledge here.">
              {null}
            </StatePanel>
          )}
          errorTitle="Could not load Knowledge"
          retry={
            <Button variant="outline" onClick={() => void read.refresh()}>
              Try again
            </Button>
          }
          refreshError={message => <ReadError message={message} />}
          refreshing="Refreshing Knowledge…"
        >
          {data => <KnowledgePanel workspaceId={workspace.id} slug={workspace.slug} items={data.items} />}
        </ReadFeedback>
      )}
    </PageContent>
  );
}
