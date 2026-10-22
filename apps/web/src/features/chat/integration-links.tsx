import { useEffect, useRef } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@tulipfarm/sprout/button';
import { useIntegrationStatus } from '@/features/integrations/status';
import { integrationKeys } from '@/features/integrations/queries';
import { useFeatureChanges } from '@/lib/query';
import type { ConversationMessage } from './conversation-api';

const destinations = {
  google: { name: 'Google', hash: 'google-workspace' },
  slack: { name: 'Slack', hash: 'slack' },
  github: { name: 'GitHub team issues', hash: 'github-integrations' },
  'github-personal': { name: 'GitHub', hash: 'github-accounts' },
  atlassian: { name: 'Atlassian and Trello', hash: 'atlassian-heading' },
} as const;
type Provider = keyof typeof destinations;

function providerFor(tool: string): Provider | null {
  if (tool.startsWith('google.')) return 'google';
  if (tool.startsWith('slack.')) return 'slack';
  if (tool.startsWith('github.personal.')) return 'github-personal';
  if (tool === 'github.issue.read') return 'github';
  if (tool.startsWith('atlassian.')) return 'atlassian';
  return null;
}

export function IntegrationLinks({
  workspaceId,
  slug,
  chatId,
  messages,
}: {
  workspaceId: string;
  slug: string;
  chatId: string;
  messages: ConversationMessage[];
}) {
  const turn = messages.filter(message => message.turn).at(-1);
  const providers = new Set(
    turn?.tools.flatMap(tool => {
      const provider = providerFor(tool.tool);
      return provider ? [provider] : [];
    }),
  );
  if (!providers.size) return null;
  return (
    <section aria-label="Chat integrations" className="space-y-3">
      {[...providers].map(provider => (
        <IntegrationLink
          key={`${chatId}:${provider}`}
          workspaceId={workspaceId}
          slug={slug}
          chatId={chatId}
          provider={provider}
          revision={JSON.stringify([turn?.id, turn?.tools])}
        />
      ))}
    </section>
  );
}

function IntegrationLink({
  workspaceId,
  slug,
  chatId,
  provider,
  revision,
}: {
  workspaceId: string;
  slug: string;
  chatId: string;
  provider: Provider;
  revision: string | undefined;
}) {
  const { name, hash } = destinations[provider];
  const { statuses, refresh, refreshing } = useIntegrationStatus(workspaceId, provider);
  const { change } = useFeatureChanges();
  const previous = useRef(revision);
  useEffect(() => {
    if (previous.current === revision) return;
    previous.current = revision;
    void change({ keys: [integrationKeys.accounts(provider)] });
  }, [revision, provider, change]);
  const status = statuses[provider];
  const link = (
    <Link
      to="/$workspaceSlug/integrations"
      params={{ workspaceSlug: slug }}
      search={{ returnChat: chatId }}
      hash={hash}
      target="_blank"
      rel="noopener noreferrer"
    />
  );
  if (status.kind === 'loading')
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Checking {name} integration…
      </p>
    );
  if (status.kind === 'error')
    return (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-muted-foreground">
          Could not check the {name} integration.
        </p>
        <Button variant="outline" size="sm" disabled={refreshing} aria-busy={refreshing} onClick={() => void refresh()}>
          Check {name} integration again
        </Button>
      </div>
    );
  if (status.kind === 'connected' && (provider !== 'atlassian' || statuses.trello.kind === 'connected')) return null;
  const label =
    provider === 'atlassian'
      ? 'Review Atlassian and Trello integrations'
      : status.kind === 'off' && status.canConnect
        ? `Connect ${name}`
        : status.kind === 'attention'
          ? `Reconnect ${name}`
          : `Review ${name} integration`;
  return (
    <div className="space-y-1">
      <Button role="link" variant="outline" size="sm" nativeButton={false} render={link}>
        {label}
      </Button>
      <p className="text-sm text-muted-foreground">
        {status.kind === 'off' && !status.canConnect
          ? 'An administrator needs to connect this workspace. '
          : status.kind === 'unavailable'
            ? `${status.detail}. `
            : ''}
        Setup opens in a new tab. After connecting, return here and send your request again.
      </p>
    </div>
  );
}
