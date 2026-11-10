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
import {
  atlassianErrorMessages,
  atlassianKnowledgeApi,
  atlassianSourceKeys,
} from '@/features/integrations/atlassian-knowledge-api';
import {
  githubKnowledgeApi,
  githubKnowledgeErrorMessages,
  githubSourceKeys,
} from '@/features/integrations/github-knowledge-api';
import {
  googleErrorMessages,
  googleKnowledgeApi,
  googleSourceKeys,
} from '@/features/integrations/google-knowledge-api';
import { slackErrorMessages, slackKnowledgeApi, slackSourceKeys } from '@/features/integrations/slack-knowledge-api';
import { CommandFeedback, useCommand } from '@/features/integrations/slack-knowledge-shared';
import { useFeatureChanges, useFeatureRead } from '@/lib/query';
import { workspaceRoute } from '@/router';
import { knowledgeApi, personalKnowledgeRead } from '@/features/files/knowledge-api';
import { KnowledgeLibrary } from '@/features/files/knowledge-library';
import { ReadResult } from '@/features/integrations/slack-knowledge-shared';

const units: Record<DefaultKnowledgeProduct, [string, string]> = {
  'google-drive': ['drive', 'drives'],
  gmail: ['mailbox', 'mailboxes'],
  slack: ['channel', 'channels'],
  github: ['repository', 'repositories'],
  jira: ['project', 'projects'],
  confluence: ['space', 'spaces'],
};

type Status = KnowledgeBaseSource['status'];
type Part = {
  product: DefaultKnowledgeProduct;
  account: string | null;
  scope: number | 'all';
  status: Status;
  ready: number;
  total: number;
  error: string | null;
  intentId?: string;
  manual?: { provider: Provider; sourceId: string };
};
type Source = KnowledgeBaseSource & { product: DefaultKnowledgeProduct; parts: Part[] };
type Action = 'pause' | 'resume' | 'retry';
type Provider = 'github' | 'google' | 'slack' | 'atlassian';
type Manual = {
  sourceId: string;
  state: 'active' | 'paused' | 'disconnected' | 'removed';
  syncState: 'queued' | 'syncing' | 'ready' | 'failed';
  failure: string | null;
  counts: { total: number; ready: number; failed: number } | null;
};
const providers: Record<Provider, { name: string; keys: string[]; messages: Record<string, string> }> = {
  github: { name: 'GitHub', keys: githubSourceKeys, messages: githubKnowledgeErrorMessages },
  google: { name: 'Google', keys: googleSourceKeys, messages: googleErrorMessages },
  slack: { name: 'Slack', keys: slackSourceKeys, messages: slackErrorMessages },
  atlassian: { name: 'Atlassian', keys: atlassianSourceKeys, messages: atlassianErrorMessages },
};
type Work = {
  intents: { intentId: string; action: DefaultKnowledgeAction }[];
  manual: { provider: Provider; sourceId: string; action: Action }[];
};

const worst: Status[] = ['error', 'syncing', 'queued', 'paused', 'connected'];

function status(intent: DefaultKnowledgeIntent, failed: boolean): Status {
  if (intent.state === 'opted-out') return 'paused';
  if (failed) return 'error';
  if (intent.syncState === 'queued' && intent.counts.total === 0) return 'queued';
  return indexing(intent) ? 'syncing' : 'connected';
}

function fromIntent(intent: DefaultKnowledgeIntent): Part {
  const disclosure = disclosures[intent.product];
  const issue = intent.state === 'active' ? problem(intent, disclosure.name, disclosure.scopes) : null;
  const value = status(intent, issue !== null);
  return {
    product: intent.product,
    account: intent.accountLabel,
    // GitHub's automatic source always covers every repository, so its single scope is not a repository count.
    scope: intent.product === 'github' ? 'all' : intent.scopes.included,
    status: value,
    ready: intent.counts.ready,
    total: Math.max(
      intent.counts.total,
      intent.counts.ready +
        intent.counts.queued +
        intent.counts.failed +
        intent.counts.skipped +
        intent.counts.quotaLimited,
    ),
    error: issue && value === 'error' ? issue.message : null,
    intentId: intent.intentId,
  };
}

