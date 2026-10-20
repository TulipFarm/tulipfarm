import { googleApi } from '@/lib/google-workspace';
import { githubApi, githubConsent } from '@/lib/github';
import { atlassianApi } from '@/lib/atlassian';
import { consentUrl } from '@/features/atlassian/accounts';
import { startSlackInstall } from './slack';
import type { Integration } from './catalog';

async function startGoogle(workspaceId: string, app: Integration['googleApp']) {
  const url = new URL((await googleApi.begin(workspaceId, app)).authorizationUrl);
  if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth')
    throw new Error('Unexpected consent destination');
  window.location.assign(url.href);
}

async function startGitHub(workspaceId: string) {
  const unfinished = (await githubApi.list(workspaceId)).accounts.find(
    account => account.state !== 'active' && account.state !== 'disconnected',
  );
  githubConsent(
    (unfinished ? await githubApi.reconnect(workspaceId, unfinished.id) : await githubApi.begin(workspaceId)).url,
  );
}

async function startAtlassian(workspaceId: string, protocol: 'atlassian-mcp' | 'trello') {
  const { accounts } = await atlassianApi.accounts(workspaceId);
  const unfinished = accounts.find(
    account =>
      account.protocol === protocol &&
      account.ownership === 'personal' &&
      account.capabilities.manage &&
      ['authorizing', 'reconnect-required', 'disconnected'].includes(account.state),
  );
  const value = unfinished
    ? await atlassianApi.reconnect(workspaceId, unfinished.id)
    : await atlassianApi.begin(workspaceId, { protocol, ownership: { kind: 'personal' } });
  window.location.assign(consentUrl(value.url));
}

export function connector(app: Integration, workspaceId: string): (() => Promise<void>) | null {
  switch (app.provider) {
    case 'google':
      return () => startGoogle(workspaceId, app.googleApp);
    case 'slack':
      return () => startSlackInstall(workspaceId);
    case 'github-personal':
      return () => startGitHub(workspaceId);
    case 'atlassian':
      return () => startAtlassian(workspaceId, 'atlassian-mcp');
    case 'trello':
      return () => startAtlassian(workspaceId, 'trello');
    default:
      return null;
  }
}
