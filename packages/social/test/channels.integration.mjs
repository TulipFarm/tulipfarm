import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { connect, denied, fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { createSocialAccounts } from '../dist/accounts.js';
import { createSocialChannels } from '../dist/channels.js';
import { channelSchema, discoveredChannelSchema } from '../dist/contracts.js';
import { createPlatformApps, operatorPlatformApps } from '../dist/platform-apps.js';
import { createFakeAdapter } from '../dist/platforms/fake.js';

const callbackUrl = 'https://api.example.test/v1/social/oauth/callback';
const keyring = { activeKeyId: 'test', keys: { test: 'ef'.repeat(32) } };
const session = 'test-session';
const operator = (prefix, tier) => ({
  [`${prefix}_CLIENT_ID`]: `${prefix}-client`,
  [`${prefix}_CLIENT_SECRET`]: 'operator-secret',
  [`${prefix}_REDIRECT_URI`]: callbackUrl,
  [`${prefix}_ACCESS_TIER`]: tier,
});
const env = { ...operator('SOCIAL_LINKEDIN', 'community-management'), ...operator('SOCIAL_REDDIT', 'paid') };
const code = expected => error => error?.code === expected;
const deniedAccess = error => error?.message === 'Resource not found';
const none = { memberIds: [], teamIds: [] };

const profile = {
  platformChannelId: 'urn:li:person:founder',
  channelKind: 'member-profile',
  displayName: 'Founder',
  handle: 'founder',
  avatarUrl: null,
};
const page = {
  platformChannelId: 'urn:li:organization:42',
  channelKind: 'organization-page',
  displayName: 'Brand',
  handle: null,
  avatarUrl: 'https://media.example.test/brand.png',
};
const redditUser = {
  platformChannelId: 't2_brand',
  channelKind: 'reddit-user',
  displayName: 'u/brand',
  handle: 'brand',
  avatarUrl: null,
};

let db;
let ws;
let runtime;
let raw;
let member;
let other;
let teamId;

const table = name => qualified(ws.names.schema, name);
const admin = () => ({ userId: ws.userId, membershipId: ws.membershipId });

function adapters({ targetRules = true } = {}) {
  const make = (platform, channels) => {
    const adapter = createFakeAdapter({ platform, refreshPolicy: 'refresh-token', scopes: () => ['fake.publish'] })
      .fallback('exchangeCode', {
        accessToken: `${platform}-access`,
        refreshToken: `${platform}-refresh`,
        expiresAt: new Date(Date.now() + 3_600_000),
        scopes: ['fake.publish'],
      })
      .fallback('identity', { platformUserId: `${platform}-person`, handle: 'person', displayName: 'Person' })
      .fallback('listChannels', channels)
      .fallback('targetRules', { postingAllowed: true, flairRequired: false, flairIds: [] });
    if (!targetRules) delete adapter.targetRules;
    return adapter;
  };
  return {
    linkedin: make('linkedin', [
      profile,
      page,
      // Not a LinkedIn channel kind, and malformed: neither is offered.
      { ...redditUser, platformChannelId: 'wrong-kind' },
      { platformChannelId: '', channelKind: 'organization-page', displayName: 'x', handle: null, avatarUrl: null },
    ]),
    reddit: make('reddit', [redditUser]),
  };
}

function service(options = {}) {
  const platforms = adapters(options);
  const platformApps = createPlatformApps({ operator: operatorPlatformApps(env), callbackUrl });
  const accounts = createSocialAccounts({ runtime, keyring, platformApps, adapters: platforms });
  const channels = createSocialChannels({
    runtime,
    accounts,
    adapters: platforms,
    agentPermission: options.agentPermission,
  });
  const connectAccount = async (input, user = admin().userId) => {
    const started = await accounts.begin(ws.id, user, session, { ownership: { kind: 'personal' }, ...input });
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    await accounts.complete('platform-code', state, session, user);
    return started.attemptId;
  };
  const shared = (platform = 'linkedin') =>
    connectAccount({ platform, ownership: { kind: 'business', owningTeamId: teamId } }, member.userId);
  const reconnect = async (id, user) => {
    const started = await accounts.reconnect(ws.id, user, session, id);
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    return accounts.complete('platform-code-2', state, session, user);
  };
  const add = (user, accountId, platformChannelId, expectedAccountGeneration = 1) =>
    channels.add(ws.id, user, { accountId, expectedAccountGeneration, platformChannelId });
  const grant = async (user, channel, grants) =>
    channels.setGrants(ws.id, user, channel.id, {
      expectedVersion: (await channels.get(ws.id, user, channel.id)).version,
      publish: none,
      analytics: none,
      engagement: none,
      ...grants,
    });
  return { accounts, channels, platforms, connect: connectAccount, shared, reconnect, add, grant };
}

async function savedAgent(sponsor, permissions = ['invoke']) {
  const agent = randomUUID();
  const revision = 'b'.repeat(64);
  const soul = randomUUID().replaceAll('-', '').padEnd(40, '0').slice(0, 40);
  const command = randomUUID();
  await db.platform.query(`INSERT INTO ${table('tf_agents')} (id) VALUES ($1)`, [agent]);
  await db.platform.query(`INSERT INTO ${table('tf_agent_definitions')} VALUES ($1,$2,'{}')`, [agent, revision]);
  await db.platform.query(
    `INSERT INTO ${table('tf_agent_commands')} (id,agent_id,membership_id,user_id,request_id,input) VALUES ($1,$2,$3,$4,$5,'{}')`,
    [command, agent, ws.membershipId, ws.userId, randomUUID()],
  );
  await db.platform.query(
    `INSERT INTO ${table('tf_soul_revisions')} (revision,agent_command_id,bundle_key,bundle_sha256) VALUES ($1,$2,'k','s')`,
    [soul, command],
  );
  await db.platform.query(
    `INSERT INTO ${table('tf_agent_saved_revisions')} (agent_id,soul_revision,definition_revision,projection) VALUES ($1,$2,$3,'{}')`,
    [agent, soul, revision],
  );
  await db.platform.query(`UPDATE ${table('tf_agents')} SET saved_revision=$2, display_name='Agent' WHERE id=$1`, [
    agent,
    soul,
  ]);
  for (const permission of permissions)
    await db.platform.query(
      `INSERT INTO ${table('tf_agent_person_grants')} (agent_id,membership_id,permission) VALUES ($1,$2,$3)`,
      [agent, sponsor.membershipId, permission],
    );
  return agent;
}

before(async () => {
  db = await fixture();
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    maxPools: 2,
    connectionsPerPool: 4,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async id => {
      const workspace = db.workspaces.find(candidate => candidate.id === id);
      if (!workspace) throw new Error('unknown-workspace');
      return { workspaceId: id, generation: 1, connectionString: db.login(workspace) };
    },
  });
});