function fromManual(provider: Provider, product: DefaultKnowledgeProduct, scope: number, source: Manual): Part {
  const value: Status =
    source.state === 'paused'
      ? 'paused'
      : source.state === 'disconnected' || source.syncState === 'failed'
        ? 'error'
        : source.syncState === 'ready'
          ? 'connected'
          : source.syncState;
  const { name, messages } = providers[provider];
  return {
    product,
    account: null,
    scope,
    status: value,
    ready: source.counts?.ready ?? 0,
    total: source.counts?.total ?? 0,
    error:
      value === 'error'
        ? (messages[source.failure ?? ''] ?? `${name} stopped syncing. Open Settings to fix it.`)
        : null,
    manual: { provider, sourceId: source.sourceId },
  };
}

function row(product: DefaultKnowledgeProduct, parts: Part[]): Source {
  const app = integrations.find(item => item.id === product);
  const disclosure = disclosures[product];
  const base = { id: product, product, name: disclosure.name, ...(app ? { brand: app.brand } : {}), parts };
  if (!parts.length) return { ...base, detail: disclosure.scope, status: 'available' };
  const value = worst.find(state => parts.some(part => part.status === state)) ?? 'connected';
  const live = parts.filter(part => part.status !== 'paused');
  const counted = live.length ? live : parts;
  const included = counted.some(part => part.scope === 'all')
    ? 'all'
    : counted.reduce((sum, part) => sum + (part.scope as number), 0);
  const scope =
    included === 'all' ? `all ${units[product][1]}` : `${included} ${units[product][included === 1 ? 0 : 1]}`;
  const accounts = [...new Set(parts.flatMap(part => (part.account ? [part.account] : [])))].join(', ');
  const ready = parts.reduce((sum, part) => sum + part.ready, 0);
  const total = parts.reduce((sum, part) => sum + part.total, 0);
  const error = parts.find(part => part.error)?.error;
  return {
    ...base,
    detail: accounts ? `${accounts} · ${scope}` : scope,
    status: value,
    progress: value === 'syncing' || value === 'error' ? (total ? Math.floor((ready / total) * 100) : 0) : null,
    chunks: ready,
    ...(error && value === 'error' ? { error } : {}),
  };
}

type Lists = {
  github: Awaited<ReturnType<ReturnType<typeof githubKnowledgeApi>['list']>>['items'];
  google: Awaited<ReturnType<ReturnType<typeof googleKnowledgeApi>['list']>>['items'];
  slack: Awaited<ReturnType<ReturnType<typeof slackKnowledgeApi>['list']>>['items'];
  atlassian: Awaited<ReturnType<ReturnType<typeof atlassianKnowledgeApi>['list']>>['items'];
};

function sourcesOf(items: readonly DefaultKnowledgeIntent[], lists: Lists): Source[] {
  const automatic = new Set(items.flatMap(item => item.sources.map(source => source.sourceId)));
  const added = <T extends Manual>(list: T[]) =>
    list.filter(source => source.state !== 'removed' && !automatic.has(source.sourceId));
  const parts = [
    ...items.map(fromIntent),
    ...added(lists.github).map(source => fromManual('github', 'github', source.repositories?.length ?? 0, source)),
    ...added(lists.google).map(source =>
      fromManual('google', source.selection?.kind === 'gmail' ? 'gmail' : 'google-drive', 1, source),
    ),
    ...added(lists.slack).map(source =>
      fromManual(
        'slack',
        'slack',
        source.conversations?.length ?? source.selection?.conversationIds.length ?? 0,
        source,
      ),
    ),
    ...added(lists.atlassian).map(source =>
      fromManual('atlassian', source.product, source.targets?.length ?? 0, source),
    ),
  ];
  const rows = defaultKnowledgeProducts.map(product =>
    row(
      product,
      parts.filter(part => part.product === product),
    ),
  );
  return [...rows.filter(item => item.status !== 'available'), ...rows.filter(item => item.status === 'available')];
}

