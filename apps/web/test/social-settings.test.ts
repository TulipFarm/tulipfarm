import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createElement, type ReactElement } from 'react';
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import type * as Connections from '../src/features/social/settings/connections.tsx';
import type * as Channels from '../src/features/social/settings/channels.tsx';
import type * as Apps from '../src/features/social/settings/platform-apps.tsx';
import type * as Grants from '../src/features/social/settings/grants.tsx';
import type * as Labels from '../src/features/social/settings/labels.ts';
import type * as Page from '../src/pages/social-settings.tsx';
import type * as Workspace from '../src/pages/workspace.tsx';

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
});
after(() => server.close());
const load = <T>(path: string) => server.ssrLoadModule(path) as Promise<T>;
const { SocialConnections } = await load<typeof Connections>('/src/features/social/settings/connections.tsx');
const { SocialChannels, channelGrantPrincipals } = await load<typeof Channels>(
  '/src/features/social/settings/channels.tsx',
);
const { PlatformApps } = await load<typeof Apps>('/src/features/social/settings/platform-apps.tsx');
const { GrantsView } = await load<typeof Grants>('/src/features/social/settings/grants.tsx');
const { signInUrl, settingsError } = await load<typeof Labels>('/src/features/social/settings/labels.ts');
const { SocialSettingsGate } = await load<typeof Page>('/src/pages/social-settings.tsx');
const { settingsNavigationPages } = await load<typeof Workspace>('/src/pages/workspace.tsx');
const { SocialRequestError } = await load<typeof import('../src/lib/social.ts')>('/src/lib/social.ts');
const { platformAvailabilitySchema, platformAppMetadataSchema, socialAccountMetadataSchema, channelSchema } =
  await import('@tulipfarm/social/contracts');

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const me = id(1);
const other = id(2);
const team = id(3);
const secret = 'super-secret-value-123';

function render(element: ReactElement) {
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
  return renderToStaticMarkup(createElement(RouterContextProvider, { router }, element));
}
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');
const unused = async (): Promise<never> => {
  throw new Error('not called');
};

const linkedinAvailable = platformAvailabilitySchema.parse({
  platform: 'linkedin',
  available: true,
  reason: null,
  appSource: 'operator',
  accessTier: 'share',
  capabilities: ['publish', 'publish-public'],
});
const xNeedsApp = platformAvailabilitySchema.parse({
  platform: 'x',
  available: false,
  reason: 'workspace-app-required',
  appSource: null,
  accessTier: null,
  capabilities: [],
});
const tiktokOff = platformAvailabilitySchema.parse({
  platform: 'tiktok',
  available: false,
  reason: 'not-configured',
  appSource: null,
  accessTier: null,
  capabilities: [],
});
const workspaceApp = platformAppMetadataSchema.parse({
  id: id(10),
  platform: 'linkedin',
  name: 'Marketing app',
  clientId: 'client-123',
  accessTier: 'community-management',
  generation: 1,
  createdAt: '2026-10-01T12:00:00.000Z',
});

function account(fields: Record<string, unknown> = {}) {
  return socialAccountMetadataSchema.parse({
    id: id(20),
    platform: 'linkedin',
    ownership: { kind: 'business', owningTeamId: team },
    appSource: 'operator',
    platformAppId: null,
    state: 'active',
    identity: { platformUserId: 'u-1', handle: null, displayName: 'Acme' },
    scopes: [],
    generation: 1,
    grantsVersion: 1,
    capabilities: { read: true, use: true, manage: true },
    ...fields,
  });
}
function channel(fields: Record<string, unknown> = {}) {
  return channelSchema.parse({
    id: id(30),
    accountId: id(20),
    platform: 'linkedin',
    channelKind: 'organization-page',
    platformChannelId: 'org-1',
    displayName: 'Acme page',
    accountGeneration: 1,
    version: 1,
    grantsVersion: 1,
    enabled: true,
    engagementPolicy: 'approve-each',
    grants: {
      publish: { memberIds: [], teamIds: [] },
      analytics: { memberIds: [], teamIds: [] },
      engagement: { memberIds: [], teamIds: [] },
      manage: { memberIds: [me], teamIds: [] },
    },
    ...fields,
  });
}