// `member` is in the Marketing team and owns shared connections; `other` is a member outside it.
beforeEach(async () => {
  ws = await db.create();
  raw = await connect(db.login(ws));
  member = { userId: randomUUID(), membershipId: randomUUID() };
  other = { userId: randomUUID(), membershipId: randomUUID() };
  teamId = randomUUID();
  for (const person of [member, other])
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      person.membershipId,
      person.userId,
    ]);
  await db.platform.query(`INSERT INTO ${table('tf_teams')} (id,name) VALUES ($1,'Marketing')`, [teamId]);
  await db.platform.query(`INSERT INTO ${table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
    member.membershipId,
    teamId,
  ]);
});

afterEach(async () => {
  await raw?.end();
});

after(async () => {
  await runtime?.close();
  await db?.close();
});

test('exit check, PRODUCT 10: adding a channel needs manage on its connection; discovery adds none', async () => {
  const { accounts, channels, platforms, shared, add } = service();
  const accountId = await shared();
  const account = await accounts.status(ws.id, member.userId, accountId);
  // `other` may use the connection, but not manage it.
  await accounts.setGrants(ws.id, member.userId, accountId, {
    expectedVersion: account.grantsVersion,
    memberIds: [member.membershipId, other.membershipId],
    teamIds: [],
  });
  await assert.rejects(channels.discover(ws.id, other.userId, accountId), deniedAccess);
  await assert.rejects(add(other.userId, accountId, page.platformChannelId), deniedAccess);
  await assert.rejects(channels.discover(ws.id, admin().userId, accountId), deniedAccess, 'admin is not a manager');

  const discovered = await channels.discover(ws.id, member.userId, accountId);
  assert.deepEqual(discovered, [profile, page]);
  for (const item of discovered) discoveredChannelSchema.parse(item);
  assert.equal(platforms.linkedin.calls.filter(call => call.method === 'listChannels').length, 1);
  assert.equal((await db.platform.query(`SELECT 1 FROM ${table('tf_social_channels')}`)).rowCount, 0);
  assert.deepEqual(await channels.list(ws.id, member.userId), []);

  await assert.rejects(add(member.userId, accountId, 'urn:li:organization:unreachable'), code('channel-unreachable'));
  await assert.rejects(add(member.userId, accountId, 'wrong-kind'), code('channel-unreachable'));
  await assert.rejects(add(member.userId, accountId, page.platformChannelId, 2), code('account-conflict'));
  const channel = await add(member.userId, accountId, page.platformChannelId);
  channelSchema.parse(channel);
  assert.equal(channel.channelKind, 'organization-page');
  assert.equal(channel.accountGeneration, 1);
  assert.equal(channel.version, 1);
  assert.equal(channel.engagementPolicy, 'approve-each');
  await assert.rejects(add(member.userId, accountId, page.platformChannelId), code('channel-conflict'));
  assert.equal((await db.platform.query(`SELECT 1 FROM ${table('tf_social_channels')}`)).rowCount, 1);
  const audit = await db.platform.query(`SELECT operation FROM ${table('tf_audit_events')} WHERE subject_id=$1`, [
    channel.id,
  ]);
  assert.deepEqual(
    audit.rows.map(row => row.operation),
    ['social-channel.add'],
  );
});

test('exit check, PRODUCT 10: reaching a channel grants nothing, not even to the one who added it', async () => {
  const { accounts, channels, shared, add } = service();
  const accountId = await shared();
  const account = await accounts.status(ws.id, member.userId, accountId);
  await accounts.setGrants(ws.id, member.userId, accountId, {
    expectedVersion: account.grantsVersion,
    memberIds: [member.membershipId, other.membershipId],
    teamIds: [teamId],
  });
  const channel = await add(member.userId, accountId, page.platformChannelId);
  // The adder holds only `manage`; nothing else follows from reaching or adding the channel.
  assert.deepEqual(channel.grants, {
    publish: none,
    analytics: none,
    engagement: none,
    manage: { memberIds: [member.membershipId], teamIds: [] },
  });
  for (const permission of ['publish', 'analytics', 'engagement'])
    await assert.rejects(channels.authorize(ws.id, member.userId, channel.id, permission), deniedAccess, permission);
  assert.equal((await channels.authorize(ws.id, member.userId, channel.id, 'manage')).channel.id, channel.id);
  // A user of the connection with no channel grant cannot see or use the channel.
  for (const permission of ['publish', 'analytics', 'engagement', 'manage'])
    await assert.rejects(channels.authorize(ws.id, other.userId, channel.id, permission), deniedAccess, permission);
  await assert.rejects(channels.get(ws.id, other.userId, channel.id), deniedAccess);
  assert.deepEqual(await channels.list(ws.id, other.userId), []);
  assert.deepEqual(
    (await channels.list(ws.id, member.userId)).map(item => item.id),
    [channel.id],
  );
});

test('PRODUCT 11: publishing, analytics, engagement and management are each granted separately to members and teams', async () => {
  const { accounts, channels, shared, add, grant } = service();
  const accountId = await shared();
  const account = await accounts.status(ws.id, member.userId, accountId);
  await accounts.setGrants(ws.id, member.userId, accountId, {
    expectedVersion: account.grantsVersion,
    memberIds: [member.membershipId, other.membershipId],
    teamIds: [],
  });
  const channel = await add(member.userId, accountId, page.platformChannelId);
  const updated = await grant(member.userId, channel, {
    publish: { memberIds: [other.membershipId], teamIds: [] },
    analytics: { memberIds: [], teamIds: [teamId] },
    manage: { memberIds: [member.membershipId], teamIds: [] },
  });
  assert.equal(updated.version, 2);
  const allowed = async (user, permission) =>
    channels.authorize(ws.id, user, channel.id, permission).then(
      () => true,
      error => {
        if (deniedAccess(error)) return false;
        throw error;
      },
    );
  const matrix = async user =>
    Object.fromEntries(
      await Promise.all(
        ['publish', 'analytics', 'engagement', 'manage'].map(async permission => [
          permission,
          await allowed(user, permission),
        ]),
      ),
    );
  assert.deepEqual(await matrix(other.userId), { publish: true, analytics: false, engagement: false, manage: false });
  // Analytics through the team; publishing was not granted to the team.
  assert.deepEqual(await matrix(member.userId), { publish: false, analytics: true, engagement: false, manage: true });
  const result = await channels.authorize(ws.id, other.userId, channel.id, 'publish');
  assert.equal(result.sponsorMembershipId, other.membershipId);
  assert.equal(result.agentId, null);
  assert.deepEqual(result.account, { id: accountId, platform: 'linkedin', generation: 1, grantsVersion: 2 });

  // Channel use also needs `use` on the shared connection; a channel grant alone is not enough.
  await accounts.setGrants(ws.id, member.userId, accountId, {
    expectedVersion: 2,
    memberIds: [member.membershipId],
    teamIds: [],
  });
  assert.equal(await allowed(other.userId, 'publish'), false);

  // Only a channel manager edits grants, and at least one active manager remains.
  await assert.rejects(
    grant(other.userId, channel, { manage: { memberIds: [other.membershipId], teamIds: [] } }),
    deniedAccess,
  );
  await assert.rejects(grant(member.userId, channel, { manage: none }), error => error?.name === 'ZodError');
  await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [other.membershipId]);
  await assert.rejects(
    grant(member.userId, channel, { manage: { memberIds: [other.membershipId], teamIds: [] } }),
    deniedAccess,
    'a removed member cannot be granted anything',
  );
  await grant(member.userId, channel, { manage: { memberIds: [member.membershipId], teamIds: [teamId] } });
  await db.platform.query(`DELETE FROM ${table('tf_member_teams')} WHERE team_id=$1`, [teamId]);
  await assert.rejects(
    grant(member.userId, channel, { manage: { memberIds: [], teamIds: [teamId] } }),
    code('grants-invalid'),
    'a team with no active members leaves no manager',
  );
  await db.platform.query(`INSERT INTO ${table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
    member.membershipId,
    teamId,
  ]);
  // A team the editor is not in cannot be added.
  const outsideTeam = randomUUID();
  await db.platform.query(`INSERT INTO ${table('tf_teams')} (id,name) VALUES ($1,'Sales')`, [outsideTeam]);
  await assert.rejects(
    grant(member.userId, channel, {
      publish: { memberIds: [], teamIds: [outsideTeam] },
      manage: { memberIds: [member.membershipId], teamIds: [] },
    }),
    deniedAccess,
  );
});

