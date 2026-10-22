import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Button } from '@tulipfarm/sprout/button';
import { NoticeBanner } from '@tulipfarm/sprout/notice-banner';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { googleApi } from '@/lib/google-workspace';
import { githubApi, githubConsent } from '@/lib/github';
import { atlassianApi } from '@/lib/atlassian';
import { consentUrl } from '@/features/atlassian/accounts';
import { useMcpApi, useMcpCapabilities, useMcpIntegrations } from '@/features/workspace-mcp/queries';
import { useAtlassianAccounts, useGitHubAccounts, useGoogleIntegration, useSlackIntegration } from './queries';
import { slackInstallUrl } from './slack';
import { useFeatureContext } from '@/lib/query/provider';
import { authorizationAttention, type AuthorizationSources } from './authorization-attention';
import type { ReadState } from '@/features/tables/request-state';

function loaded<T>(state: ReadState<T>): T | undefined {
  return state.kind === 'ready' ? state.data : undefined;
}

export function ReauthorizationBanner({ workspaceId, slug }: { workspaceId: string; slug: string }) {
  const { current } = useFeatureContext();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const active = () => mounted.current && current();
  const google = useGoogleIntegration(workspaceId);
  const slack = useSlackIntegration(workspaceId);
  const github = useGitHubAccounts(workspaceId);
  const atlassian = useAtlassianAccounts(workspaceId);
  const mcpApi = useMcpApi(workspaceId);
  const capabilities = useMcpCapabilities(mcpApi);
  const mcpEnabled = loaded(capabilities.state);
  const mcp = useMcpIntegrations(mcpApi, mcpEnabled?.enabled === true && mcpEnabled.integrationsEnabled);
  const sources: AuthorizationSources = {
    google: loaded(google.state),
    slack: loaded(slack.state),
    github: loaded(github.state),
    atlassian: loaded(atlassian.state),
    mcp: mcpEnabled?.enabled && mcpEnabled.integrationsEnabled ? loaded(mcp.state)?.integrations : undefined,
  };
  const items = authorizationAttention(sources);
  const [chosen, setChosen] = useState<string | null>(null);
  const selected = items.find(item => item.id === chosen) ?? items[0];
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const lock = useRef(false);
  const navigate = useNavigate();
  const states = {
    google: google.state,
    slack: slack.state,
    'slack-user': slack.state,
    github: github.state,
    atlassian: atlassian.state,
    mcp: mcp.state,
  };
  const state = selected ? states[selected.target.kind] : null;
  const stale =
    (state?.kind === 'ready' && !!state.error) ||
    (selected?.target.kind === 'mcp' && capabilities.state.kind === 'ready' && !!capabilities.state.error);
  const checking =
    (state?.kind === 'ready' && state.refreshing) ||
    (selected?.target.kind === 'mcp' && capabilities.state.kind === 'ready' && capabilities.state.refreshing);
  async function authorize() {
    if (!selected || lock.current || stale || checking || !active()) return;
    lock.current = true;
    setBusy(true);
    setFailed(false);
    try {
      const target = selected.target;
      if (target.kind === 'google') {
        const url = new URL((await googleApi.begin(workspaceId, target.app)).authorizationUrl);
        if (
          url.origin !== 'https://accounts.google.com' ||
          url.pathname !== '/o/oauth2/v2/auth' ||
          url.username ||
          url.password
        )
          throw new Error('Unexpected consent destination');
        if (active()) window.location.assign(url.href);
      } else if (target.kind === 'slack') {
        const url = await slackInstallUrl(workspaceId);
        if (active()) window.location.assign(url);
      } else if (target.kind === 'slack-user')
        await navigate({ to: '/slack/link', search: { workspaceId, eventId: target.eventId } });
      else if (target.kind === 'github') {
        const result = await githubApi.reconnect(workspaceId, target.accountId);
        if (active()) githubConsent(result.url);
      } else if (target.kind === 'atlassian') {
        const result = await atlassianApi.reconnect(workspaceId, target.accountId);
        if (active()) window.location.assign(consentUrl(result.url));
      } else
        await navigate({
          to: '/$workspaceSlug/integrations',
          params: { workspaceSlug: slug },
          hash: `reauthorize-mcp-${target.accountId}`,
        });
    } catch {
      setFailed(true);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function check() {
    if (lock.current || !active()) return;
    lock.current = true;
    setBusy(true);
    try {
      await Promise.all([
        google.refresh(),
        slack.refresh(),
        github.refresh(),
        atlassian.refresh(),
        capabilities.refresh(),
        ...(mcpEnabled?.enabled && mcpEnabled.integrationsEnabled ? [mcp.refresh()] : []),
      ]);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  if (!selected) return null;
  return (
    <NoticeBanner
      aria-label="Integration authorization"
      actions={
        <>
          {items.length > 1 && (
            <div className="w-full min-w-0 sm:w-64">
              <Select
                value={selected.id}
                onValueChange={value => {
                  setChosen(value);
                  setFailed(false);
                }}
                disabled={busy}
              >
                <SelectTrigger aria-label="Integration to reauthorize">
                  <SelectValue>{selected.name}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {items.map(item => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <Button
            variant="outline"
            disabled={busy || checking}
            aria-busy={busy || checking}
            onClick={() => void (failed || stale ? check() : authorize())}
          >
            {busy || checking ? 'Please wait...' : failed || stale ? 'Check integration status' : 'Update permissions'}
          </Button>
        </>
      }
    >
      {failed || stale ? (
        <p role="alert">
          {failed ? 'Authorization could not be opened.' : 'Integration status could not refresh.'} Check integration
          status before trying again.
        </p>
      ) : (
        <p role="status">
          <span className="font-medium text-warning">
            {items.length > 1
              ? `${items.length} integrations need authorization.`
              : `${selected.name} needs authorization.`}
          </span>{' '}
          {selected.reason === 'permissions'
            ? 'Approve the updated permissions to continue.'
            : selected.target.kind === 'github'
              ? 'GitHub reads and actions with this account need renewed access.'
              : `Tasks using ${selected.name} need renewed access.`}
        </p>
      )}
    </NoticeBanner>
  );
}
