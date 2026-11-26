import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { connect, fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { lockRolloutTarget } from '../../workspace-storage/src/migrations.ts';
import {
  addManualMemberIdentity,
  identitiesOfMembers,
  listMemberIdentities,
  memberIdentitySchema,
  observeExternalHandle,
  removeManualMemberIdentity,
  resolveMemberIdentities,
  searchMemberIdentities,
  updateManualMemberIdentity,
} from '../src/member-identities.ts';

let db;
let ws;
let legacy;
let runtime;
let legacyRuntime;
let membersTable;

const t = name => qualified(ws.names.schema, name);
const seed = (sql, values) => db.platform.query(sql, values);

before(async () => {
  db = await fixture();
  // The older workspace has to exist before 0120 is published, the same way a pending rollout leaves one behind.
  legacy = await db.create(
    db.baseline.slice(
      0,
      db.baseline.findIndex(item => item.name === '0120_member_identities.sql'),
    ),
  );
  await db.platform.query('BEGIN');
  await lockRolloutTarget(db.platform, db.baseline, true);
  await db.platform.query('COMMIT');
  ws = await db.create();
  runtime = await connect(db.login(ws));
  legacyRuntime = await connect(db.login(legacy));
  membersTable = (await seed(`SELECT table_id FROM ${t('tf_system_tables')} WHERE kind = 'workspace-members'`)).rows[0]
    .table_id;
});

after(async () => {
  await runtime?.end();
  await legacyRuntime?.end();
  await db?.close();
});

async function within(run, { client = runtime, workspace = ws, commonVersion = 120 } = {}) {
  await client.query('BEGIN');
  try {
    const result = await run({ client, schema: workspace.names.schema, commonVersion });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function admit() {
  const person = { membershipId: randomUUID(), userId: randomUUID() };
  await seed(`INSERT INTO ${t('tf_memberships')} (id, user_id, role) VALUES ($1, $2, 'member')`, [
    person.membershipId,
    person.userId,
  ]);
  person.memberId = (
    await seed(`SELECT member_id FROM ${t('tf_workspace_member_accounts')} WHERE membership_id = $1`, [
      person.membershipId,
    ])
  ).rows[0].member_id;
  await seed(`UPDATE ${t('tf_table_identities')} SET live = true WHERE table_id = $1 AND row_id = $2`, [
    membersTable,
    person.memberId,
  ]);
  return person;
}

async function handAdded() {
  const person = { memberId: randomUUID(), membershipId: null };
  await seed(
    `INSERT INTO ${t('tf_table_identities')} (table_id, row_id, token, live) VALUES ($1, $2, gen_random_uuid(), true)`,
    [membersTable, person.memberId],
  );
  return person;
}

const deleteMemberRow = person =>
  seed(`UPDATE ${t('tf_table_identities')} SET live = false WHERE table_id = $1 AND row_id = $2`, [
    membersTable,
    person.memberId,
  ]);

const leave = person =>
  seed(`UPDATE ${t('tf_memberships')} SET removed_at = now() WHERE id = $1`, [person.membershipId]);

async function connectGitHub(person, identity) {
  const id = randomUUID();
  await seed(
    `INSERT INTO ${t('tf_github_accounts')} (id, owner_membership_id, generation, state, config_hash, identity, credential)
    VALUES ($1, $2, 1, 'active', 'config', $3::jsonb, '{}')`,
    [id, person.membershipId, JSON.stringify(identity)],
  );
  return id;
}

async function connectGoogle(person, accountId, email) {
  await seed(
    `INSERT INTO ${t('tf_google_integrations')} (id, user_id, membership_id, generation, status, account_id, email, credential)
    VALUES (gen_random_uuid(), $1, $2, 1, 'connected', $3, $4, '{}')`,
    [person.userId, person.membershipId, accountId, email],
  );
}

async function connectAtlassian(person, protocol, identity) {
  await seed(
    `INSERT INTO ${t('tf_atlassian_accounts')}
      (id, protocol, ownership, owner_membership_id, state, config_hash, identity, credential, expires_at)
    VALUES (gen_random_uuid(), $1, 'personal', $2, 'active', 'config', $3::jsonb, '{}', now() + interval '1 hour')`,
    [protocol, person.membershipId, JSON.stringify(identity)],
  );
}

async function installSlack(teamId) {
  const id = randomUUID();
  await seed(
    `INSERT INTO ${t('tf_slack_installations')}
      (id, app_id, team_id, bot_user_id, generation, state, scopes, bot_credential, accepts_events_after)
    VALUES ($1, 'A0TULIP', $2, 'B0TULIP', 1, 'active', '{}', '{}', 0)`,
    [id, teamId],
  );
  return id;
}

async function authorizeSlack(installationId, person, slackUserId) {
  await seed(
    `INSERT INTO ${t('tf_slack_identities')}
      (id, installation_id, generation, slack_user_id, user_id, membership_id, state, credential)
    VALUES (gen_random_uuid(), $1, 1, $2, $3, $4, 'authorized', '{}')`,
    [installationId, slackUserId, person.userId, person.membershipId],
  );
}

const list = person => within(tx => listMemberIdentities(tx, person.memberId));
const add = (person, input) =>
  within(tx =>
    addManualMemberIdentity(tx, {
      tableId: membersTable,
      memberId: person.memberId,
      createdByMembershipId: ws.membershipId,
      ...input,
    }),
  );
const resolve = query => within(tx => resolveMemberIdentities(tx, query));
const observe = input => within(tx => observeExternalHandle(tx, input));
const brief = identities =>
  identities.map(({ provider, scope, externalId, handle, aliases, trust, conflict }) => ({
    provider,
    scope,
    externalId,
    handle,
    aliases,
    trust,
    conflict,
  }));
const outcome = ({ key, status, memberId, trust }) => ({ key: key.value, status, memberId, trust });

test('connected accounts are verified identities until the account is disconnected or the person leaves', async () => {
  const ada = await admit();
  const github = await connectGitHub(ada, { id: '583231', login: 'octocat' });
  await connectGoogle(ada, '108234567890', 'ada@example.com');
  await connectAtlassian(ada, 'atlassian-rest', { id: '557058:ada', label: 'Ada Lovelace', qualification: 'verified' });
  await connectAtlassian(ada, 'trello', { id: '5f1ada', label: 'Ada L', qualification: 'verified' });
  await connectAtlassian(ada, 'atlassian-mcp', {
    id: '557058:unproven',
    label: 'Unproven',
    qualification: 'grant-bound-needs-qualification',
  });

  const identities = await list(ada);
  const verified = { id: null, memberId: ada.memberId, membershipId: ada.membershipId, aliases: [], trust: 'verified' };
  assert.deepEqual(identities, [
    {
      ...verified,
      provider: 'atlassian',
      providerLabel: 'Atlassian',
      scope: 'atlassian.com',
      externalId: '557058:ada',
      handle: null,
      displayName: 'Ada Lovelace',
      conflict: null,
      profileUrl: null,
      mention: null,
      updatedAt: null,
    },
    {
      ...verified,
      provider: 'github',
      providerLabel: 'GitHub',
      scope: 'github.com',
      externalId: '583231',
      handle: 'octocat',
      displayName: null,
      conflict: null,
      profileUrl: 'https://github.com/octocat',
      mention: '@octocat',
      updatedAt: null,
    },
    {
      ...verified,
      provider: 'google',
      providerLabel: 'Google',
      scope: 'accounts.google.com',
      externalId: '108234567890',
      handle: 'ada@example.com',
      displayName: null,
      conflict: null,
      profileUrl: null,
      mention: 'ada@example.com',
      updatedAt: null,
    },
    {
      ...verified,
      provider: 'trello',
      providerLabel: 'Trello',
      scope: 'trello.com',
      externalId: '5f1ada',
      handle: null,
      displayName: 'Ada L',
      conflict: null,
      profileUrl: null,
      mention: null,
      updatedAt: null,
    },
  ]);
  for (const identity of identities) memberIdentitySchema.parse(identity);

  await seed(`UPDATE ${t('tf_github_accounts')} SET state = 'disconnected', credential = NULL WHERE id = $1`, [github]);
  await seed(
    `UPDATE ${t('tf_google_integrations')} SET status = 'disconnected', credential = NULL WHERE membership_id = $1`,
    [ada.membershipId],
  );
  assert.deepEqual(
    (await list(ada)).map(identity => identity.provider),
    ['atlassian', 'trello'],
  );

  await leave(ada);
  assert.deepEqual(await list(ada), []);
  assert.deepEqual(
    await resolve({ provider: 'atlassian', scope: 'atlassian.com', externalIds: ['557058:ada'] }).then(rows =>
      rows.map(outcome),
    ),
    [{ key: '557058:ada', status: 'unresolved', memberId: null, trust: null }],
  );
});

test('Slack identities are scoped to the installed team, and handles added before Slack is installed use slack', async () => {
  const grace = await admit();
  const early = await add(grace, { provider: 'slack', handle: '@grace' });
  assert.equal(early.scope, 'slack');
  assert.equal(early.mention, '@grace');

  const installation = await installSlack('T0TULIP');
  const hopper = await handAdded();
  const manual = await add(hopper, { provider: 'Slack', externalId: 'U0HOPPER', handle: 'hopper' });
  assert.deepEqual(
    {
      scope: manual.scope,
      membershipId: manual.membershipId,
      mention: manual.mention,
      trust: manual.trust,
      providerLabel: manual.providerLabel,
    },
    { scope: 'T0TULIP', membershipId: null, mention: '<@U0HOPPER>', trust: 'manual', providerLabel: 'Slack' },
  );

  await authorizeSlack(installation, grace, 'U0GRACE');
  const slack = (await list(grace)).filter(identity => identity.trust === 'verified');
  assert.deepEqual(brief(slack), [
    {
      provider: 'slack',
      scope: 'T0TULIP',
      externalId: 'U0GRACE',
      handle: null,
      aliases: [],
      trust: 'verified',
      conflict: null,
    },
  ]);
  assert.equal(slack[0].mention, '<@U0GRACE>');

  assert.equal(
    await observe({ provider: 'slack', scope: 'T0TULIP', externalId: 'U0GRACE', handle: 'grace.h', source: 'webhook' }),
    'recorded',
  );
  const resolutions = await resolve({
    provider: 'slack',
    scope: 'T0TULIP',
    externalIds: ['U0GRACE', 'U0HOPPER', 'U0NOBODY', 'not an id'],
    handles: ['@Grace.H', 'hopper'],
  });
  assert.deepEqual(resolutions.map(outcome), [
    { key: 'U0GRACE', status: 'resolved', memberId: grace.memberId, trust: 'verified' },
    { key: 'U0HOPPER', status: 'resolved', memberId: hopper.memberId, trust: 'manual' },
    { key: 'U0NOBODY', status: 'unresolved', memberId: null, trust: null },
    { key: 'not an id', status: 'unresolved', memberId: null, trust: null },
    { key: '@Grace.H', status: 'resolved', memberId: grace.memberId, trust: 'verified' },
    { key: 'hopper', status: 'resolved', memberId: hopper.memberId, trust: 'manual' },
  ]);
  assert.equal(resolutions[0].membershipId, grace.membershipId);
  assert.equal(resolutions[1].membershipId, null);
});

test('a GitHub rename keeps the old login resolvable and ignores stale or unlinked webhooks', async () => {
  const linus = await admit();
  await connectGitHub(linus, { id: '9001', login: 'linus-old' });
  const github = { provider: 'github', scope: 'github.com', externalId: '9001', source: 'webhook' };

  assert.equal(
    await observe({ ...github, handle: 'linus-new', observedAt: new Date('2026-02-01T00:00:00Z') }),
    'recorded',
  );
  let [identity] = await list(linus);
  assert.deepEqual(
    { handle: identity.handle, aliases: identity.aliases, mention: identity.mention, profileUrl: identity.profileUrl },
    {
      handle: 'linus-new',
      aliases: ['linus-old'],
      mention: '@linus-new',
      profileUrl: 'https://github.com/linus-new',
    },
  );
  assert.deepEqual(
    (await resolve({ provider: 'github', scope: 'github.com', handles: ['@Linus-Old', 'linus-new'] })).map(
      resolution => [resolution.key.value, resolution.status, resolution.memberId, resolution.hits[0]?.via],
    ),
    [
      ['@Linus-Old', 'resolved', linus.memberId, 'alias'],
      ['linus-new', 'resolved', linus.memberId, 'handle'],
    ],
  );

  assert.equal(
    await observe({ ...github, handle: 'linus-new', observedAt: new Date('2026-02-01T00:00:00Z') }),
    'unchanged',
  );
  assert.equal(
    await observe({ ...github, handle: 'linus-older', observedAt: new Date('2026-01-01T00:00:00Z') }),
    'recorded',
  );
  [identity] = await list(linus);
  assert.equal(identity.handle, 'linus-new');
  assert.deepEqual(identity.aliases, ['linus-old', 'linus-older']);

  assert.equal(
    await observe({ ...github, handle: 'Linus-New', observedAt: new Date('2026-03-01T00:00:00Z') }),
    'recorded',
  );
  [identity] = await list(linus);
  assert.equal(identity.handle, 'Linus-New');

  await seed(
    `UPDATE ${t('tf_github_accounts')} SET identity = '{"id":"9001","login":"Linus-New"}' WHERE identity->>'id' = '9001'`,
  );
  [identity] = await list(linus);
  assert.deepEqual(identity.aliases, ['linus-old', 'linus-older']);
  assert.equal(
    (await resolve({ provider: 'github', scope: 'github.com', handles: ['linus-old'] }))[0].memberId,
    linus.memberId,
  );

  assert.equal(await observe({ ...github, externalId: '424242', handle: 'stranger' }), 'unlinked');
  assert.equal(
    (
      await seed(
        `SELECT count(*)::int AS n FROM ${t('tf_member_external_handle_observations')} WHERE external_id = '424242'`,
      )
    ).rows[0].n,
    0,
  );
});

test('people with or without an account can be given handles on any chat app by hand', async () => {
  const kim = await admit();
  const pat = await handAdded();

  const discord = await add(kim, { provider: 'discord', externalId: '80351110224678912', handle: '@kim' });
  assert.equal(discord.membershipId, kim.membershipId);
  assert.equal(discord.mention, '<@80351110224678912>');
  assert.match(discord.id, /^[0-9a-f-]{36}$/);
  assert.match(discord.updatedAt, /^\d{4}-\d\d-\d\dT/);

  await add(pat, { provider: 'telegram', handle: 'pat_on_tg' });
  await add(pat, { provider: 'teams', handle: 'pat@contoso.com', displayName: ' Pat Person ' });
  await add(pat, { provider: 'rocket-chat', handle: 'pat' });
  const identities = await list(pat);
  assert.deepEqual(
    identities.map(({ provider, providerLabel, scope, handle, displayName, membershipId, mention, profileUrl }) => ({
      provider,
      providerLabel,
      scope,
      handle,
      displayName,
      membershipId,
      mention,
      profileUrl,
    })),
    [
      {
        provider: 'rocket-chat',
        providerLabel: 'Rocket Chat',
        scope: 'rocket-chat',
        handle: 'pat',
        displayName: null,
        membershipId: null,
        mention: 'pat',
        profileUrl: null,
      },
      {
        provider: 'teams',
        providerLabel: 'Microsoft Teams',
        scope: 'teams.microsoft.com',
        handle: 'pat@contoso.com',
        displayName: 'Pat Person',
        membershipId: null,
        mention: '@pat@contoso.com',
        profileUrl: null,
      },
      {
        provider: 'telegram',
        providerLabel: 'Telegram',
        scope: 'telegram.org',
        handle: 'pat_on_tg',
        displayName: null,
        membershipId: null,
        mention: '@pat_on_tg',
        profileUrl: 'https://t.me/pat_on_tg',
      },
    ],
  );

  const both = await within(tx => identitiesOfMembers(tx, [kim.memberId, pat.memberId, randomUUID()]));
  assert.deepEqual(
    [...both].map(([memberId, rows]) => [memberId, rows.length]),
    [
      [kim.memberId, 1],
      [pat.memberId, 3],
    ].sort(([a], [b]) => (a < b ? -1 : 1)),
  );

  await assert.rejects(add(pat, { provider: 'google', handle: 'pat@example.com' }), {
    code: 'manual-not-allowed',
    status: 400,
  });
  await assert.rejects(add(pat, { provider: 'x', handle: ' ', externalId: '' }), {
    code: 'identity-incomplete',
    status: 400,
  });
  await assert.rejects(add(pat, { provider: 'x', handle: 'two words' }), { code: 'handle-invalid', status: 400 });
  await assert.rejects(add({ memberId: randomUUID() }, { provider: 'x', handle: 'ghost' }), {
    code: 'member-not-found',
    status: 404,
  });

  await deleteMemberRow(pat);
  assert.deepEqual(await list(pat), []);
  assert.deepEqual(
    (await resolve({ provider: 'telegram', scope: 'telegram.org', handles: ['pat_on_tg'] })).map(outcome),
    [{ key: 'pat_on_tg', status: 'unresolved', memberId: null, trust: null }],
  );
  await assert.rejects(add(pat, { provider: 'x', handle: 'pat' }), { code: 'member-not-found', status: 404 });
});

test('an external ID belongs to one person, and a verified account outranks hand-added claims', async () => {
  const owner = await admit();
  const other = await admit();

  await add(owner, { provider: 'discord', externalId: '1111', handle: 'Owner' });
  await assert.rejects(add(other, { provider: 'discord', externalId: '1111' }), {
    code: 'identity-claimed',
    status: 409,
  });
  await assert.rejects(add(owner, { provider: 'discord', handle: '@owner' }), {
    code: 'identity-claimed',
    status: 409,
  });

  const contractor = await handAdded();
  await add(contractor, { provider: 'discord', externalId: '2222', handle: 'contractor' });
  await assert.rejects(add(other, { provider: 'discord', externalId: '2222' }), {
    code: 'identity-claimed',
    status: 409,
  });
  await deleteMemberRow(contractor);
  const reclaimed = await add(other, { provider: 'discord', externalId: '2222', handle: 'contractor' });
  assert.equal(reclaimed.externalId, '2222');
  assert.equal(reclaimed.memberId, other.memberId);

  await connectGitHub(owner, { id: '7007', login: 'owner7' });
  await assert.rejects(add(other, { provider: 'github', externalId: '7007' }), {
    code: 'identity-claimed',
    status: 409,
  });

  const early = await add(other, { provider: 'github', externalId: '8008', handle: 'owner8' });
  assert.equal(early.conflict, null);
  await connectGitHub(owner, { id: '8008', login: 'owner8' });
  const [claim] = (await list(other)).filter(identity => identity.provider === 'github');
  assert.equal(claim.conflict, 'verified-elsewhere');

  const resolutions = await resolve({
    provider: 'github',
    scope: 'github.com',
    externalIds: ['8008'],
    handles: ['owner8'],
  });
  assert.deepEqual(resolutions.map(outcome), [
    { key: '8008', status: 'resolved', memberId: owner.memberId, trust: 'verified' },
    { key: 'owner8', status: 'resolved', memberId: owner.memberId, trust: 'verified' },
  ]);
  assert.deepEqual(
    resolutions.map(resolution => resolution.hits.map(hit => hit.trust)),
    [['verified'], ['verified']],
  );
});

test('a key that points at two people is ambiguous rather than guessed', async () => {
  const first = await admit();
  const second = await admit();
  const third = await admit();

  await add(first, { provider: 'x', handle: 'sam' });
  await add(second, { provider: 'x', handle: '@Sam' });

  await connectGitHub(first, { id: '31337', login: 'shared-account' });
  await connectGitHub(second, { id: '31337', login: 'shared-account' });

  await connectGitHub(third, { id: '4040', login: 'renamed-away' });
  await observe({ provider: 'github', scope: 'github.com', externalId: '4040', handle: 'third-now', source: 'oauth' });
  await add(first, { provider: 'github', handle: 'renamed-away' });

  const ambiguous = [
    ...(await resolve({ provider: 'x', scope: 'x.com', handles: ['sam'] })),
    ...(await resolve({
      provider: 'github',
      scope: 'github.com',
      externalIds: ['31337'],
      handles: ['shared-account', 'renamed-away'],
    })),
  ];
  assert.deepEqual(
    ambiguous.map(({ key, status, memberId, trust, hits }) => [
      key.value,
      status,
      memberId,
      trust,
      new Set(hits.map(hit => hit.memberId)).size,
    ]),
    [
      ['sam', 'ambiguous', null, null, 2],
      ['31337', 'ambiguous', null, null, 2],
      ['shared-account', 'ambiguous', null, null, 2],
      ['renamed-away', 'ambiguous', null, null, 2],
    ],
  );
});

test('a hand-added identity can be edited and removed by the member it belongs to', async () => {
  const jack = await admit();
  const taken = await admit();
  await add(taken, { provider: 'x', externalId: '12' });
  const created = await add(jack, { provider: 'x', handle: 'jack' });

  const edited = await within(tx =>
    updateManualMemberIdentity(tx, {
      memberId: jack.memberId,
      identityId: created.id,
      handle: '@jack2',
      displayName: 'Jack D',
    }),
  );
  assert.deepEqual(
    {
      handle: edited.handle,
      displayName: edited.displayName,
      profileUrl: edited.profileUrl,
      externalId: edited.externalId,
    },
    { handle: 'jack2', displayName: 'Jack D', profileUrl: 'https://x.com/jack2', externalId: null },
  );
  assert.ok(edited.updatedAt > created.updatedAt);

  const update = input => within(tx => updateManualMemberIdentity(tx, { identityId: created.id, ...input }));
  assert.equal((await update({ memberId: jack.memberId, displayName: null })).displayName, null);
  await assert.rejects(update({ memberId: jack.memberId, handle: null }), { code: 'identity-incomplete' });
  await assert.rejects(update({ memberId: jack.memberId, externalId: '12' }), {
    code: 'identity-claimed',
    status: 409,
  });
  await assert.rejects(update({ memberId: taken.memberId, handle: 'hijack' }), {
    code: 'identity-not-found',
    status: 404,
  });

  const remove = memberId => within(tx => removeManualMemberIdentity(tx, { memberId, identityId: created.id }));
  await assert.rejects(remove(taken.memberId), { code: 'identity-not-found' });
  await remove(jack.memberId);
  assert.deepEqual(await list(jack), []);
  await assert.rejects(remove(jack.memberId), { code: 'identity-not-found' });
});

test('search finds people by current handle, past handle, external ID and display name', async () => {
  const zed = await admit();
  await connectGitHub(zed, { id: '5150', login: 'zephyr-old' });
  await observe({ provider: 'github', scope: 'github.com', externalId: '5150', handle: 'zephyr-new', source: 'oauth' });
  const quinn = await handAdded();
  await add(quinn, { provider: 'teams', handle: 'quinn@contoso.com', displayName: 'Zephyr Quinn' });
  await add(quinn, { provider: 'discord', externalId: 'zephyr%id', handle: 'quinn_100' });

  const search = (needle, options) =>
    within(tx => searchMemberIdentities(tx, needle, options)).then(rows =>
      rows.map(row => [row.provider, row.memberId === zed.memberId ? 'zed' : 'quinn', row.handle]),
    );
  assert.deepEqual(await search('zephyr-new'), [['github', 'zed', 'zephyr-new']]);
  assert.deepEqual(await search('@Zephyr-Old'), [['github', 'zed', 'zephyr-new']]);
  assert.deepEqual(
    new Set((await search('zephyr')).map(row => row.join(':'))),
    new Set(['github:zed:zephyr-new', 'teams:quinn:quinn@contoso.com', 'discord:quinn:quinn_100']),
  );
  assert.deepEqual(await search('zephyr', { provider: 'teams' }), [['teams', 'quinn', 'quinn@contoso.com']]);
  assert.deepEqual(await search('%'), [['discord', 'quinn', 'quinn_100']]);
  assert.deepEqual(await search('n_1'), [['discord', 'quinn', 'quinn_100']]);
  assert.equal((await search('zephyr', { limit: 1 })).length, 1);
  assert.deepEqual(await search('  '), []);
});

test('a workspace still on version 119 reads no identities and refuses to record any', async () => {
  const old = (run, commonVersion = 119) => within(run, { client: legacyRuntime, workspace: legacy, commonVersion });
  const person = { memberId: randomUUID() };

  assert.deepEqual(await old(tx => listMemberIdentities(tx, person.memberId)), []);
  assert.equal((await old(tx => identitiesOfMembers(tx, [person.memberId]))).size, 0);
  assert.deepEqual(await old(tx => searchMemberIdentities(tx, 'anyone')), []);
  assert.deepEqual(
    (
      await old(tx =>
        resolveMemberIdentities(tx, { provider: 'github', scope: 'github.com', externalIds: ['1'], handles: ['a'] }),
      )
    ).map(resolution => resolution.status),
    ['unresolved', 'unresolved'],
  );
  assert.equal(
    await old(tx =>
      observeExternalHandle(tx, {
        provider: 'github',
        scope: 'github.com',
        externalId: '1',
        handle: 'a',
        source: 'webhook',
      }),
    ),
    'unsupported',
  );
  await assert.rejects(
    old(tx =>
      addManualMemberIdentity(tx, {
        tableId: randomUUID(),
        memberId: person.memberId,
        createdByMembershipId: legacy.membershipId,
        provider: 'x',
        handle: 'a',
      }),
    ),
    { code: 'unsupported', status: 503 },
  );
  await assert.rejects(
    old(tx => listMemberIdentities(tx, person.memberId), 120),
    { code: '42P01' },
  );
});
