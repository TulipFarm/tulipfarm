import { googleAppScopes, googleIdentityScopes, type GoogleApp } from '@tulipfarm/google-workspace/public-contracts';
import type { loadGoogleIntegration } from '@/lib/google-workspace';
import type { githubApi } from '@/lib/github';
import type { AccountList } from '@/lib/atlassian';
import type { SlackStatus } from './slack';
import type { Integration } from '@/features/workspace-mcp/contracts';

type Target =
  | { kind: 'google'; app?: GoogleApp }
  | { kind: 'slack' }
  | { kind: 'slack-user'; eventId: string }
  | { kind: 'github' | 'atlassian' | 'mcp'; accountId: string };
export type AuthorizationAttention = {
  id: string;
  name: string;
  reason: 'permissions' | 'reauthorize';
  target: Target;
};
export type AuthorizationSources = {
  google?: Awaited<ReturnType<typeof loadGoogleIntegration>> | null | undefined;
  slack?: SlackStatus | 'unavailable' | null | undefined;
  github?: Awaited<ReturnType<typeof githubApi.list>> | null | undefined;
  atlassian?: AccountList | null | undefined;
  mcp?: readonly Integration[] | null | undefined;
};
const googleNames: Record<GoogleApp, string> = {
  gmail: 'Gmail',
  calendar: 'Google Calendar',
  drive: 'Google Drive',
  sheets: 'Google Sheets',
  docs: 'Google Docs',
  slides: 'Google Slides',
};

export function authorizationAttention(sources: AuthorizationSources): AuthorizationAttention[] {
  const items: AuthorizationAttention[] = [];
  const google = sources.google?.configured ? sources.google.status : null;
  if (google && google.status !== 'disconnected') {
    if (google.status === 'reconnect-required' || googleIdentityScopes.some(scope => !google.scopes.includes(scope))) {
      items.push({
        id: 'google',
        name: `Google (${google.email})`,
        reason: google.status === 'reconnect-required' ? 'reauthorize' : 'permissions',
        target: { kind: 'google' },
      });
    } else
      for (const app of Object.keys(googleAppScopes) as GoogleApp[]) {
        const required = googleAppScopes[app];
        if (
          required.some(scope => google.scopes.includes(scope)) &&
          required.some(scope => !google.scopes.includes(scope))
        ) {
          items.push({
            id: `google:${app}`,
            name: `${googleNames[app]} (${google.email})`,
            reason: 'permissions',
            target: { kind: 'google', app },
          });
        }
      }
  }
  const slack = sources.slack;
  if (slack && slack !== 'unavailable') {
    if (slack.canManage && ['reconnect-required', 'permissions-required', 'scope-missing'].includes(slack.state)) {
      items.push({
        id: 'slack',
        name: 'Slack workspace',
        reason: slack.missingScopes?.length || slack.state === 'scope-missing' ? 'permissions' : 'reauthorize',
        target: { kind: 'slack' },
      });
    }
    if (slack.recoveryEventId)
      items.push({
        id: 'slack-user',
        name: 'Your Slack account',
        reason: 'reauthorize',
        target: { kind: 'slack-user', eventId: slack.recoveryEventId },
      });
  }
  for (const account of sources.github?.configured ? sources.github.accounts : []) {
    if (account.configured && account.state === 'reconnect-required')
      items.push({
        id: `github:${account.id}`,
        name: account.identity ? `GitHub (@${account.identity.login})` : 'GitHub',
        reason: 'reauthorize',
        target: { kind: 'github', accountId: account.id },
      });
  }
  for (const account of sources.atlassian?.accounts ?? []) {
    if (account.configured && account.capabilities.manage && account.state === 'reconnect-required') {
      const provider = account.protocol === 'trello' ? 'Trello' : 'Atlassian';
      items.push({
        id: `atlassian:${account.id}`,
        name: account.identity ? `${provider} (${account.identity.label})` : provider,
        reason: 'reauthorize',
        target: { kind: 'atlassian', accountId: account.id },
      });
    }
  }
  for (const integration of sources.mcp ?? []) {
    if (integration.canManage && integration.authMethod === 'oauth' && integration.reauthorizationRequired) {
      items.push({
        id: `mcp:${integration.id}`,
        name: integration.name,
        reason: 'reauthorize',
        target: { kind: 'mcp', accountId: integration.id },
      });
    }
  }
  return items;
}