test('exit check, PRODUCT 11: grants are checked against the channel version', async () => {
  const { accounts, channels, connect: connectAccount, add, grant } = service();
  const accountId = await connectAccount({ platform: 'linkedin' });
  const channel = await add(admin().userId, accountId, profile.platformChannelId);
  const granted = await grant(admin().userId, channel, {
    publish: { memberIds: [admin().membershipId], teamIds: [] },
    manage: { memberIds: [admin().membershipId], teamIds: [] },
  });
  assert.equal(granted.version, channel.version + 1);
  const read = await channels.authorize(ws.id, admin().userId, channel.id, 'publish', {
    channelVersion: granted.version,
    accountGeneration: 1,
    accountGrantsVersion: 1,
  });
  assert.equal(read.channel.version, granted.version);

  // A grant edit made from a stale read is refused, and nothing changes.
  await assert.rejects(
    channels.setGrants(ws.id, admin().userId, channel.id, {
      expectedVersion: channel.version,
      publish: none,
      analytics: none,
      engagement: none,
      manage: { memberIds: [admin().membershipId], teamIds: [] },
    }),
    code('channel-conflict'),
  );
  assert.deepEqual((await channels.get(ws.id, admin().userId, channel.id)).grants, granted.grants);

  // Work bound to an older version stops once the grants change, even when the caller still holds them.
  const regranted = await grant(admin().userId, channel, {
    publish: { memberIds: [admin().membershipId], teamIds: [] },
    analytics: { memberIds: [admin().membershipId], teamIds: [] },
    manage: { memberIds: [admin().membershipId], teamIds: [] },
  });
  await assert.rejects(
    channels.authorize(ws.id, admin().userId, channel.id, 'publish', { channelVersion: granted.version }),
    code('channel-conflict'),
  );
  await channels.authorize(ws.id, admin().userId, channel.id, 'publish', { channelVersion: regranted.version });
  await assert.rejects(
    channels.authorize(ws.id, admin().userId, channel.id, 'publish', { accountGrantsVersion: 2 }),
    code('account-conflict'),
  );
  await assert.rejects(
    channels.authorize(ws.id, admin().userId, channel.id, 'publish', { accountGeneration: 2 }),
    code('account-reconnect-required'),
  );
  assert.deepEqual((await accounts.status(ws.id, admin().userId, accountId)).generation, 1);
});

