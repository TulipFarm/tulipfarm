import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import { createMemberTablesMock } from '../src/features/tables/workspace-members-mock-api.ts';
import { shellRead } from './shell-reads.mjs';
import { governanceSnapshotSchema } from '@tulipfarm/workspaces/governance-contracts';

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
  for (let i = 0; ; i++) {
    if (
      await fetch(origin)
        .then(response => response.ok)
        .catch(() => false)
    )
      break;
    assert.ok(i < 150);
    await setTimeout(100);
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  // Reads no longer refetch on window focus since cloud d900f18a (#301), src/lib/query/client.ts; another tab's invitation change refreshes the list.
  const invitationsChanged = () =>
    page.evaluate(
      async ({ workspaceId, membershipId }) => {
        const { queryNotifications } = await import('/src/lib/query/notifications.ts');
        const channel = queryNotifications(() => {}, 'other-tab');
        channel.send({ kind: 'workspace', userId: 'ada', workspaceId, membershipId }, 'change', [
          ['governance', 'invitations'],
        ]);
        channel.close();
      },
      { workspaceId, membershipId: actorId },
    );
  const workspaceId = randomUUID();
  const memberTables = createMemberTablesMock(
    workspaceId,
    null,
    ['first', 'lost', 'bob', 'pending', 'limited', 'denied', 'stopped', 'never'].map(name => ({
      name,
      contactEmail: `${name}@example.com`,
    })),
  );
  const actorId = randomUUID();
  const bobId = randomUUID();
  const snapshot = {
    actorMembershipId: actorId,
    members: [
      { id: actorId, userId: 'ada', name: 'Ada', email: 'ada@example.com', role: 'admin' },
      { id: bobId, userId: 'bob', name: 'Bob', email: 'bob@example.com', role: 'member' },
    ],
    directory: [
      { id: actorId, name: 'Ada', email: 'ada@example.com', image: null },
      { id: bobId, name: 'Bob', email: 'bob@example.com', image: null },
    ],
    teams: [
      {
        id: randomUUID(),
        name: 'Operations',
        description: '',
        membershipIds: [bobId],
        managerIds: [bobId],
        canManage: true,
        canLeave: false,
      },
    ],
    tableTeamIds: [],
    tables: [],
    grants: [],
  };
  governanceSnapshotSchema.parse(snapshot);
  const workspace = {
    id: workspaceId,
    name: 'Acme',
    slug: 'acme',
    createdAt: '2026-09-27T00:00:00.000Z',
    status: 'ready',
    soulCommit: 'a'.repeat(40),
  };
  let admin = true;
  let ownFails = false;
  let listFails = false;
  let loseOnce = true;
  let active = 0;
  let peak = 0;
  const attempts = [];
  const receipts = new Map();
  let items = [];
  let dropAccess = false;
  let membershipWrites = 0;
  let loseResend = true;
  const resendAttempts = [];
  const resendReceipts = new Map();
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
    // The shell's own reads (integration banner, Bud, recommendations, last-used) are not membership writes.
    const shell = shellRead(request.method(), path, workspace);
    if (shell)
      return route.fulfill({
        ...shell,
        headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' },
      });
    let status = 200;
    let json;
    if (path.endsWith('/auth/get-session'))
      json = { session: { id: 'session', userId: 'ada' }, user: { id: 'ada', name: 'Ada', email: 'ada@example.com' } };
    else if (path === '/v1/workspaces') json = [workspace];
    else if (path === '/v1/workspaces/acme') json = workspace;
    else if (path.endsWith('/credits'))
      json = { available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] };
    else if (path.endsWith('/governance/me')) {
      status = ownFails ? 503 : 200;
      json = ownFails
        ? { error: 'unavailable' }
        : {
            membershipId: actorId,
            role: admin ? 'admin' : 'member',
            teams: [],
            capabilities: { manageGovernance: admin, canLeave: !admin },
          };
    } else if (path.endsWith('/governance')) json = snapshot;
    else if (path.endsWith('/invitations') && request.method() === 'GET') {
      status = listFails ? 503 : 200; // The API filters invitations before pagination since cloud b68e3b61 (#899), src/features/governance/invitations.ts:29.
      const search = new URL(request.url()).searchParams.get('search');
      json = listFails
        ? { error: 'unavailable' }
        : { items: search ? items.filter(item => item.email.includes(search)) : items, nextCursor: null };
    } else if (path.endsWith('/invitations') && request.method() === 'POST') {
      const command = request.postDataJSON();
      attempts.push(command);
      active++;
      peak = Math.max(peak, active);
      await setTimeout(200);
      active--;
      if (dropAccess) {
        admin = false;
        ownFails = true;
        status = 404;
        json = { error: 'governance-not-found' };
      } else if (command.email === 'limited@example.com') {
        status = 429;
        json = { error: 'rate-limit-exceeded' };
      } else {
        if (!receipts.has(command.requestId)) {
          assert.ok(command.workspaceMemberId);
          const item = {
            id: randomUUID(),
            workspaceMemberId: command.workspaceMemberId,
            kind: 'email',
            email: command.email,
            expiresAt: '2026-10-04T00:00:00.000Z',
            status: 'active',
            canCopy: true,
            delivery: 'pending',
          };
          const result =
            command.email === 'bob@example.com'
              ? { outcome: 'already-member' }
              : { outcome: command.email === 'pending@example.com' ? 'pending' : 'created', invitation: item };
          receipts.set(command.requestId, result);
          if (result.invitation) items.push(item);
        }
        json = receipts.get(command.requestId);
        if (command.email === 'lost@example.com' && loseOnce) {
          loseOnce = false;
          await route.abort('failed');
          return;
        }
      }
    } else if (path.endsWith('/resend')) {
      const id = path.split('/').at(-2);
      const command = request.postDataJSON();
      resendAttempts.push({ id, ...command });
      if (!resendReceipts.has(command.requestId)) {
        const original = items.find(item => item.id === id);
        if (original.status !== 'active') {
          await route.fulfill({ status: 404, json: { error: 'invitation-unavailable' } });
          return;
        }
        original.status = 'revoked';
        original.canCopy = false;
        const replacement = { ...original, id: randomUUID(), status: 'active', canCopy: true };
        items.unshift(replacement);
        resendReceipts.set(command.requestId, { outcome: 'created', invitation: replacement });
      }
      json = resendReceipts.get(command.requestId);
      if (loseResend) {
        loseResend = false;
        await route.abort('failed');
        return;
      }
    } else if (path.endsWith('/revoke')) {
      const item = items.find(item => item.id === path.split('/').at(-2));
      item.status = 'revoked';
      item.canCopy = false;
      json = { ok: true };
    } else if (path.endsWith('/link')) {
      json = { url: `${origin}/invite?token=${workspaceId}.${'a'.repeat(43)}` };
    } else {
      membershipWrites++;
      const member = snapshot.members.find(member => path.includes(member.id));
      if (path.endsWith('/role')) member.role = request.postDataJSON().role;
      else snapshot.members = snapshot.members.filter(member => !path.endsWith(member.id));
      json = { ok: true };
    }
    await route.fulfill({
      status,
      json,
      headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' },
    });
  });
  await page.goto(`${origin}/acme/members`);
  await page.getByLabel('Search members').fill('Operations');
  assert.equal(await page.getByText('bob@example.com', { exact: true }).count(), 1);
  assert.equal(await page.getByText('ada@example.com', { exact: true }).count(), 0);
  await page.getByLabel('Search members').fill('absent');
  await page.getByRole('heading', { name: 'No members match' }).waitFor();
  // The empty state's Clear search button, not the search field's icon button of the same name.
  await page.getByRole('button', { name: 'Clear search' }).filter({ hasText: 'Clear search' }).click();
  assert.equal(await page.getByRole('button', { name: 'Make member', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Make admin', exact: true }).click();
  assert.equal(membershipWrites, 0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Make admin', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm role change' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(snapshot.members[1].role, 'admin');
  await page.getByRole('button', { name: 'Remove access for Bob', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm removal' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(snapshot.members.length, 1);
  await page.getByRole('button', { name: 'Invite members', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const input = dialog.getByRole('combobox', { name: 'Email addresses', exact: true });
  const chips = dialog.locator('[data-slot="combobox-chip"]');
  const fillEmails = async value => {
    await input.focus();
    while ((await chips.count()) > 0) await page.keyboard.press('Backspace');
    await input.fill(value);
  };
  await fillEmails('FIRST@example.com, first@example.com, invalid');
  await page.getByRole('button', { name: 'Send invitations', exact: true }).click();
  await page.getByText('Check invalid. It is not a valid email address.').waitFor();
  assert.equal(attempts.length, 0);
  assert.equal(await dialog.getByRole('combobox', { name: 'Workspace member', exact: true }).count(), 0);
  assert.deepEqual(await chips.allInnerTexts(), ['first@example.com']);
  await input.fill('');
  await fillEmails(
    'FIRST@example.com, first@example.com, lost@example.com, bob@example.com, pending@example.com, limited@example.com,',
  );
  await page.getByText('Already added: first@example.com.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Send invitations', exact: true }).dblclick();
  await page.getByRole('button', { name: 'Send invitations', exact: true }).waitFor();
  assert.equal(attempts.length, 5);
  assert.equal(peak, 2);
  const results = dialog.getByRole('region', { name: 'Invitation results' });
  assert.equal(
    await results.getByRole('status').innerText(),
    '1 invitation sent. 1 person was already invited. 1 person is already a member.',
  );
  assert.deepEqual(await results.getByRole('alert').allInnerTexts(), [
    '1 not sent: not confirmed, retrying is safe.',
    '1 not sent: hourly limit reached, try again later.',
  ]);
  assert.deepEqual(await chips.allInnerTexts(), ['lost@example.com', 'limited@example.com']);
  await page.getByRole('button', { name: 'Retry invitation for lost@example.com', exact: true }).click();
  await results.getByText('2 invitations sent.', { exact: false }).waitFor();
  assert.deepEqual(
    attempts.filter(item => item.email === 'lost@example.com')[0],
    attempts.filter(item => item.email === 'lost@example.com')[1],
  );
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.textContent === 'Invite members');
  assert.equal(
    await page
      .getByRole('button', { name: 'Invite members', exact: true })
      .evaluate(button => button === document.activeElement),
    true,
  );
  await page.getByRole('button', { name: 'Invite members', exact: true }).click();
  assert.equal(await chips.count(), 0, 'closing starts a fresh draft');
  assert.equal(await results.count(), 0, 'closing clears results');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('tab', { name: 'Invitations', exact: true }).click();
  listFails = true;
  await invitationsChanged();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByText('first@example.com', { exact: true }).count(), 1);
  listFails = false;
  await invitationsChanged();
  await page.getByLabel('Search invitations').fill('absent');
  await page.getByRole('heading', { name: 'No invitations match' }).waitFor();
  // The empty state's Clear search button, not the search field's icon button of the same name.
  await page.getByRole('button', { name: 'Clear search' }).filter({ hasText: 'Clear search' }).click();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    });
  });
  const row = page.getByRole('listitem').filter({ has: page.getByText('first@example.com', { exact: true }) });
  await row.getByRole('button', { name: 'Copy link', exact: true }).click();
  await row.getByText('Clipboard unavailable.', { exact: false }).waitFor();
  assert.ok((await row.getByLabel('Invitation link').inputValue()).includes('/invite?token='));
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.BATCH_SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.BATCH_SCREENSHOT_DIR}/members-invitations-${theme}.png`,
        fullPage: true,
      });
  }
  await page.getByRole('button', { name: 'Invite members', exact: true }).click();
  if (process.env.BATCH_SCREENSHOT_DIR)
    await page.screenshot({ path: `${process.env.BATCH_SCREENSHOT_DIR}/members-batch-dialog.png`, fullPage: true });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  const invitationRow = email => page.getByRole('listitem').filter({ has: page.getByText(email, { exact: true }) });
  await invitationRow('lost@example.com').getByRole('button', { name: 'Resend', exact: true }).click();
  await invitationRow('lost@example.com').getByRole('button', { name: 'Confirm resend', exact: true }).click();
  await invitationRow('lost@example.com').getByRole('alert').waitFor();
  await invitationsChanged();
  await invitationRow('lost@example.com').getByRole('button', { name: 'Retry resend', exact: true }).click();
  await invitationRow('lost@example.com').getByRole('button', { name: 'Confirm resend', exact: true }).click();
  await invitationRow('lost@example.com').getByRole('button', { name: 'Copy link', exact: true }).first().waitFor();
  assert.deepEqual(resendAttempts[1], resendAttempts[0]);
  assert.equal(items.filter(item => item.email === 'lost@example.com').length, 2);
  await row.getByRole('button', { name: 'Revoke link', exact: true }).click();
  await row.getByRole('button', { name: 'Confirm revoke', exact: true }).click();
  await row.getByText(/revoked\. Expires/).waitFor();
  assert.equal(await row.getByRole('button', { name: 'Copy link', exact: true }).count(), 0);
  assert.equal(await row.getByRole('button', { name: 'Resend', exact: true }).count(), 0);
  assert.equal(await row.getByRole('button', { name: 'Revoke link', exact: true }).isDisabled(), true);
  const pendingInvitation = items.find(item => item.email === 'pending@example.com');
  pendingInvitation.status = 'consumed';
  pendingInvitation.canCopy = false;
  await invitationsChanged();
  await page.getByText(/consumed\. Expires/).waitFor();
  assert.equal(
    await invitationRow('pending@example.com').getByRole('button', { name: 'Copy link', exact: true }).count(),
    0,
  );
  assert.equal(
    await invitationRow('pending@example.com').getByRole('button', { name: 'Resend', exact: true }).count(),
    0,
  );
  await page.getByRole('button', { name: 'Invite members', exact: true }).click();
  await fillEmails('denied@example.com, stopped@example.com, never@example.com,');
  dropAccess = true;
  await page.getByRole('button', { name: 'Send invitations', exact: true }).click();
  await page.getByText('Admin access is unavailable.', { exact: false }).waitFor();
  await results.getByText('3 not sent: admin access was lost.', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Search members').count(), 0);
  assert.equal(await page.getByLabel('Search invitations').count(), 0);
  assert.equal(await dialog.getByRole('button', { name: 'Copy link', exact: true }).count(), 0);
  assert.deepEqual(await chips.allInnerTexts(), ['denied@example.com', 'stopped@example.com', 'never@example.com']);
  assert.equal(attempts.filter(command => command.email === 'never@example.com').length, 0);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  // Reads retry 5xx before showing an error (cloud src/lib/query/policy.ts:15); recover only after the error is shown.
  await page.getByRole('button', { name: 'Retry loading' }).waitFor();
  ownFails = false;
  await page.getByRole('button', { name: 'Retry loading' }).click();
  await page.getByRole('heading', { name: 'My membership' }).waitFor();
  assert.equal(await page.getByRole('tab', { name: 'Invitations', exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  process.stdout.write(
    'Member batch browser checks passed. Search, final admin, confirmations, parsing, partial outcomes, stable retry, bounded concurrency, clipboard recovery, dialog focus, narrow themes, and access-loss draft retention.\n',
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
