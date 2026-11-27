import { z } from 'zod';
import type { RegistryEntry } from '@tulipfarm/workspace-mcp-transport';
import {
  googleAppScopes,
  type GoogleAccountSummary,
  type GoogleApp,
  type GoogleStatus,
} from '@tulipfarm/google-workspace/public-contracts';

type Provider = 'google' | 'github' | 'atlassian' | 'trello';
type App = { name: string; provider: Provider; googleApp?: GoogleApp };

/** The integrations a person can connect from chat, by their Integrations page ID. */
export const connectableApps = {
  gmail: { name: 'Gmail', provider: 'google', googleApp: 'gmail' },
  'google-calendar': { name: 'Google Calendar', provider: 'google', googleApp: 'calendar' },
  'google-drive': { name: 'Google Drive', provider: 'google', googleApp: 'drive' },
  'google-sheets': { name: 'Google Sheets', provider: 'google', googleApp: 'sheets' },
  'google-docs': { name: 'Google Docs', provider: 'google', googleApp: 'docs' },
  'google-slides': { name: 'Google Slides', provider: 'google', googleApp: 'slides' },
  'github-personal': { name: 'GitHub', provider: 'github' },
  jira: { name: 'Jira', provider: 'atlassian' },
  confluence: { name: 'Confluence', provider: 'atlassian' },
  trello: { name: 'Trello', provider: 'trello' },
} as const satisfies Record<string, App>;
export type ConnectableApp = keyof typeof connectableApps;
export const connectableAppSchema = z.enum(Object.keys(connectableApps) as [ConnectableApp, ...ConnectableApp[]]);

/** `google`, `google:<id>`, `github:<id>`, or `atlassian:<id>`. Trello accounts are Atlassian accounts. */
export const connectionIdSchema = z.union([
  z.literal('google'),
  z.templateLiteral(['google:', z.uuid()]),
  z.templateLiteral(['github:', z.uuid()]),
  z.templateLiteral(['atlassian:', z.uuid()]),
]);
export type ConnectionId = z.infer<typeof connectionIdSchema>;

type AccountState = 'authorizing' | 'active' | 'refreshing' | 'reconnect-required' | 'disconnected';
/** The account reads chat lists connections with. Each acts for the person and returns no credentials. */
export type ConnectionServices = {
  /** Present only when custom MCP connections are enabled. Searches the public MCP registry. */
  mcp?:
    | {
        search(query: string, signal?: AbortSignal): Promise<RegistryEntry[]>;
        /** Whether this workspace may run npm and PyPI server packages in a hosted sandbox. */
        hosted?(workspaceId: string): Promise<boolean>;
      }
    | undefined;
  google?:
    | {
        availability(): { configured: boolean };
        status(workspaceId: string, userId: string): Promise<GoogleStatus>;
        list?(workspaceId: string, userId: string): Promise<GoogleAccountSummary[]>;
      }
    | undefined;
  github?:
    | {
        list(
          workspaceId: string,
          userId: string,
        ): Promise<{
          configured: boolean;
          accounts: { id: string; state: AccountState; identity: { login: string } | null }[];
        }>;
      }
    | undefined;
  atlassian?:
    | {
        list(
          workspaceId: string,
          userId: string,
        ): Promise<{
          accounts: {
            id: string;
            protocol: 'atlassian-mcp' | 'trello' | (string & {});
            ownership: 'personal' | 'business';
            state: AccountState;
            identity: { label: string } | null;
            resources: { name: string }[];
            capabilities: { manage: boolean };
          }[];
          providers: { protocol: string; configured: boolean }[];
        }>;
      }
    | undefined;
};

export type Connection = {
  connectionId: ConnectionId;
  provider: Provider;
  account: string | null;
  label?: string | null;
  email?: string | null;
  state: 'connected' | 'reconnect-required' | 'sign-in-incomplete';
  ownership: 'personal' | 'business' | 'shared';
  /** Google apps this connection was granted. */
  apps?: ConnectableApp[];
  /** Atlassian sites or Trello workspaces the account reaches. */
  sites?: string[];
  canDisconnect: boolean;
};