// Each action only touches the sources it applies to, so resuming a row leaves its running sources alone.
function workFor(source: Source, action: Action): Work {
  const parts = source.parts.filter(part =>
    action === 'pause'
      ? part.status !== 'paused'
      : action === 'resume'
        ? part.status === 'paused'
        : part.status === 'error',
  );
  const intentAction = ({ pause: 'opt-out', resume: 'resume', retry: 'retry' } as const)[action];
  return {
    intents: parts.flatMap(part => (part.intentId ? [{ intentId: part.intentId, action: intentAction }] : [])),
    manual: parts.flatMap(part => (part.manual ? [{ ...part.manual, action }] : [])),
  };
}

const emptyList: never[] = [];

// A product the member never connected answers with an error; its row just has no hand-picked sources.
function useManual<T extends Manual>(keys: string[], load: (signal: AbortSignal) => Promise<{ items: T[] }>): T[] {
  const read = useFeatureRead({
    key: [...keys, 'list'],
    load,
    staleTime: 0,
    pollWhile: data =>
      data.items.some(source => source.state === 'active' && ['queued', 'syncing'].includes(source.syncState)),
    maxChecks: 15,
  });
  return read.state.kind === 'ready' ? read.state.data.items : emptyList;
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
  const apis = useMemo(
    () => ({
      github: githubKnowledgeApi(workspaceId),
      google: googleKnowledgeApi(workspaceId),
      slack: slackKnowledgeApi(workspaceId),
      atlassian: atlassianKnowledgeApi(workspaceId),
    }),
    [workspaceId],
  );
  const { change } = useFeatureChanges();
  const github = useManual(githubSourceKeys, apis.github.list);
  const google = useManual(googleSourceKeys, apis.google.list);
  const slack = useManual(slackSourceKeys, apis.slack.list);
  const atlassian = useManual(atlassianSourceKeys, apis.atlassian.list);
  const listKeys = Object.values(providers).map(provider => [...provider.keys, 'list']);
  const command = useCommand(
    (work: Work, signal: AbortSignal) =>
      Promise.all([
        ...work.intents.map(({ intentId, action }) => api.manage(intentId, action, signal)),
        ...work.manual.map(({ provider, sourceId, action }) =>
          apis[provider].manage(sourceId, { commandId: crypto.randomUUID(), action }, signal),
        ),
      ]),
    () => change({ keys: [defaultKnowledgeKeys, ...listKeys] }),
    [defaultKnowledgeKeys, ...listKeys],
  );
  const sources = useMemo(
    () => sourcesOf(items, { github, google, slack, atlassian }),
    [items, github, google, slack, atlassian],
  );
  const manage = (action: Action) => (source: KnowledgeBaseSource) => {
    const work = workFor(source as Source, action);
    if (!command.locked && (work.intents.length || work.manual.length)) void command.send(work);
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
        {sources.some(source => (source.chunks ?? 0) > 0) && (
          <KnowledgeBaseDiagram>
            <KnowledgeBaseActivity />
          </KnowledgeBaseDiagram>
        )}
        {sources.some(source => (source.chunks ?? 0) > 0) && (
          <KnowledgeBaseSummary>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void navigate({ to: '/$workspaceSlug/integrations', params: { workspaceSlug: slug } })}
            >
              Manage integrations
            </Button>
          </KnowledgeBaseSummary>
        )}
        <KnowledgeBaseSources
          onConnect={open}
          onSettings={open}
          onRetry={manage('retry')}
          onPauseSync={manage('pause')}
          onResumeSync={manage('resume')}
        />
      </KnowledgeBase>
    </div>
  );
}

export default function KnowledgePage() {
  const { workspace } = workspaceRoute.useRouteContext();
  const { enabled, read } = useDefaultKnowledge(workspace.id);
  const api = useMemo(() => knowledgeApi(workspace.id), [workspace.id]);
  const entries = useFeatureRead(personalKnowledgeRead(api));
  return (
    <PageContent>
      <PageHeader title="Knowledge" description="Your notes, files, and connected sources." />
      <ReadResult state={entries.state} label="your Knowledge" retry={entries.refresh}>
        {items => (
          <KnowledgeLibrary
            workspaceId={workspace.id}
            slug={workspace.slug}
            entries={items}
            refresh={entries.refresh}
            delayed={entries.delayed}
            restart={entries.restart}
          />
        )}
      </ReadResult>
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
