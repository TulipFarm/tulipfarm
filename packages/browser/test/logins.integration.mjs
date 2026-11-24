import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { commonCompatibility, createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { BrowserLoginError, createBrowserLogins } from '../dist/logins.js';

const keyring = { activeKeyId: 'test', keys: { test: 'ab'.repeat(32) } };
const code = code => error => error instanceof BrowserLoginError && error.code === code;
const denied = error => error instanceof AccessDenied;
const state = value => ({
  cookies: [
    {
      name: 'session',
      value,
      domain: '.shop.example',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ],
  origins: [{ origin: 'https://shop.example', localStorage: [{ name: 'cart', value: '3' }] }],
});

test('browser logins', async t => {
  const db = await fixture();
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const stream = await workspaceTableMigrations();
  assert.equal(stream.length, commonCompatibility.maximum);
  const workspace = await db.create(stream);
  const table = name => qualified(workspace.names.schema, name);
  const runtime = createWorkspaceRuntime({
    replicaCount: 1,
    maxPools: 2,
    connectionsPerPool: 4,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(workspace) }),
  });
  t.after(async () => {
    await runtime.close();
    await db.close();
  });
  const members = [];
  for (let index = 0; index < 3; index++) {
    const member = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      member.membershipId,
      member.userId,
    ]);
    members.push(member);
  }
  const [ana, ben, cy] = members;
  const admin = { kind: 'human', userId: workspace.userId, membershipId: workspace.membershipId };
  const ws = workspace.id;
  const logins = createBrowserLogins({ runtime, keyring });

  await t.test('stores the state encrypted and gives it back only to those who can use it', async () => {
    const saved = await logins.save(ws, ana, { name: 'Shop', site: 'shop.example' }, state('cookie-synthetic'));
    assert.equal(saved.status, 'active');
    assert.equal(saved.canManage, true);
    const dump = await db.platform.query(`SELECT row_to_json(l)::text AS row FROM ${table('tf_browser_logins')} l`);
    assert.equal(
      dump.rows.some(row => row.row.includes('cookie-synthetic')),
      false,
    );
    const used = await logins.use(ws, ana, saved.id);
    assert.equal(used.state.cookies[0].value, 'cookie-synthetic');
    assert.equal(used.site, 'shop.example');
    await assert.rejects(logins.use(ws, ben, saved.id), denied);
    await assert.rejects(logins.use(ws, admin, saved.id), denied, 'workspace admins get no implicit use');
    assert.deepEqual(await logins.list(ws, ben), []);
    assert.equal((await logins.list(ws, ana, { site: 'www.shop.example' })).length, 1, 'www. is the same site');
    assert.equal((await logins.list(ws, ana, { site: 'checkout.shop.example' })).length, 1);
    assert.equal((await logins.list(ws, ana, { site: 'other.example' })).length, 0);
  });

  await t.test('sharing with a member, a team or the workspace allows use; only the owner names managers', async () => {
    const saved = await logins.save(ws, ana, { name: 'Team shop', site: 'shop.example' }, state('shared'));
    const team = randomUUID();
    await db.platform.query(`INSERT INTO ${table('tf_teams')} (id,name) VALUES ($1,'Growth')`, [team]);
    await db.platform.query(`INSERT INTO ${table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
      cy.membershipId,
      team,
    ]);
    const shared = await logins.share(ws, ana, saved.id, {
      grants: [
        { grantee: { kind: 'member', membershipId: ben.membershipId }, role: 'manage' },
        { grantee: { kind: 'team', teamId: team }, role: 'use' },
      ],
    });
    assert.equal(shared.grants.length, 2);
    assert.ok(await logins.use(ws, ben, saved.id));
    assert.ok(await logins.use(ws, cy, saved.id));
    const seen = (await logins.list(ws, cy)).find(login => login.id === saved.id);
    assert.equal(seen.canManage, false);
    assert.deepEqual(seen.grants, [], 'only managers see whom a login is shared with');
    await assert.rejects(logins.rename(ws, cy, saved.id, 'Mine'), denied);
    await assert.rejects(
      logins.share(ws, ben, saved.id, {
        grants: [
          { grantee: { kind: 'member', membershipId: ben.membershipId }, role: 'manage' },
          { grantee: { kind: 'member', membershipId: cy.membershipId }, role: 'manage' },
        ],
      }),
      denied,
    );
    await assert.rejects(
      logins.share(ws, ana, saved.id, { grants: [{ grantee: { kind: 'workspace' }, role: 'manage' }] }),
      code('invalid-input'),
    );
    assert.equal((await logins.rename(ws, ben, saved.id, 'Shop (team)')).name, 'Shop (team)');
    await logins.share(ws, ana, saved.id, { grants: [{ grantee: { kind: 'workspace' }, role: 'use' }] });
    assert.ok(await logins.use(ws, admin, saved.id));
    await assert.rejects(
      logins.rename(ws, ben, saved.id, 'x'),
      denied,
      'a manager removed from the grants can no longer manage',
    );
  });

  await t.test('saving back refreshes the state, and signing out keeps it but asks for a new sign-in', async () => {
    const saved = await logins.save(ws, ana, { name: 'Refresh', site: 'shop.example' }, state('first'));
    assert.equal(await logins.saveBack(ws, ana, { id: saved.id, signedOut: false, state: state('second') }), 'saved');
    let used = await logins.use(ws, ana, saved.id);
    assert.equal(used.version, 2);
    assert.equal(used.state.cookies[0].value, 'second');
    assert.equal(await logins.saveBack(ws, ana, { id: saved.id, signedOut: true }), 'needs-sign-in');
    assert.equal((await logins.list(ws, ana)).find(login => login.id === saved.id).status, 'needs-sign-in');
    used = await logins.use(ws, ana, saved.id);
    assert.equal(used.state.cookies[0].value, 'second', 'a signed-out session does not overwrite the state');
    await logins.saveBack(ws, ana, { id: saved.id, signedOut: false, state: state('third') });
    assert.equal((await logins.list(ws, ana)).find(login => login.id === saved.id).status, 'active');
    assert.equal(await logins.saveBack(ws, ben, { id: saved.id, signedOut: false, state: state('x') }), 'skipped');
    assert.equal(await logins.saveBack(ws, ana, { id: randomUUID(), signedOut: false, state: state('x') }), 'skipped');
  });

  await t.test('only a manager can sign a signed-out login in again', async () => {
    const saved = await logins.save(ws, ana, { name: 'Sign in again', site: 'shop.example' }, state('owner'));
    await logins.share(ws, ana, saved.id, {
      grants: [{ grantee: { kind: 'member', membershipId: cy.membershipId }, role: 'use' }],
    });
    assert.equal(await logins.saveBack(ws, cy, { id: saved.id, signedOut: false, state: state('cy') }), 'saved');
    await logins.saveBack(ws, cy, { id: saved.id, signedOut: true });
    assert.equal(await logins.saveBack(ws, cy, { id: saved.id, signedOut: false, state: state('other') }), 'skipped');
    assert.equal((await logins.use(ws, ana, saved.id)).state.cookies[0].value, 'cy');
    assert.equal(await logins.saveBack(ws, ana, { id: saved.id, signedOut: false, state: state('again') }), 'saved');
    assert.equal((await logins.list(ws, ana)).find(login => login.id === saved.id).status, 'active');
  });

  await t.test('a state moved to another login cannot be read', async () => {
    const a = await logins.save(ws, ana, { name: 'A', site: 'shop.example' }, state('a'));
    const b = await logins.save(ws, ana, { name: 'B', site: 'shop.example' }, state('b'));
    await db.platform.query(
      `UPDATE ${table('tf_browser_logins')} SET state = (SELECT state FROM ${table('tf_browser_logins')} WHERE id = $1) WHERE id = $2`,
      [a.id, b.id],
    );
    await assert.rejects(logins.use(ws, ana, b.id), code('unavailable'));
  });

  await t.test('a login is suspended while its owner is removed, and deleting it drops the state', async () => {
    const saved = await logins.save(ws, cy, { name: 'Leaving', site: 'shop.example' }, state('cy'));
    await logins.share(ws, cy, saved.id, {
      grants: [{ grantee: { kind: 'member', membershipId: ana.membershipId }, role: 'manage' }],
    });
    await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at = now() WHERE id = $1`, [
      cy.membershipId,
    ]);
    const seen = (await logins.list(ws, ana)).find(login => login.id === saved.id);
    assert.equal(seen.status, 'suspended');
    assert.equal(seen.canUse, false);
    await assert.rejects(logins.use(ws, ana, saved.id), code('unavailable'));
    await logins.remove(ws, ana, saved.id);
    const row = await db.platform.query(`SELECT status, state FROM ${table('tf_browser_logins')} WHERE id = $1`, [
      saved.id,
    ]);
    assert.deepEqual(row.rows[0], { status: 'deleted', state: null });
    await assert.rejects(logins.rename(ws, ana, saved.id, 'Back'), denied);
  });

  await t.test('rejects bad input and oversized states', async () => {
    await assert.rejects(logins.save(ws, ana, { name: '', site: 'shop.example' }, state('x')), code('invalid-input'));
    await assert.rejects(logins.save(ws, ana, { name: 'x', site: 'https://x' }, state('x')), code('invalid-input'));
    const huge = {
      cookies: [],
      origins: [{ origin: 'https://shop.example', localStorage: [{ name: 'blob', value: 'x'.repeat(2_200_000) }] }],
    };
    await assert.rejects(logins.save(ws, ana, { name: 'Huge', site: 'shop.example' }, huge), code('too-large'));
    assert.equal(
      createBrowserLogins({ runtime, keyring: { activeKeyId: 'x', keys: {} } }).capabilities().enabled,
      false,
    );
  });
});
