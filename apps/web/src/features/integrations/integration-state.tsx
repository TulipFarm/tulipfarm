import { CheckIcon } from 'lucide-react';
import { Badge } from '@tulipfarm/sprout/badge';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { googleAppScopes } from '@tulipfarm/google-workspace/public-contracts';
import { integrations, type Integration, type IntegrationTab, type Permission } from './catalog';
import type { DefaultKnowledgeProduct } from './default-knowledge-api';
import type { Status } from './status';

export type Action =
  | { kind: 'connect' | 'settings'; label: 'Connect' | 'Reconnect' | 'Grant access' }
  | { kind: 'workflow' }
  | { kind: 'none'; hint?: string };

export function actionFor(app: Integration, status: Status | null, admin: boolean): Action {
  if (app.provider === 'soon') return { kind: 'none' };
  if (app.provider === 'workflow') return { kind: 'workflow' };
  if (!status) return { kind: 'none' };
  switch (status.kind) {
    case 'loading':
    case 'error':
      return { kind: 'none' };
    case 'unavailable':
      return { kind: 'none', hint: `${status.detail}.` };
    case 'installed':
      return { kind: 'none', hint: 'Message TulipFarm in Slack to link your account.' };
    case 'connected':
      return app.provider === 'atlassian' || app.provider === 'trello'
        ? { kind: 'none', hint: 'Pick a site or board in Accounts to use it in chat.' }
        : { kind: 'none' };
    case 'off':
    case 'attention': {
      const label = status.kind === 'attention' ? 'Reconnect' : status.granted ? 'Grant access' : 'Connect';
      if (app.provider === 'github')
        return admin ? { kind: 'settings', label } : { kind: 'none', hint: 'Ask a workspace admin to connect GitHub.' };
      if (app.provider === 'slack' && status.kind === 'off' && !status.canConnect)
        return { kind: 'none', hint: 'Ask an integration manager for Slack access.' };
      return { kind: 'connect', label };
    }
  }
}

/** The other Google app a permission still needs, when its own scope is granted. */
export function dependency(item: Permission, granted: readonly string[] | undefined): Integration | undefined {
  if (
    !item.alsoNeeds ||
    !granted ||
    (item.scope && !granted.includes(item.scope)) ||
    googleAppScopes[item.alsoNeeds].every(scope => granted.includes(scope))
  )
    return undefined;
  return integrations.find(entry => entry.googleApp === item.alsoNeeds);
}

export const defaultKnowledgeProducts: Partial<Record<string, DefaultKnowledgeProduct>> = {
  'google-drive': 'google-drive',
  gmail: 'gmail',
  slack: 'slack',
  'github-personal': 'github',
  jira: 'jira',
  confluence: 'confluence',
};

const personal = new Set<Integration['provider']>(['google', 'slack', 'github-personal', 'atlassian', 'trello']);
const administered = new Set<Integration['provider']>(['slack', 'github']);

/** The tabs an integration page shows, in order. */
export function tabsFor(app: Integration, admin: boolean): IntegrationTab[] {
  if (app.provider === 'soon') return ['overview'];
  return [
    'overview',
    ...(personal.has(app.provider) ? (['accounts'] as const) : []),
    ...(defaultKnowledgeProducts[app.id] ? (['knowledge'] as const) : []),
    ...(admin && administered.has(app.provider) ? (['settings'] as const) : []),
    'advanced',
  ];
}

export const tabLabels: Record<IntegrationTab, string> = {
  overview: 'Overview',
  accounts: 'Accounts',
  knowledge: 'Knowledge',
  settings: 'Settings',
  advanced: 'Advanced',
};

export function StatusBadge({ status, soon }: { status: Status | null; soon?: boolean }) {
  if (soon) return <Badge variant="outline">Coming soon</Badge>;
  if (!status) return null;
  switch (status.kind) {
    case 'loading':
      return (
        <span className="block w-20" role="status" aria-label="Checking status">
          <Skeleton />
        </span>
      );
    case 'connected':
      return (
        <Badge variant="success">
          <CheckIcon aria-hidden="true" />
          Connected
        </Badge>
      );
    case 'installed':
      return <Badge variant="secondary">Installed</Badge>;
    case 'attention':
      return <Badge variant="warning">Needs attention</Badge>;
    case 'off':
      return <Badge variant="outline">{status.granted ? 'Not granted' : 'Not connected'}</Badge>;
    case 'unavailable':
      return <Badge variant="outline">Unavailable</Badge>;
    case 'error':
      return <Badge variant="destructive">Couldn’t check</Badge>;
  }
}
