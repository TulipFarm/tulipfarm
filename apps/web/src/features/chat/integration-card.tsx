import { useRef, useState } from 'react';
import { BrandIcon } from '@tulipfarm/sprout/brand-icon';
import { ReviewCard, ReviewRow, ReviewRows } from '@tulipfarm/sprout/review-card';
import { Button } from '@tulipfarm/sprout/button';
import type { IntegrationCardView } from './conversation-api';
import { McpConnectCard } from './mcp-connect-card';
import { googleApi, googleError } from '@/lib/google-workspace';
import { githubApi, githubError } from '@/lib/github';
import { atlassianApi, atlassianError } from '@/lib/atlassian';
import { integrationById, makerOf, providers, type Integration } from '@/features/integrations/catalog';
import { connector } from '@/features/integrations/connect';
import { statusOf, useIntegrationStatus } from '@/features/integrations/status';
import {
  useAtlassianAccounts,
  useGitHubAccounts,
  useGoogleIntegration,
  useIntegrationChanges,
} from '@/features/integrations/queries';

export function IntegrationCard({
  workspaceId,
  slug,
  card,
}: {
  workspaceId: string;
  slug: string;
  card: IntegrationCardView;
}) {
  return card.action === 'mcp' ? (
    <McpConnectCard workspaceId={workspaceId} slug={slug} card={card} />
  ) : card.action === 'connect' ? (
    <ConnectCard workspaceId={workspaceId} appId={card.app} />
  ) : (
    <DisconnectCard workspaceId={workspaceId} connectionId={card.connectionId} />
  );
}

type Connectable = Integration & { provider: Exclude<Integration['provider'], 'soon' | 'workflow' | 'github'> };
const connectable = (app: Integration | undefined): app is Connectable =>
  !!app && app.provider !== 'soon' && app.provider !== 'workflow' && app.provider !== 'github';

function ConnectCard({ workspaceId, appId }: { workspaceId: string; appId: string }) {
  const app = integrationById(appId);
  if (!connectable(app)) return null;
  return <Connect workspaceId={workspaceId} app={app} />;
}

function Connect({ workspaceId, app }: { workspaceId: string; app: Connectable }) {
  const { statuses } = useIntegrationStatus(workspaceId, app.provider);
  const status = statusOf(statuses, app);
  const [state, setState] = useState<'idle' | 'pending' | 'failed'>('idle');
  const lock = useRef(false);
  const connected = status?.kind === 'connected' || status?.kind === 'installed';
  const reconnect = status?.kind === 'attention';
  const run = connector(app, workspaceId);
  const available = !!run && (status?.kind === 'off' ? status.canConnect : reconnect);
  async function start() {
    if (lock.current || !run) return;
    lock.current = true;
    setState('pending');
    try {
      await run();
    } catch {
      setState('failed');
    } finally {
      lock.current = false;
    }
  }
  const verb = reconnect ? 'Reconnect' : 'Connect';
  return (
    <ReviewCard
      label={`${verb} ${app.name}`}
      icon={<BrandIcon brand={app.brand} size="inline" />}
      title={`${verb} ${app.name}`}
      badge={
        connected
          ? { label: 'Connected', variant: 'info' }
          : reconnect
            ? { label: 'Needs attention', variant: 'warning' }
            : { label: 'Not connected', variant: 'secondary' }
      }
      settled={connected}
      actions={
        available ? (
          <Button disabled={state === 'pending'} aria-busy={state === 'pending'} onClick={() => void start()}>
            {verb} {app.name}
          </Button>
        ) : undefined
      }
      status={
        <div className="text-sm">
          {connected && <p role="status">{app.name} is connected. Ask chat to continue.</p>}
          {status?.kind === 'unavailable' && <p role="status">{status.detail}.</p>}
          {status?.kind === 'error' && <p role="status">{status.detail}</p>}
          {state === 'pending' && <p role="status">Opening {makerOf(app)} sign-in…</p>}
          {state === 'failed' && <p role="status">Sign-in didn’t start. Try again.</p>}
        </div>
      }
    >
      <ReviewRows>
        <ReviewRow label="Who can use it">{providers[app.provider].audience}</ReviewRow>
        <ReviewRow label="What agents can do">
          <ul className="space-y-1">
            {[...providers[app.provider].can, ...(app.can ?? [])].map(permission => (
              <li key={permission.text}>
                {permission.text}
                {permission.asksFirst && <span className="text-muted-foreground"> (asks you first)</span>}
              </li>
            ))}
          </ul>
        </ReviewRow>
      </ReviewRows>
      <p className="text-xs text-muted-foreground">
        You sign in with {makerOf(app)}. TulipFarm never sees your password.
      </p>
    </ReviewCard>
  );
}

type Account = {
  name: string;
  brand: Integration['brand'];
  label: string;
  impact: string[];
  disconnect: () => Promise<string | null>;
};

