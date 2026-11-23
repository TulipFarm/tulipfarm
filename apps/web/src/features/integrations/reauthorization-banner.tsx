import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { googleApi } from '@/lib/google-workspace';
import { githubApi, githubConsent } from '@/lib/github';
import { atlassianApi } from '@/lib/atlassian';
import { useMcpApi, useMcpCapabilities, useMcpIntegrations } from '@/features/workspace-mcp/queries';
import { useAtlassianAccounts, useGitHubAccounts, useGoogleIntegration, useSlackIntegration } from './queries';
import { useFeatureContext } from '@/lib/query/provider';
import { mcpPagePrefix } from './mcp-page';
import { authorizationAttention, type AuthorizationSources } from './authorization-attention';
import type { ReadState } from '@/features/tables/request-state';

// The banner's controls load only when an integration needs reauthorization.
const ReauthorizationView = lazy(() => import('./reauthorization-view'));

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
  const [sheet, setSheet] = useState(false);
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
        const { slackInstallUrl } = await import('./slack');
        const url = await slackInstallUrl(workspaceId);
        if (active()) window.location.assign(url);
      } else if (target.kind === 'slack-user') {
        await navigate({ to: '/slack/link', search: { workspaceId, eventId: target.eventId } });
        setSheet(false);
      } else if (target.kind === 'github') {
        const result = await githubApi.reconnect(workspaceId, target.accountId);
        if (active()) githubConsent(result.url);
      } else if (target.kind === 'atlassian') {
        const [result, { consentUrl }] = await Promise.all([
          atlassianApi.reconnect(workspaceId, target.accountId),
          import('@/features/atlassian/accounts'),
        ]);
        if (active()) window.location.assign(consentUrl(result.url));
      } else {
        await navigate({
          to: '/$workspaceSlug/integrations/$integrationId',
          params: { workspaceSlug: slug, integrationId: `${mcpPagePrefix}${target.accountId}` },
        });
        setSheet(false);
      }
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
    <Suspense fallback={null}>
      <ReauthorizationView
        items={items}
        selected={selected}
        busy={busy}
        checking={!!checking}
        failed={failed}
        stale={stale}
        sheet={sheet}
        setSheet={setSheet}
        onChoose={id => {
          setChosen(id);
          setFailed(false);
        }}
        onAuthorize={() => void authorize()}
        onCheck={() => void check()}
      />
    </Suspense>
  );
}