const state = (value: AccountState): Connection['state'] =>
  value === 'active' || value === 'refreshing'
    ? 'connected'
    : value === 'reconnect-required'
      ? 'reconnect-required'
      : 'sign-in-incomplete';

const grantedGoogleApps = (scopes: readonly string[]): ConnectableApp[] =>
  (Object.keys(connectableApps) as ConnectableApp[]).filter(app => {
    const target: App = connectableApps[app];
    return target.googleApp && googleAppScopes[target.googleApp].every(scope => scopes.includes(scope));
  });

/** The person's connections, and which integrations this server can connect. Disconnected accounts are left out. */
export async function listConnections(services: ConnectionServices, workspaceId: string, userId: string) {
  const googleConfigured = services.google?.availability().configured === true;
  const [googleAccounts, googleLegacy, github, atlassian] = await Promise.all([
    googleConfigured && services.google?.list ? services.google.list(workspaceId, userId) : null,
    googleConfigured && !services.google?.list ? services.google!.status(workspaceId, userId) : null,
    services.github ? services.github.list(workspaceId, userId) : null,
    services.atlassian ? services.atlassian.list(workspaceId, userId) : null,
  ]);
  const connections: Connection[] = [];
  if (googleAccounts) {
    for (const account of googleAccounts) {
      if (account.status === 'disconnected') continue;
      connections.push({
        connectionId: `google:${account.integrationId}`,
        provider: 'google',
        account: account.email ?? account.label ?? null,
        label: account.label ?? account.email ?? null,
        email: account.email ?? null,
        state: account.status,
        ownership: account.ownership,
        apps: grantedGoogleApps(account.scopes),
        canDisconnect: account.canManage,
      });
    }
  } else if (googleLegacy && googleLegacy.status !== 'disconnected') {
    connections.push({
      connectionId: 'google',
      provider: 'google',
      account: googleLegacy.email,
      state: googleLegacy.status,
      ownership: 'personal',
      apps: grantedGoogleApps(googleLegacy.scopes),
      canDisconnect: true,
    });
  }
  for (const account of github?.accounts ?? [])
    if (account.state !== 'disconnected')
      connections.push({
        connectionId: `github:${account.id}`,
        provider: 'github',
        account: account.identity?.login ?? null,
        state: state(account.state),
        ownership: 'personal',
        canDisconnect: true,
      });
  for (const account of atlassian?.accounts ?? [])
    if (account.state !== 'disconnected')
      connections.push({
        connectionId: `atlassian:${account.id}`,
        provider: account.protocol === 'trello' ? 'trello' : 'atlassian',
        account: account.identity?.label ?? null,
        state: state(account.state),
        ownership: account.ownership,
        sites: account.resources.map(resource => resource.name).slice(0, 20),
        canDisconnect: account.capabilities.manage,
      });
  const configured = (app: ConnectableApp) => {
    const { provider } = connectableApps[app];
    if (provider === 'google') return googleConfigured;
    if (provider === 'github') return github?.configured === true;
    const protocol = provider === 'trello' ? 'trello' : 'atlassian-mcp';
    return atlassian?.providers.some(item => item.protocol === protocol && item.configured) === true;
  };
  const connected = (app: ConnectableApp) =>
    connections.some(
      connection =>
        connection.state === 'connected' &&
        (connection.apps
          ? connection.apps.includes(app)
          : connection.provider === connectableApps[app].provider && connection.ownership === 'personal'),
    );
  return {
    connections,
    apps: (Object.keys(connectableApps) as ConnectableApp[])
      .filter(configured)
      .map(app => ({ app, name: connectableApps[app].name, connected: connected(app) })),
  };
}