const connectionActions = { begin: unused, reconnect: unused, disconnect: unused, navigate: () => {} };
function connections(props: Partial<Parameters<typeof SocialConnections>[0]> = {}) {
  return text(
    render(
      createElement(SocialConnections, {
        availability: [linkedinAvailable, xNeedsApp, tiktokOff],
        apps: [],
        accounts: [],
        ownTeams: [{ id: team, name: 'Marketing' }],
        admin: false,
        actions: connectionActions,
        onChannels: () => {},
        access: () => null,
        ...props,
      }),
    ),
  );
}
const viewer = {
  membershipId: me,
  teamIds: [team],
  members: [
    { id: me, name: 'Dana' },
    { id: other, name: 'Lee' },
  ],
  teams: [{ id: team, name: 'Marketing' }],
};
const channelActions = { reachable: unused, add: unused, saveGrants: unused, refresh: async () => undefined };
function channels(props: Partial<Parameters<typeof SocialChannels>[0]> = {}) {
  return text(
    render(
      createElement(SocialChannels, {
        accounts: [account()],
        selectedId: id(20),
        onSelect: () => {},
        channels: [channel()],
        viewer,
        actions: channelActions,
        ...props,
      }),
    ),
  );
}

test('the settings entry and page are hidden while the flag is off', () => {
  const labels = (social: boolean) => settingsNavigationPages({ soul: false, social }).map(page => page.label);
  assert.ok(labels(true).includes('Social'));
  assert.ok(!labels(false).includes('Social'));
  const off = text(render(createElement(SocialSettingsGate, { enabled: false }, 'SETTINGS BODY')));
  assert.match(off, /Page not found/);
  assert.doesNotMatch(off, /SETTINGS BODY/);
  const loading = text(render(createElement(SocialSettingsGate, { enabled: undefined }, 'SETTINGS BODY')));
  assert.doesNotMatch(loading, /SETTINGS BODY/);
  assert.match(text(render(createElement(SocialSettingsGate, { enabled: true }, 'SETTINGS BODY'))), /SETTINGS BODY/);
});

test('connections show availability per platform and who can add a workspace app', () => {
  const member = connections();
  assert.match(member, /No connections yet/);
  assert.match(member, /Connect LinkedIn/);
  assert.match(member, /Uses the server app/i);
  assert.match(member, /Needs a workspace app\. Ask a workspace admin to add one\./);
  assert.doesNotMatch(member, /Connect X/);
  assert.match(member, /Not available in this workspace\./);
  assert.doesNotMatch(member, /Connect TikTok/);
  assert.match(connections({ admin: true }), /Needs a workspace app\. Add one under Platform apps\./);
});