test('PRODUCT 11: an agent uses a channel only through its sponsor’s grants, within the agent permission limits', async () => {
  const { channels, connect: connectAccount, add, grant } = service();
  const accountId = await connectAccount({ platform: 'linkedin' });
  const channel = await add(admin().userId, accountId, profile.platformChannelId);
  const agentId = await savedAgent(admin());
  const agent = (sponsor = admin().userId, id = agentId) => ({ kind: 'agent', agentId: id, sponsor });

  // The sponsor holds only `manage`, so the agent cannot publish.
  await assert.rejects(channels.authorize(ws.id, agent(), channel.id, 'publish'), deniedAccess);
  await grant(admin().userId, channel, {
    publish: { memberIds: [admin().membershipId], teamIds: [] },
    manage: { memberIds: [admin().membershipId], teamIds: [] },
  });
  const result = await channels.authorize(ws.id, agent(), channel.id, 'publish');
  assert.equal(result.sponsorMembershipId, admin().membershipId);
  assert.equal(result.agentId, agentId);
  // Never `manage`, even when the sponsor holds it.
  await assert.rejects(channels.authorize(ws.id, agent(), channel.id, 'manage'), deniedAccess);
  // No other grant reaches it: analytics was not granted to the sponsor.
  await assert.rejects(channels.authorize(ws.id, agent(), channel.id, 'analytics'), deniedAccess);
  // The sponsor must be allowed to invoke the agent.
  const notInvokable = await savedAgent(admin(), ['read']);
  await assert.rejects(
    channels.authorize(ws.id, agent(admin().userId, notInvokable), channel.id, 'publish'),
    deniedAccess,
  );
  // Another sponsor without the channel grant gets nothing from the agent.
  await db.platform.query(
    `INSERT INTO ${table('tf_agent_person_grants')} (agent_id,membership_id,permission) VALUES ($1,$2,'invoke')`,
    [agentId, other.membershipId],
  );
  await assert.rejects(channels.authorize(ws.id, agent(other.userId), channel.id, 'publish'), deniedAccess);
  // A removed sponsor stops the agent.
  await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [other.membershipId]);
  await assert.rejects(channels.authorize(ws.id, agent(other.userId), channel.id, 'publish'));

  // The composition may supply the agents domain's own limits; they are applied to the sponsor.
  const limits = [];
  const limited = service({
    agentPermission: async (_tx, sponsor, id) => {
      limits.push([sponsor.membershipId, id]);
      if (id === agentId) throw Object.assign(new Error('Resource not found'), { name: 'AccessDenied' });
    },
  });
  await assert.rejects(limited.channels.authorize(ws.id, agent(), channel.id, 'publish'), deniedAccess);
  assert.deepEqual(limits, [[admin().membershipId, agentId]]);
});

