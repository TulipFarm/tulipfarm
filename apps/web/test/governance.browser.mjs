import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { workspaceChange, ownMembership } from './workspace-query.fixture.mjs';
import { createMemberTablesMock } from '../src/features/tables/workspace-members-mock-api.ts';

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright'
);
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
});
let browser;
try {
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {
      if (attempt === 100) throw new Error('Governance browser server did not start');
    }
    await setTimeout(100);
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const workspaceId = '11111111-1111-4111-8111-111111111111';
  const memberTables = createMemberTablesMock(workspaceId, null, [
    { name: 'Ada', contactEmail: 'ada@example.com' },
    { name: 'Ivy', contactEmail: 'ivy@example.com' },
  ]);
  const memberId = '22222222-2222-4222-8222-222222222222';
  const tableId = '33333333-3333-4333-8333-333333333333';
  const workspace = {
    id: workspaceId,
    name: 'Acme',
    slug: 'acme',
    createdAt: '2026-09-27T00:00:00.000Z',
    status: 'ready',
    soulCommit: 'a'.repeat(40),
  };
  const snapshot = {
    actorMembershipId: memberId,
    members: [{ id: memberId, userId: 'ada', name: 'Ada', email: 'ada@example.com', role: 'admin' }],
    directory: [{ id: memberId, name: 'Ada', email: 'ada@example.com', image: null, role: 'admin' }],
    tableTeamIds: [],
    teams: [],
    tables: [{ id: tableId, name: 'Invoices', owningTeamId: memberId }],
    grants: [],
  };
  let readStatus = 503;
  let readDelay = 0;
  let workspaceReadStatus = 200;
  let ownReadStatus;
  let invitationReadStatus = 200;
  let writeFails = false;
  let dropCommittedWrite = false;
  let writes = 0;
  let heldWrite;
  const teamAttempts = [];
  let heldRead;
  let heldInvitationRead;
  let invitationReadFails = false;
  let invitations = [];
  const invitationToken = `${workspaceId}.${'a'.repeat(43)}`;
  let redemptions = 0;
  let signedOut = false;
  let invitationDetails;
  let linkSignIns = 0;
  let governanceReads = 0;
  let workspaceLists = 0;
  const refreshGovernance = () => workspaceChange(page, workspaceId, 'ada', [['governance', 'administration']]);
  await page.route('**/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const memberResponse = await memberTables.handle(
      new URL(request.url()),
      request.method(),
      request.postData() ? request.postDataJSON() : null,
    );
    if (memberResponse)
      return route.fulfill({
        status: memberResponse.status,
        contentType: 'application/json',
        body: await memberResponse.text(),
      });
    let status = 200;
    let json;
    if (path === '/v1/auth/get-session')
      json = signedOut
        ? null
        : { session: { id: 'session', userId: 'ada' }, user: { id: 'ada', name: 'Ada', email: 'ada@example.com' } };
    else if (path === '/v1/auth/options') json = { google: false, magicLink: true, emailPassword: true };
    else if (path === '/v1/auth/invitation/details') {
      assert.equal(request.postDataJSON().token, invitationToken);
      json = invitationDetails;
    } else if (path === '/v1/auth/invitation/sign-in') {
      assert.equal(request.postDataJSON().token, invitationToken);
      linkSignIns++;
      signedOut = false;
      json = { workspaceId, membershipId: memberId };
    } else if (path === '/v1/workspaces') {
      workspaceLists++;
      json = [workspace];
    } else if (path === '/v1/workspaces/acme') {
      status = workspaceReadStatus;
      json = status === 200 ? workspace : { error: 'workspace-unavailable' };
    } else if (path.endsWith('/governance/me')) {
      status = ownReadStatus ?? 200;
      json =
        status === 200
          ? { ...ownMembership, capabilities: { manageGovernance: true, canLeave: false } }
          : { error: 'governance-not-found' };
    } else if (path.endsWith('/invitations') && request.method() === 'GET') {
      const after = new URL(request.url()).searchParams.get('after');
      const start = after ? invitations.findIndex(item => item.id === after) + 1 : 0;
      const items = structuredClone(invitations.slice(start, start + 100));
      json = { items, nextCursor: start + 100 < invitations.length ? items.at(-1).id : null };
      if (invitationReadFails) {
        status = 503;
        json = { error: 'workspace-unavailable' };
      }
      if (invitationReadStatus !== 200) {
        status = invitationReadStatus;
        json = { error: 'governance-not-found' };
      }
      if (heldInvitationRead) {
        const held = heldInvitationRead;
        heldInvitationRead = null;
        held.started.resolve();
        await held.release.promise;
        await route.fulfill({
          status,
          json,
          headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' },
        });
        held.finished.resolve();
        return;
      }
    } else if (path.endsWith('/invitations') && request.method() === 'POST') {
      const command = request.postDataJSON();
      assert.ok(command.workspaceMemberId);
      const invitation = {
        id: memberId,
        workspaceMemberId: command.workspaceMemberId,
        kind: 'email',
        email: command.email,
        expiresAt: '2026-10-04T00:00:00.000Z',
        status: 'active',
        canCopy: true,
      };
      invitations = [invitation];
      json = { outcome: 'created', invitation };
    } else if (path.endsWith('/link')) json = { url: `${origin}/invite?token=${invitationToken}` };
    else if (path.endsWith('/resend')) {
      const id = path.split('/').at(-2);
      const replacement = { ...invitations.find(item => item.id === id), id: randomUUID() };
      invitations = [
        replacement,
        ...invitations.map(item => (item.id === id ? { ...item, status: 'revoked', canCopy: false } : item)),
      ];
      json = { outcome: 'created', invitation: replacement };
    } else if (path.endsWith('/revoke')) {
      const id = path.split('/').at(-2);
      invitations = invitations.map(item => (item.id === id ? { ...item, status: 'revoked' } : item));
      json = { ok: true };
    } else if (path === '/v1/invitations/redeem') {
      assert.equal(request.postDataJSON().token, invitationToken);
      redemptions++;
      json = { workspaceId, membershipId: memberId };
    } else if (request.method() === 'GET') {
      if (path.endsWith('/governance')) governanceReads++;
      status = readStatus;
      json =
        status === 200
          ? structuredClone(snapshot)
          : { error: status === 404 ? 'governance-not-found' : 'workspace-unavailable' };
      if (heldRead && path.endsWith('/governance')) {
        const held = heldRead;
        heldRead = null;
        held.started.resolve();
        await held.release.promise;
      }
      await setTimeout(readDelay);
    } else {
      writes++;
      if (heldWrite) {
        const held = heldWrite;
        heldWrite = null;
        held.started.resolve();
        await held.release.promise;
      }
      await setTimeout(150);
      const body = request.postDataJSON();
      if (/\/teams\/[^/]+$/.test(path)) teamAttempts.push({ id: path.split('/').at(-1), name: body.name });
      if (writeFails) {
        await route.fulfill({
          status: 503,
          json: { error: 'workspace-unavailable' },
          headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' },
        });
        return;
      }
      if (path.endsWith('/policies')) {
        const same = grant => grant.teamId === body.subject.id && grant.target.id === body.scope.id;
        const held = snapshot.grants.filter(same).map(grant => grant.target.permission);
        snapshot.grants = [
          ...snapshot.grants.filter(grant => !same(grant)),
          ...body.permissions.map(permission => ({
            teamId: body.subject.id,
            target: { kind: 'table', id: body.scope.id, permission },
          })),
        ];
        json = {
          added: body.permissions.filter(permission => !held.includes(permission)),
          removed: held.filter(permission => !body.permissions.includes(permission)),
        };
      }
      if (/\/teams\/[^/]+$/.test(path)) {
        const id = path.split('/').at(-1);
        const existing = snapshot.teams.find(team => team.id === id);
        if (existing && existing.name !== body.name) {
          status = 409;
          json = { error: 'team-id-conflict' };
        } else if (!existing) {
          snapshot.teams.push({
            id,
            name: body.name,
            description: body.description,
            membershipIds: [memberId],
            managerIds: [memberId],
            canManage: true,
            canLeave: false,
          });
          snapshot.tableTeamIds.push(id);
        }
      }
      if (dropCommittedWrite) {
        dropCommittedWrite = false;
        await route.abort('failed');
        return;
      }
      json ??= { ok: true };
    }
    await route.fulfill({
      status,
      json,
      headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' },
    });
  });
  const status = page.getByRole('status').filter({ hasNotText: 'Loading' }).first();
  const dialog = page.getByRole('dialog');
  const confirm = page.getByRole('alertdialog');
  const teamName = dialog.getByLabel('New team name');
  const createTeam = dialog.getByRole('button', { name: 'Create team', exact: true });
  await page.goto(`${origin}/acme/teams`);
  await page.getByRole('heading', { name: 'Couldn’t load workspace access' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'No teams yet' }).count(), 0);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByRole('heading', { name: 'Couldn’t load workspace access' }).waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: 'Couldn’t load workspace access' }).waitFor();
  readStatus = 200;
  readDelay = 400;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByRole('heading', { name: 'No teams yet' }).waitFor();
  await page.getByRole('button', { name: 'Create a team', exact: true }).first().click();
  await teamName.fill('Operations');
  workspaceReadStatus = 503;
  const focusRead = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/workspaces/acme');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  assert.equal((await focusRead).status(), 503);
  assert.equal(await teamName.inputValue(), 'Operations');
  workspaceReadStatus = 200;
  const beforeFocus = governanceReads;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await setTimeout(200);
  assert.equal(governanceReads, beforeFocus, 'focus does not refresh governance');
  // Access that may be out of date blocks new changes until it reloads, and keeps the draft.
  readStatus = 503;
  await refreshGovernance();
  await page.getByText('Access shown here may be out of date.', { exact: false }).waitFor();
  assert.equal(await teamName.inputValue(), 'Operations');
  assert.equal(await createTeam.isDisabled(), true);
  readStatus = 200;
  readDelay = 0;
  await refreshGovernance();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[role="dialog"] button')].some(
      button => button.textContent === 'Create team' && !button.disabled,
    ),
  );
  // An unconfirmed create keeps the dialog and retries with the same id, so it never makes two teams.
  writeFails = true;
  const failedTeamWrite = page.waitForResponse(
    response =>
      response.request().method() === 'PUT' &&
      new RegExp(`^/v1/workspaces/${workspaceId}/governance/teams/[0-9a-f-]+$`).test(new URL(response.url()).pathname),
  );
  await createTeam.dblclick();
  assert.equal((await failedTeamWrite).status(), 503);
  await page.getByText('Reload to check current access.', { exact: false }).waitFor();
  assert.equal(teamAttempts.length, 1, JSON.stringify(teamAttempts));
  assert.equal(await teamName.inputValue(), 'Operations');
  writeFails = false;
  await createTeam.click();
  await page.getByRole('heading', { name: 'Operations', exact: true }).waitFor();
  await status.getByText('Created the team Operations. You’re its manager.', { exact: true }).waitFor();
  assert.equal(snapshot.teams.length, 1);
  assert.deepEqual(teamAttempts[1], teamAttempts[0]);
  const operations = snapshot.teams[0];

  await page.getByRole('link', { name: 'Teams', exact: true }).first().click();
  await page.getByRole('button', { name: 'Create a team', exact: true }).click();
  assert.equal(await teamName.inputValue(), '', 'a new dialog starts empty');
  const slowRefresh = { started: Promise.withResolvers(), release: Promise.withResolvers() };
  heldRead = slowRefresh;
  await teamName.fill('Uncertain Operations');
  await refreshGovernance();
  await slowRefresh.started.promise;
  assert.equal(await createTeam.isDisabled(), true);
  const writesBeforeRefresh = writes;
  await createTeam.evaluate(button => button.click());
  assert.equal(writes, writesBeforeRefresh, 'no change is sent while access reloads');
  slowRefresh.release.resolve();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[role="dialog"] button')].some(
      button => button.textContent === 'Create team' && !button.disabled,
    ),
  );
  dropCommittedWrite = true;
  await createTeam.click();
  await page.getByText('Reload to check current access.', { exact: false }).waitFor();
  const uncertainAttempt = teamAttempts.at(-1);
  assert.equal(uncertainAttempt.name, 'Uncertain Operations');
  await createTeam.click();
  await page.getByRole('heading', { name: 'Uncertain Operations', exact: true }).waitFor();
  assert.equal(teamAttempts.at(-1).id, uncertainAttempt.id);
  assert.equal(snapshot.teams.filter(team => team.id === uncertainAttempt.id).length, 1);
  await page.getByRole('link', { name: 'Teams', exact: true }).first().click();
  await page.getByRole('button', { name: 'Create a team', exact: true }).click();
  await teamName.fill('Finance');
  await createTeam.click();
  await page.getByRole('heading', { name: 'Finance', exact: true }).waitFor();
  assert.notEqual(teamAttempts.at(-1).id, uncertainAttempt.id);
  assert.equal(
    teamAttempts.filter(attempt => attempt.id === uncertainAttempt.id && attempt.name !== uncertainAttempt.name).length,
    0,
  );

  // A team's access policies: one dialog per table, saved once.
  const listsBeforeNavigation = workspaceLists;
  await page.goto(`${origin}/acme/teams/${operations.id}`);
  await page.getByRole('heading', { name: 'Operations', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Access policies', exact: true }).click();
  await page.getByRole('heading', { name: 'Operations has no access yet' }).waitFor();
  await page.getByRole('button', { name: 'Create a policy', exact: true }).first().click();
  await dialog.getByRole('heading', { name: 'Add a policy for Operations' }).waitFor();
  await dialog.getByRole('combobox', { name: 'Applies to' }).click();
  await page.getByRole('option', { name: 'Invoices', exact: true }).click();
  assert.equal(await dialog.getByRole('checkbox', { name: 'Read rows', exact: true }).isChecked(), true);
  assert.equal(await dialog.getByRole('checkbox', { name: 'Manage schema', exact: true }).isChecked(), false);
  await dialog.getByRole('checkbox', { name: 'Create rows', exact: true }).click();
  await dialog.getByRole('button', { name: 'Add policy', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await status.getByText('Operations can now read and create rows in Invoices.', { exact: true }).waitFor();
  assert.deepEqual(
    snapshot.grants.map(grant => grant.target.permission),
    ['table.row.read', 'table.row.create'],
  );
  assert.ok(workspaceLists >= listsBeforeNavigation);
  const policies = page.getByRole('table', { name: 'Access policies for Operations' });
  await policies.getByText('Invoices', { exact: true }).waitFor();
  // A save that isn't confirmed keeps the dialog open with the choices, and changes nothing.
  writeFails = true;
  await page.getByRole('button', { name: 'Actions for the policy on Invoices for Operations', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit the policy on Invoices for Operations', exact: true }).click();
  await dialog.getByRole('heading', { name: 'Edit policy for Operations' }).waitFor();
  await dialog.getByRole('checkbox', { name: 'Delete rows', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save policy', exact: true }).click();
  await dialog.getByText('We couldn’t confirm the change.', { exact: false }).waitFor();
  assert.equal(await dialog.getByRole('checkbox', { name: 'Delete rows', exact: true }).isChecked(), true);
  assert.equal(snapshot.grants.length, 2);
  writeFails = false;
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement !== document.body), true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ colorScheme: 'light' });
  readStatus = 404;
  await refreshGovernance();
  await page.getByRole('heading', { name: 'You can’t view this page' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Create a policy', exact: true }).count(), 0);
  readStatus = 200;

  // Invites are rows in the Members table, with their actions in the row's menu.
  await page.goto(`${origin}/acme/members/invite`);
  await page.getByRole('combobox', { name: 'Email addresses', exact: true }).fill('ivy@example.com,');
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  await page.waitForURL(`${origin}/acme/members`);
  await status.getByText('Invited ivy@example.com as Member.', { exact: false }).waitFor();
  const table = page.getByRole('table', { name: 'Workspace members' });
  await table.getByText('ivy@example.com', { exact: true }).waitFor();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const actions = page.getByRole('button', { name: 'Actions for ivy@example.com', exact: true });
  await actions.click();
  await page.getByRole('menuitem', { name: 'Copy invite link for ivy@example.com', exact: true }).click();
  await status.getByText('Copied the invite link for ivy@example.com.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${origin}/invite?token=${invitationToken}`);
  // The resend is confirmed even when the list can't refresh: the old invite is replaced in place.
  invitationReadFails = true;
  await actions.click();
  await page.getByRole('menuitem', { name: 'Resend invite to ivy@example.com', exact: true }).click();
  await confirm.getByRole('button', { name: 'Resend invite', exact: true }).click();
  await confirm.waitFor({ state: 'hidden' });
  await status.getByText('Resending the invite to ivy@example.com. Their old link no longer works.').waitFor();
  assert.equal(await table.getByText('ivy@example.com', { exact: true }).count(), 1);
  invitationReadFails = false;
  await workspaceChange(page, workspaceId, 'ada', [['governance', 'invitations']]);
  // A read that started before a revoke can't bring the revoked invite back.
  const stale = {
    started: Promise.withResolvers(),
    release: Promise.withResolvers(),
    finished: Promise.withResolvers(),
  };
  heldInvitationRead = stale;
  await workspaceChange(page, workspaceId, 'ada', [['governance', 'invitations']]);
  await stale.started.promise;
  await actions.click();
  await page.getByRole('menuitem', { name: 'Revoke invite for ivy@example.com', exact: true }).click();
  await confirm.getByRole('button', { name: 'Revoke invite', exact: true }).click();
  await confirm.waitFor({ state: 'hidden' });
  await table.getByText('ivy@example.com', { exact: true }).waitFor({ state: 'hidden' });
  stale.release.resolve();
  await stale.finished.promise;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await table.getByText('ivy@example.com', { exact: true }).count(), 0);
  // More than one page of open invites.
  invitations = Array.from({ length: 101 }, (_, index) => ({
    id: randomUUID(),
    kind: 'email',
    email: `invite-${index}@example.com`,
    expiresAt: '2026-10-04T00:00:00.000Z',
    status: 'active',
  }));
  await page.reload();
  await page.getByRole('button', { name: 'Show more invites', exact: true }).waitFor();
  assert.equal(await table.getByText('invite-100@example.com', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Show more invites', exact: true }).click();
  await table.getByText('invite-100@example.com', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Show more invites', exact: true }).waitFor({ state: 'hidden' });
  ownReadStatus = 503;
  invitationReadStatus = 404;
  await workspaceChange(page, workspaceId, 'ada', [['governance', 'invitations']]);
  await page.getByRole('heading', { name: 'Couldn’t load workspace access' }).waitFor({ timeout: 60_000 });
  assert.equal(await page.getByRole('table', { name: 'Workspace members' }).count(), 0);
  ownReadStatus = 200;
  invitationReadStatus = 200;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await table.waitFor();
  await page.goto(`${origin}/invite#${invitationToken}`);
  await page.waitForURL(`${origin}/acme`);
  assert.equal(redemptions, 1);
  await page.goto(`${origin}/invite?token=${invitationToken}`);
  await page.waitForURL(`${origin}/acme`);
  assert.equal(redemptions, 2);
  signedOut = true;
  invitationDetails = {
    status: 'active',
    email: 'ada@example.com',
    workspaceName: 'Acme',
    hasAccount: true,
    linkSignIn: false,
  };
  await page.goto(`${origin}/invite?token=${invitationToken}`);
  await page.getByRole('heading', { name: 'Join Acme', exact: true }).waitFor();
  const invitedEmail = page.getByRole('textbox', { name: 'Email' });
  assert.equal(await invitedEmail.inputValue(), 'ada@example.com');
  assert.equal(await invitedEmail.isEditable(), false);
  assert.equal(await page.getByRole('heading', { name: 'Sign in before joining' }).count(), 0);
  assert.equal(linkSignIns, 0, 'The link never signs in to an existing account');
  // A sign-in that loses its redirect lands on the root, which returns to the invitation opened in this browser.
  signedOut = false;
  await page.goto(`${origin}/`);
  await page.waitForURL(`${origin}/acme`);
  assert.equal(redemptions, 3);
  signedOut = true;
  invitationDetails = { status: 'consumed' };
  await page.goto(`${origin}/invite?token=${invitationToken}`);
  await page.getByRole('heading', { name: 'This invitation was already used' }).waitFor();
  assert.equal(linkSignIns, 0);
  invitationDetails = {
    status: 'active',
    email: 'ada@example.com',
    workspaceName: 'Acme',
    hasAccount: false,
    linkSignIn: true,
  };
  await page.goto(`${origin}/invite?token=${invitationToken}`);
  await page.waitForURL(`${origin}/acme`);
  assert.equal(linkSignIns, 1);
  assert.equal(redemptions, 4);
  assert.deepEqual(errors, []);
  process.stdout.write(
    'Governance browser checks passed. Read recovery, stale access blocking changes, immutable uncertain team retries, duplicate writes, team policies and unconfirmed policy saves, mobile dark mode, keyboard, access loss, invite rows with copy, resend and revoke, stale read cancellation, invite pagination, create/revoke/join, signed-out invitation sign-in.\n',
  );
} catch (e) {
  const p = browser?.contexts()[0]?.pages()[0];
  await p?.screenshot({ path: 'reports/fail.png', fullPage: true });
  console.error('BODY', await p?.locator('body').innerText());
  throw e;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