test('connection rows show state and only managers can reconnect or disconnect', () => {
  const managed = connections({ accounts: [account({ state: 'reconnect-required' })] });
  assert.match(managed, /Acme/);
  assert.match(managed, /Reconnect/);
  assert.match(managed, /Disconnect/);
  assert.match(managed, /Shared with Marketing/);
  const viewerOnly = connections({
    accounts: [account({ state: 'reconnect-required', capabilities: { read: true, use: true, manage: false } })],
  });
  assert.doesNotMatch(viewerOnly, /Reconnect Acme|Disconnect/);
  assert.match(viewerOnly, /Only its managers can reconnect or disconnect it\./);
  const active = connections({ accounts: [account()] });
  assert.doesNotMatch(active, /aria-label="Reconnect/);
  assert.doesNotMatch(connections({ accounts: [account({ state: 'disconnected' })] }), /Acme/);
});

test('platform apps never render a client secret', () => {
  const html = render(
    createElement(PlatformApps, {
      availability: [platformAvailabilitySchema.parse({ ...linkedinAvailable, appSource: 'workspace' }), xNeedsApp],
      apps: [{ ...workspaceApp, clientSecret: secret } as typeof workspaceApp],
      redirectUri: 'http://localhost:3101/v1/social/oauth/callback',
      actions: { create: unused, replaceSecret: unused },
    }),
  );
  assert.doesNotMatch(html, new RegExp(secret));
  assert.match(text(html), /Saved\. It cannot be shown\./);
  assert.match(html, /value="http:\/\/localhost:3101\/v1\/social\/oauth\/callback"/);
  assert.match(text(html), /Marketing app/);
  assert.match(text(html), /client-123/);
  const secretInputs = html.match(/<input[^>]*secret[^>]*>/gi) ?? [];
  assert.ok(secretInputs.length > 0);
  for (const input of secretInputs) {
    assert.match(input, /type="password"/);
    assert.doesNotMatch(input, /value="[^"]+"/);
  }
});

test('channels: reaching grants nothing and adding needs manage on the connection', () => {
  const manager = channels();
  assert.match(manager, /Find channels/);
  assert.match(manager, /Reaching a channel gives no one access/);
  assert.match(manager, /Access/);
  const member = channels({
    accounts: [account({ capabilities: { read: true, use: true, manage: false } })],
    channels: [channel({ grants: { ...channel().grants, manage: { memberIds: [other], teamIds: [] } } })],
  });
  assert.doesNotMatch(member, /Find channels/);
  assert.match(member, /Only managers of this connection can add its channels\./);
  assert.doesNotMatch(member, /Access to Acme page/);
  assert.match(member, /Ask a channel manager to change who can publish\./);
  assert.match(channels({ accounts: [account({ state: 'reconnect-required' })] }), /Reconnect this connection/);
  const stale = channels({ accounts: [account({ generation: 2 })] });
  assert.match(stale, /Add again/);
  assert.match(stale, /Add this channel again below/);
  assert.match(channels({ accounts: [] }), /No connections to show/);
});

const roles = [
  { key: 'publish', label: 'Publish', verb: 'publish' },
  { key: 'manage', label: 'Manage', verb: 'manage' },
] as const;
function grants(fields: Partial<Parameters<typeof GrantsView<'publish' | 'manage'>>[0]> = {}) {
  return render(
    createElement(GrantsView<'publish' | 'manage'>, {
      title: 'Channel access',
      roles,
      members: viewer.members,
      teams: viewer.teams,
      value: { publish: { memberIds: [other], teamIds: [team] }, manage: { memberIds: [me], teamIds: [] } },
      managerRole: 'manage',
      conflict: false,
      busy: false,
      message: null,
      onToggle: () => {},
      onSave: () => {},
      onReload: () => {},
      ...fields,
    }),
  );
}

test('grants list members and teams only, and flag stale versions and a missing manager', () => {
  const html = grants();
  const plain = text(html);
  assert.match(html, /aria-label="Allow Lee to publish"/);
  assert.match(html, /aria-label="Allow Marketing to publish"/);
  assert.doesNotMatch(plain, /agent/i);
  assert.doesNotMatch(plain, /Someone else changed/);
  assert.match(html, /<button[^>]*aria-label="Save channel access"(?![^>]*disabled)/);

  const conflict = grants({ conflict: true });
  assert.match(
    text(conflict),
    /Someone else changed these grants after you opened them\. Your changes are not saved\./,
  );
  assert.match(
    conflict,
    /<button[^>]*disabled[^>]*aria-label="Save channel access"|aria-label="Save channel access"[^>]*disabled/,
  );
  assert.match(conflict, /<fieldset[^>]*disabled/);

  const noManager = grants({
    value: { publish: { memberIds: [], teamIds: [] }, manage: { memberIds: [], teamIds: [] } },
  });
  assert.match(text(noManager), /Keep at least one manager/);
  assert.match(
    noManager,
    /<button[^>]*disabled[^>]*aria-label="Save channel access"|aria-label="Save channel access"[^>]*disabled/,
  );

  const unknown = text(
    grants({ value: { publish: { memberIds: [id(9)], teamIds: [id(8)] }, manage: { memberIds: [me], teamIds: [] } } }),
  );
  assert.match(unknown, /Former or unlisted member/);
  assert.match(unknown, /Team you are not in/);
});

test('channel access on a personal connection lists only its owner', () => {
  const personal = account({ ownership: { kind: 'personal' } });
  assert.match(channels({ accounts: [personal] }), /Access/);
  const principals = channelGrantPrincipals(personal, viewer);
  assert.deepEqual(principals, { members: [{ id: me, name: 'Dana' }], teams: [] });
  assert.deepEqual(channelGrantPrincipals(account(), viewer), { members: viewer.members, teams: viewer.teams });
  const html = grants({
    members: principals.members,
    teams: principals.teams,
    value: { publish: { memberIds: [], teamIds: [] }, manage: { memberIds: [me], teamIds: [] } },
  });
  assert.match(html, /Allow Dana to publish/);
  assert.doesNotMatch(html, /Allow Lee|Allow Marketing/);
});

test('sign-in links must be safe and conflict errors explain how to recover', () => {
  assert.equal(
    signInUrl('https://www.linkedin.com/oauth/v2/authorization?x=1'),
    'https://www.linkedin.com/oauth/v2/authorization?x=1',
  );
  assert.throws(() => signInUrl('javascript:alert(1)'));
  assert.throws(() => signInUrl('http://evil.example/authorize'));
  assert.throws(() => signInUrl('https://user:pass@example.com/'));
  assert.match(settingsError(new SocialRequestError(409, 'channel-conflict')), /changed\. Refresh and try again/);
  assert.match(settingsError(new SocialRequestError(409, 'account-conflict')), /changed\. Refresh and try again/);
});