test('PRODUCT 9: a personal connection and its channels belong to one membership', async () => {
  const { accounts, channels, connect: connectAccount, add, grant } = service();
  const accountId = await connectAccount({ platform: 'linkedin' });
  await assert.rejects(accounts.grants(ws.id, admin().userId, accountId), deniedAccess);
  await assert.rejects(
    accounts.setGrants(ws.id, admin().userId, accountId, { expectedVersion: 1, memberIds: [], teamIds: [] }),
    deniedAccess,
  );
  await assert.rejects(channels.discover(ws.id, member.userId, accountId), deniedAccess);
  await assert.rejects(add(member.userId, accountId, profile.platformChannelId), deniedAccess);
  const channel = await add(admin().userId, accountId, profile.platformChannelId);
  for (const grants of [
    { publish: { memberIds: [member.membershipId], teamIds: [] } },
    { analytics: { memberIds: [], teamIds: [teamId] } },
    { manage: { memberIds: [admin().membershipId, member.membershipId], teamIds: [] } },
  ])
    await assert.rejects(
      grant(admin().userId, channel, { manage: { memberIds: [admin().membershipId], teamIds: [] }, ...grants }),
      code('grants-invalid'),
    );
  const owned = await grant(admin().userId, channel, {
    publish: { memberIds: [admin().membershipId], teamIds: [] },
    manage: { memberIds: [admin().membershipId], teamIds: [] },
  });
  assert.equal(owned.version, 2);
  // A channel grant row naming someone else, however it got there, gives them nothing.
  await db.platform.query(
    `INSERT INTO ${table('tf_social_channel_grants')} (channel_id,permission,membership_id) VALUES ($1,'publish',$2)`,
    [channel.id, member.membershipId],
  );
  await assert.rejects(channels.authorize(ws.id, member.userId, channel.id, 'publish'), deniedAccess);
});

