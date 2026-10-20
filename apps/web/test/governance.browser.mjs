import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { workspaceChange, ownMembership } from './workspace-query.fixture.mjs';
import { createMemberTablesMock } from '../src/features/tables/workspace-members-mock-api.ts';
import { selectInvitationMember } from './invitation-members.fixture.mjs';

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
  const memberTables = createMemberTablesMock(workspaceId, null, [{ name: 'Ada', contactEmail: 'ada@example.com' }]);
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
    directory: [{ id: memberId, name: 'Ada', email: 'ada@example.com', image: null }],
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
  const teamAttempts = [];
  let heldRead;
  let heldInvitationRead;
  let invitationReadFails = false;
  let invitations = [];
  const invitationToken = `${workspaceId}.${'a'.repeat(43)}`;
  let redemptions = 0;
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
      json = { session: { id: 'session', userId: 'ada' }, user: { id: 'ada', name: 'Ada', email: 'ada@example.com' } };
    else if (path === '/v1/workspaces') {
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
        email: 'ada@example.com',
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
      if (path.endsWith('/grants')) snapshot.grants.push({ teamId: body.teamId, target: body.target });
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
  await page.goto(`${origin}/acme/teams`);
  await page.getByRole('heading', { name: 'Could not load workspace access' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'No teams yet' }).count(), 0);
  await page.getByRole('button', { name: 'Retry loading' }).click();
  await page.getByRole('heading', { name: 'Could not load workspace access' }).waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: 'Could not load workspace access' }).waitFor();
  readStatus = 200;
  readDelay = 400;
  await page.getByRole('button', { name: 'Retry loading' }).click();
  await page.getByRole('heading', { name: 'No teams yet' }).waitFor();
  await page.getByRole('button', { name: 'New team', exact: true }).click();
  await page.getByLabel('New team name').fill('Operations');
  workspaceReadStatus = 503;
  const focusRead = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/workspaces/acme');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  assert.equal((await focusRead).status(), 503);
  assert.equal(await page.getByLabel('New team name').inputValue(), 'Operations');
  workspaceReadStatus = 200;
  const beforeFocus = governanceReads;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await setTimeout(200);
  assert.equal(governanceReads, beforeFocus, 'focus does not refresh governance');
  readStatus = 503;
  await refreshGovernance();
  await page.getByRole('alert', { includeHidden: true }).first().waitFor();
  assert.equal(await page.getByLabel('New team name').inputValue(), 'Operations');
  assert.equal(await page.getByRole('button', { name: 'Create team', exact: true }).isDisabled(), true);
  readStatus = 200;
  await refreshGovernance();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some(button => button.textContent === 'Create team' && !button.disabled),
  );
  writeFails = true;
  const failedTeamWrite = page.waitForResponse(
    response =>
      response.request().method() === 'PUT' &&
      new RegExp(`^/v1/workspaces/${workspaceId}/governance/teams/[0-9a-f-]+$`).test(new URL(response.url()).pathname),
  );
  await page.getByRole('button', { name: 'Create team', exact: true }).dblclick();
  assert.equal((await failedTeamWrite).status(), 503);
  await page.getByRole('button', { name: 'Retry creating team', exact: true }).waitFor();
  assert.equal(teamAttempts.length, 1, JSON.stringify(teamAttempts));
  assert.equal(await page.getByLabel('New team name').inputValue(), 'Operations');
  writeFails = false;
  readStatus = 200;
  readDelay = 0;
  await refreshGovernance();
  await page.getByRole('heading', { name: 'No teams yet', includeHidden: true }).waitFor();
  assert.equal(await page.getByLabel('New team name').isDisabled(), true);
  await page.getByRole('button', { name: 'Retry creating team', exact: true }).click();
  await page.getByRole('button', { name: 'View Operations details', exact: true }).waitFor();
  assert.equal(snapshot.teams.length, 1);
  await page.getByRole('button', { name: 'New team', exact: true }).click();
  assert.equal(await page.getByLabel('New team name').inputValue(), '');
  assert.deepEqual(teamAttempts[1], teamAttempts[0]);
  const slowRefresh = { started: Promise.withResolvers(), release: Promise.withResolvers() };
  heldRead = slowRefresh;
  await page.getByLabel('New team name').fill('Uncertain Operations');
  await refreshGovernance();
  await slowRefresh.started.promise;
  assert.equal(await page.getByRole('button', { name: 'Create team', exact: true }).isDisabled(), true);
  const writesBeforeRefresh = writes;
  await page.getByRole('button', { name: 'Create team', exact: true }).evaluate(button => button.click());
  assert.equal(writes, writesBeforeRefresh);
  slowRefresh.release.resolve();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some(button => button.textContent === 'Create team' && !button.disabled),
  );
  dropCommittedWrite = true;
  await page.getByRole('button', { name: 'Create team', exact: true }).click();
  await page.getByRole('button', { name: 'Retry creating team', exact: true }).waitFor();
  assert.equal(await page.getByLabel('New team name').isDisabled(), true);
  const uncertainAttempt = teamAttempts.at(-1);
  assert.equal(uncertainAttempt.name, 'Uncertain Operations');
  await refreshGovernance();
  await page.getByRole('button', { name: 'View Uncertain Operations details', exact: true }).waitFor();
  await page.getByRole('button', { name: 'New team', exact: true }).click();
  await page.getByLabel('New team name').fill('Finance');
  await page.getByRole('button', { name: 'Create team', exact: true }).click();
  await page.getByRole('button', { name: 'View Finance details', exact: true }).waitFor();
  assert.notEqual(teamAttempts.at(-1).id, uncertainAttempt.id);
  assert.equal(snapshot.teams.filter(team => team.id === uncertainAttempt.id).length, 1);
  assert.equal(
    teamAttempts.filter(attempt => attempt.id === uncertainAttempt.id && attempt.name !== uncertainAttempt.name).length,
    0,
  );
  const listsBeforeNavigation = workspaceLists;
  await page.getByRole('link', { name: 'Table access', exact: true }).click();
  await page.getByRole('combobox', { name: 'Team receiving access', exact: true }).click();
  await page.getByRole('option', { name: snapshot.teams[0].name, exact: true }).click();
  assert.equal(
    workspaceLists,
    listsBeforeNavigation + 1,
    'warm navigation rechecks workspace admission with one list read',
  );
  await page.getByRole('checkbox', { name: 'Create rows', exact: true }).click();
  await page.locator('[role="checkbox"][aria-checked="true"]').waitFor();
  assert.equal(await page.getByRole('checkbox', { name: 'Read rows', exact: true }).isChecked(), false);
  assert.equal(await page.getByRole('checkbox', { name: 'Manage schema', exact: true }).isChecked(), false);
  await page.getByRole('checkbox', { name: 'Read rows', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[role="checkbox"][aria-checked="true"]').length === 2);
  assert.equal(snapshot.grants.length, 2);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement !== document.body), true);
  readStatus = 404;
  await refreshGovernance();
  await page.getByRole('heading', { name: 'Administration unavailable' }).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: 'Create rows', exact: true }).count(), 0);
  readStatus = 200;
  await page.goto(`${origin}/acme/members`);
  await page.getByRole('tab', { name: 'Invitations', exact: true }).click();
  await page.getByRole('heading', { name: 'No invitations yet' }).waitFor();
  await page.getByRole('button', { name: 'Invite members', exact: true }).last().click();
  await page.getByRole('textbox', { name: 'Email 1', exact: true }).fill('ada@example.com');
  await selectInvitationMember(page, 0, 'Ada · ada@example.com');
  await page.getByRole('button', { name: 'Send invitations', exact: true }).click();
  await page.getByText('1 of 1 recipients confirmed.', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Copy link', exact: true }).click();
  assert.equal(
    await page.getByLabel('Invitation link', { exact: true }).inputValue(),
    `${origin}/invite?token=${invitationToken}`,
  );
  invitationReadFails = true;
  await page.getByRole('button', { name: 'Resend', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm resend', exact: true }).click();
  await page.getByRole('alert', { includeHidden: true }).first().waitFor();
  const oldInvitation = page.getByRole('listitem').filter({ has: page.getByText(/revoked\. Expires/) });
  assert.equal(await oldInvitation.getByRole('button', { name: 'Copy link', exact: true }).count(), 0);
  assert.equal(await oldInvitation.getByRole('button', { name: 'Resend', exact: true }).count(), 0);
  assert.equal(await oldInvitation.getByRole('button', { name: 'Revoke link', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Copy link', exact: true }).count(), 1);
  invitationReadFails = false;
  await page.getByRole('button', { name: 'Copy link', exact: true }).click();
  await page
    .getByRole('listitem')
    .filter({ has: page.getByText(/active\. Expires/) })
    .getByRole('button', { name: 'Revoke link', exact: true })
    .click();
  await page.getByRole('button', { name: 'Confirm revoke', exact: true }).click();
  await page.getByText('Invitation revoked. The link no longer works.', { exact: true }).waitFor();
  assert.equal(await page.getByText('Link copied.', { exact: true }).count(), 0);
  assert.equal(await page.getByLabel('Invitation link', { exact: true }).count(), 0);
  const stale = {
    started: Promise.withResolvers(),
    release: Promise.withResolvers(),
    finished: Promise.withResolvers(),
  };
  invitations = [
    { id: memberId, kind: 'email', email: 'ada@example.com', expiresAt: '2026-10-04T00:00:00.000Z', status: 'active' },
  ];
  heldInvitationRead = stale;
  await page.goto(`${origin}/acme/members`);
  await page.getByRole('tab', { name: 'Invitations', exact: true }).click();
  await stale.started.promise;
  await page.getByRole('button', { name: 'Invite members', exact: true }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  stale.release.resolve();
  await stale.finished.promise;
  await page.getByText(/active\. Expires/).waitFor();
  await page.getByRole('button', { name: 'Revoke link', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm revoke', exact: true }).click();
  await page.getByText(/revoked\. Expires/).waitFor();
  stale.release.resolve();
  await stale.finished.promise;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByText(/active\. Expires/).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Revoke link', exact: true }).isDisabled(), true);
  invitations = Array.from({ length: 101 }, (_, index) => ({
    id: randomUUID(),
    kind: 'email',
    email: `invite-${index}@example.com`,
    expiresAt: '2026-10-04T00:00:00.000Z',
    status: 'active',
  }));
  await page.reload();
  await page.getByRole('tab', { name: 'Invitations', exact: true }).click();
  await page.getByRole('button', { name: 'Load older invitations', exact: true }).waitFor();
  assert.equal(await page.getByText('invite-100@example.com', { exact: true }).count(), 0);
  invitationReadFails = true;
  await page.getByRole('button', { name: 'Load older invitations', exact: true }).click();
  // Failed reads retry before reporting (src/lib/query/policy.ts:15), so wait for this list's own error rather than any alert already on the page.
  await page.getByRole('alert').filter({ hasText: 'Could not refresh invitations.' }).waitFor();
  assert.equal(await page.getByText('invite-0@example.com', { exact: true }).count(), 1);
  invitationReadFails = false;
  await page.getByRole('button', { name: 'Load older invitations', exact: true }).click();
  const olderRow = page
    .getByRole('listitem')
    .filter({ has: page.getByText('invite-100@example.com', { exact: true }) });
  await olderRow.waitFor();
  invitationReadFails = true;
  await olderRow.getByRole('button', { name: 'Revoke link', exact: true }).click();
  await olderRow.getByRole('button', { name: 'Confirm revoke', exact: true }).click();
  await page.getByRole('alert', { includeHidden: true }).first().waitFor();
  assert.equal(await olderRow.getByRole('button', { name: 'Revoke link', exact: true }).isDisabled(), true);
  invitationReadFails = false;
  await workspaceChange(page, workspaceId, 'ada', [['governance', 'invitations']]);
  await olderRow.getByText(/revoked\. Expires/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Revoke link', exact: true }).count(), 101);
  ownReadStatus = 503;
  invitationReadStatus = 404;
  await workspaceChange(page, workspaceId, 'ada', [['governance', 'invitations']]);
  await page.getByRole('heading', { name: 'Could not load workspace access' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Invitations', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Make member', exact: true }).count(), 0);
  ownReadStatus = 200;
  invitationReadStatus = 200;
  await page.getByRole('button', { name: 'Retry loading' }).click();
  await page.getByRole('heading', { name: 'Invitations', exact: true }).waitFor();
  await page.goto(`${origin}/invite#${invitationToken}`);
  await page.waitForURL(`${origin}/acme`);
  assert.equal(redemptions, 1);
  await page.goto(`${origin}/invite?token=${invitationToken}`);
  await page.waitForURL(`${origin}/acme`);
  assert.equal(redemptions, 2);
  assert.deepEqual(errors, []);
  process.stdout.write(
    'Governance browser checks passed. Read recovery, aborted refresh reset, immutable uncertain team retries and reconciliation, duplicate writes, explicit grants, mobile dark mode, keyboard, access loss, invitation pagination/retry, stale read cancellation, confirmed revoke retained after refresh failure, create/revoke/join.\n',
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