function DisconnectCard({ workspaceId, connectionId }: { workspaceId: string; connectionId: string }) {
  const [kind, id] = connectionId === 'google' ? ['google', ''] : connectionId.split(':');
  const google = useGoogleIntegration(workspaceId, kind === 'google');
  const github = useGitHubAccounts(workspaceId, kind === 'github');
  const atlassian = useAtlassianAccounts(workspaceId, kind === 'atlassian');
  const changes = useIntegrationChanges();
  const [state, setState] = useState<'idle' | 'pending' | 'done' | 'failed'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const lock = useRef(false);

  let account: Account | null | undefined;
  if (kind === 'google') {
    const status = google.data?.status;
    account =
      status === undefined
        ? undefined
        : status.status === 'disconnected'
          ? null
          : {
              name: 'Google',
              brand: 'gmail',
              label: status.email,
              impact: [
                `Agents lose access to Gmail, Calendar, Drive, Docs, Sheets and Slides for ${status.email}.`,
                'Gmail checks for new mail stop.',
              ],
              disconnect: async () => {
                const result = await googleApi.disconnect(workspaceId);
                await changes.authority('google');
                return result.revoked ? null : 'Also remove TulipFarm in your Google Account permissions.';
              },
            };
  } else if (kind === 'github') {
    const found = github.state.kind === 'ready' ? github.state.data.accounts.find(item => item.id === id) : undefined;
    account =
      github.state.kind !== 'ready'
        ? undefined
        : !found || found.state === 'disconnected'
          ? null
          : {
              name: 'GitHub',
              brand: 'github',
              label: found.identity?.login ?? 'Unfinished sign-in',
              impact: [
                `Agents can no longer use ${found.identity?.login ?? 'this account'}.`,
                'Your repositories aren’t changed.',
              ],
              disconnect: async () => {
                await githubApi.disconnect(workspaceId, found.id);
                await changes.authority('github-personal');
                return 'To revoke the grant at GitHub, open GitHub Settings, Applications, Authorized GitHub Apps.';
              },
            };
  } else {
    const found =
      atlassian.state.kind === 'ready' ? atlassian.state.data.accounts.find(item => item.id === id) : undefined;
    const trello = found?.protocol === 'trello';
    account =
      atlassian.state.kind !== 'ready'
        ? undefined
        : !found || found.state === 'disconnected' || !found.capabilities.manage
          ? null
          : {
              name: trello ? 'Trello' : 'Atlassian',
              brand: trello ? 'trello' : 'jira',
              label: found.identity?.label ?? 'Unfinished sign-in',
              impact: [
                `Agents stop using this account${trello ? '' : ' for Jira and Confluence'}.`,
                'Changes waiting for approval can no longer run.',
                ...(found.ownership === 'business' ? ['Everyone it’s shared with loses it too.'] : []),
              ],
              disconnect: async () => {
                await atlassianApi.disconnect(workspaceId, found.id);
                await changes.atlassianAccounts();
                return 'To revoke access at Atlassian, open your Atlassian account settings, Connected apps.';
              },
            };
  }

  async function disconnect() {
    if (lock.current || !account) return;
    lock.current = true;
    setState('pending');
    try {
      setMessage(await account.disconnect());
      setState('done');
    } catch (error) {
      setMessage(
        kind === 'google' ? googleError(error) : kind === 'github' ? githubError(error) : atlassianError(error),
      );
      setState('failed');
    } finally {
      lock.current = false;
    }
  }

  const gone = account === null || state === 'done';
  const title = account ? `Disconnect ${account.name}` : 'Disconnect account';
  return (
    <ReviewCard
      label={title}
      icon={account ? <BrandIcon brand={account.brand} size="inline" /> : null}
      title={title}
      badge={
        gone
          ? { label: 'Disconnected', variant: 'secondary' }
          : account === undefined
            ? { label: 'Checking', variant: 'secondary' }
            : { label: 'Needs approval', variant: 'warning' }
      }
      settled={gone}
      actions={
        account && state !== 'done' ? (
          <Button
            variant="destructive"
            disabled={state === 'pending'}
            aria-busy={state === 'pending'}
            onClick={() => void disconnect()}
          >
            Disconnect
          </Button>
        ) : undefined
      }
      status={
        <div className="space-y-1 text-sm">
          {state === 'pending' && <p role="status">Disconnecting…</p>}
          {gone && <p role="status">Not connected. Nothing more to do here.</p>}
          {message && <p role="status">{message}</p>}
        </div>
      }
    >
      {account && (
        <>
          <ReviewRows>
            <ReviewRow label="Account">
              <span className="break-words">{account.label}</span>
            </ReviewRow>
            <ReviewRow label="What stops">
              <ul className="space-y-1">
                {account.impact.map(line => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </ReviewRow>
          </ReviewRows>
          <p className="text-xs text-muted-foreground">You can connect it again later from chat or Integrations.</p>
        </>
      )}
    </ReviewCard>
  );
}