test('PRODUCT 9: a shared connection has separate grants to use and to manage it', async () => {
  const { accounts, channels, shared } = service();
  const accountId = await shared();
  assert.deepEqual(await accounts.grants(ws.id, member.userId, accountId), {
    expectedVersion: 1,
    memberIds: [member.membershipId],
    teamIds: [],
    managers: { memberIds: [member.membershipId], teamIds: [] },
  });
  await assert.rejects(accounts.grants(ws.id, other.userId, accountId), deniedAccess);
  await assert.rejects(
    accounts.setGrants(ws.id, member.userId, accountId, { expectedVersion: 2, memberIds: [], teamIds: [] }),
    code('account-conflict'),
  );
  const updated = await accounts.setGrants(ws.id, member.userId, accountId, {
    expectedVersion: 1,
    memberIds: [other.membershipId],
    teamIds: [teamId],
  });
  assert.equal(updated.grantsVersion, 2);
  // Managers are kept when not given; `use` was replaced.
  assert.deepEqual(updated.capabilities, { read: true, use: true, manage: true });
  const user = await accounts.status(ws.id, other.userId, accountId);
  assert.deepEqual(user.capabilities, { read: true, use: true, manage: false });
  await assert.rejects(
    accounts.setGrants(ws.id, other.userId, accountId, { expectedVersion: 2, memberIds: [], teamIds: [] }),
    deniedAccess,
  );
  await assert.rejects(channels.discover(ws.id, other.userId, accountId), deniedAccess);

  // Managing is granted separately from using.
  await accounts.setGrants(ws.id, member.userId, accountId, {
    expectedVersion: 2,
    memberIds: [member.membershipId],
    teamIds: [],
    managers: { memberIds: [other.membershipId], teamIds: [] },
  });
  assert.deepEqual((await accounts.status(ws.id, other.userId, accountId)).capabilities, {
    read: true,
    use: false,
    manage: true,
  });
  assert.deepEqual((await accounts.status(ws.id, member.userId, accountId)).capabilities, {
    read: true,
    use: true,
    manage: false,
  });
  assert.equal((await channels.discover(ws.id, other.userId, accountId)).length, 2);

  // At least one active manager remains.
  await assert.rejects(
    accounts.setGrants(ws.id, other.userId, accountId, {
      expectedVersion: 3,
      memberIds: [],
      teamIds: [],
      managers: none,
    }),
    code('grants-invalid'),
  );
  // An editor who removes their own access still learns the new version.
  const handedOver = await accounts.setGrants(ws.id, other.userId, accountId, {
    expectedVersion: 3,
    memberIds: [],
    teamIds: [],
    managers: { memberIds: [member.membershipId], teamIds: [] },
  });
  assert.equal(handedOver.grantsVersion, 4);
  assert.deepEqual(handedOver.capabilities, { read: false, use: false, manage: false });
  const operations = await db.platform.query(
    `SELECT operation FROM ${table('tf_audit_events')} WHERE subject_id=$1 AND operation='social-account.grants'`,
    [accountId],
  );
  assert.equal(operations.rowCount, 3);
});

test('PRODUCT 8 and 10: a reconnect stops channels bound to the old generation until a manager adds them again', async () => {
  const { channels, connect: connectAccount, reconnect, add, grant } = service();
  const accountId = await connectAccount({ platform: 'linkedin' });
  const channel = await add(admin().userId, accountId, profile.platformChannelId);
  const granted = await grant(admin().userId, channel, {
    publish: { memberIds: [admin().membershipId], teamIds: [] },
    manage: { memberIds: [admin().membershipId], teamIds: [] },
  });
  await reconnect(accountId, admin().userId);
  await assert.rejects(
    channels.authorize(ws.id, admin().userId, channel.id, 'publish'),
    code('account-reconnect-required'),
  );
  // Managers can still see it to add it again.
  assert.equal((await channels.authorize(ws.id, admin().userId, channel.id, 'manage')).channel.accountGeneration, 1);
  await assert.rejects(add(admin().userId, accountId, profile.platformChannelId, 1), code('account-conflict'));
  const rebound = await add(admin().userId, accountId, profile.platformChannelId, 2);
  assert.equal(rebound.id, channel.id);
  assert.equal(rebound.accountGeneration, 2);
  assert.equal(rebound.version, granted.version + 1);
  assert.deepEqual(rebound.grants, granted.grants);
  await assert.rejects(
    channels.authorize(ws.id, admin().userId, channel.id, 'publish', { channelVersion: granted.version }),
    code('channel-conflict'),
  );
  await channels.authorize(ws.id, admin().userId, channel.id, 'publish', { channelVersion: rebound.version });
});

test('PRODUCT 12: a post target is chosen per post and checked against the target’s live rules', async () => {
  const { channels, platforms, connect: connectAccount, add, grant } = service();
  const linkedinId = await connectAccount({ platform: 'linkedin' });
  const redditId = await connectAccount({ platform: 'reddit' });
  const linkedin = await add(admin().userId, linkedinId, profile.platformChannelId);
  const reddit = await add(admin().userId, redditId, redditUser.platformChannelId);
  // A channel never carries a target.
  assert.equal('target' in reddit, false);
  const columns = await db.platform.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='tf_social_channels'`,
    [ws.names.schema],
  );
  assert.equal(
    columns.rows.some(row => row.column_name.includes('target')),
    false,
  );
  const subreddit = { kind: 'subreddit', name: 'startups' };
  // Checking a target is part of publishing, so it needs `publish`.
  await assert.rejects(channels.checkTarget(ws.id, admin().userId, reddit.id, subreddit), deniedAccess);
  for (const channel of [linkedin, reddit])
    await grant(admin().userId, channel, {
      publish: { memberIds: [admin().membershipId], teamIds: [] },
      manage: { memberIds: [admin().membershipId], teamIds: [] },
    });
  const check = (channel, target) => channels.checkTarget(ws.id, admin().userId, channel.id, target);
  assert.deepEqual(await check(linkedin, null), []);
  assert.deepEqual(await check(linkedin, subreddit), [{ path: ['target'], code: 'target-not-allowed' }]);
  assert.deepEqual(await check(reddit, null), [{ path: ['target'], code: 'target-required' }]);
  assert.deepEqual(await check(reddit, { kind: 'board', boardId: 'b1' }), [
    { path: ['target'], code: 'target-kind-mismatch' },
  ]);
  assert.deepEqual(await check(reddit, subreddit), []);
  // Each check reads the rules live, so a change between preparing and publishing is seen.
  platforms.reddit.script(
    'targetRules',
    { postingAllowed: false, flairRequired: false, flairIds: [] },
    { postingAllowed: true, flairRequired: true, flairIds: ['f1'] },
    { postingAllowed: true, flairRequired: true, flairIds: ['f1'] },
    { postingAllowed: true, flairRequired: true, flairIds: ['f1'] },
  );
  assert.deepEqual(await check(reddit, subreddit), [{ path: ['target'], code: 'target-posting-not-allowed' }]);
  assert.deepEqual(await check(reddit, subreddit), [{ path: ['target', 'flairId'], code: 'flair-required' }]);
  assert.deepEqual(await check(reddit, { ...subreddit, flairId: 'f2' }), [
    { path: ['target', 'flairId'], code: 'flair-not-allowed' },
  ]);
  assert.deepEqual(await check(reddit, { ...subreddit, flairId: 'f1' }), []);
  const asked = platforms.reddit.calls.filter(call => call.method === 'targetRules');
  assert.equal(asked.length, 5);
  assert.deepEqual(asked.at(-1).args[1], { ...subreddit, flairId: 'f1' });
  assert.equal(asked.at(-1).args[2].accessToken, 'reddit-access');

  // Without the adapter's live rules the target cannot be checked, so it is refused.
  const unchecked = service({ targetRules: false });
  assert.deepEqual(await unchecked.channels.checkTarget(ws.id, admin().userId, reddit.id, subreddit), [
    { path: ['target'], code: 'target-rules-unavailable' },
  ]);
});

test('PRODUCT 10: the runtime role cannot move a channel to another connection or platform channel', async () => {
  const { connect: connectAccount, add } = service();
  const accountId = await connectAccount({ platform: 'linkedin' });
  const channel = await add(admin().userId, accountId, profile.platformChannelId);
  for (const column of [
    `account_id='${randomUUID()}'`,
    "platform_channel_id='other'",
    "platform='x'",
    "channel_kind='x-account'",
  ])
    await denied(raw, `UPDATE ${table('tf_social_channels')} SET ${column} WHERE id=$1`, [channel.id]);
  await denied(raw, `DELETE FROM ${table('tf_social_channels')} WHERE id=$1`, [channel.id]);
});
