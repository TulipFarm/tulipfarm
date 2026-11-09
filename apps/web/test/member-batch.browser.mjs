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
    ['first', 'lost', 'joined', 'pending', 'renew', 'limited', 'denied', 'stopped', 'never'].map(name => ({
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
      { id: actorId, name: 'Ada', email: 'ada@example.com', image: null, role: 'admin' },
      { id: bobId, name: 'Bob', email: 'bob@example.com', image: null, role: 'member' },
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
  const invitation = (email, status = 'active') => ({
    id: randomUUID(),
    workspaceMemberId: randomUUID(),
    kind: 'email',
    email,
    expiresAt: '2026-10-04T00:00:00.000Z',
    status,
    canCopy: status === 'active',
    delivery: 'pending',
    role: 'member',
    teams: [],
    policies: [],
  });
  let items = [invitation('renew@example.com')];
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
      const params = new URL(request.url()).searchParams;
      // The Members table asks only for open invites: the ones people haven't accepted or had revoked.
      assert.equal(params.get('open'), 'true');
      json = listFails
        ? { error: 'unavailable' }
        : { items: items.filter(item => item.status === 'active' || item.status === 'expired'), nextCursor: null };
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
          assert.deepEqual(
            { role: command.role, teams: command.teams, policies: command.policies },
            { role: 'member', teams: [], policies: [] },
          );
          const item = { ...invitation(command.email), workspaceMemberId: command.workspaceMemberId };
          const previous = items.find(item => item.email === command.email && item.status === 'active');
          const result =
            command.email === 'joined@example.com'
              ? { outcome: 'already-member' }
              : {
                  outcome: command.email === 'pending@example.com' ? 'pending' : previous ? 'updated' : 'created',
                  invitation: item,
                };
          receipts.set(command.requestId, result);
          if (previous) Object.assign(previous, { status: 'revoked', canCopy: false });
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
      for (const list of ['members', 'directory']) {
        const member = snapshot[list].find(member => path.includes(member.id));
        if (path.endsWith('/role')) member.role = request.postDataJSON().role;
        else snapshot[list] = snapshot[list].filter(member => !path.endsWith(member.id));
      }
      json = { ok: true };
    }
    await route.fulfill({
      status,
      json,
      headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' },
    });
  });
  const status = page.getByRole('status').filter({ hasNotText: 'Loading' }).first();
  const actions = name => page.getByRole('button', { name: `Actions for ${name}`, exact: true });
  const confirm = page.getByRole('alertdialog');
  await page.goto(`${origin}/acme/members`);
  const search = page.getByLabel('Search by name or email');
  await search.fill('absent');
  await page.getByRole('heading', { name: 'No one matches that search' }).waitFor();
  await search.fill('bob');
  await page.getByText('bob@example.com', { exact: true }).waitFor();
  assert.equal(await page.getByText('ada@example.com', { exact: true }).count(), 0);
  await search.fill('');
  // Only admin: Ada's own role can't be dropped, and the table says why.
  await page.getByText('Only admin', { exact: true }).waitFor();
  await actions('Bob').click();
  await page.getByRole('menuitem', { name: 'Make Bob an admin', exact: true }).click();
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await confirm.waitFor({ state: 'hidden' });
  assert.equal(membershipWrites, 0);
  await actions('Bob').click();
  await page.getByRole('menuitem', { name: 'Make Bob an admin', exact: true }).click();
  await confirm.getByRole('button', { name: 'Make admin', exact: true }).click();
  await confirm.waitFor({ state: 'hidden' });
  assert.equal(snapshot.members[1].role, 'admin');
  await actions('Bob').click();
  await page.getByRole('menuitem', { name: 'Remove Bob from workspace', exact: true }).click();
  await confirm.getByText('including Operations', { exact: false }).waitFor();
  await confirm.getByRole('button', { name: 'Remove from workspace', exact: true }).click();
  await confirm.waitFor({ state: 'hidden' });
  assert.equal(snapshot.members.length, 1);
  // The pending invite is a row of its own, with its expiry.
  await page.getByText('renew@example.com', { exact: true }).waitFor();
  await page.getByText('Pending', { exact: true }).waitFor();

  await page.getByRole('link', { name: 'Invite members', exact: true }).click();
  const form = page.getByRole('form', { name: 'Invite members' });
  const input = form.getByRole('combobox', { name: 'Email addresses', exact: true });
  const chips = form.locator('[data-slot="combobox-chip"]');
  const chipTexts = async () => (await chips.allInnerTexts()).map(text => text.split(',')[0].trim());
  await input.waitFor();
  await input.fill('FIRST@example.com, first@example.com, invalid');
  await form.getByText('invalid isn’t a valid email address.', { exact: true }).waitFor();
  await form.getByText('Already in the list: first@example.com.', { exact: true }).waitFor();
  assert.equal(attempts.length, 0);
  assert.deepEqual(await chipTexts(), ['first@example.com']);
  await input.fill('');
  await input.fill('ada@example.com,');
  await form.getByText('Already a member: ada@example.com. They won’t be invited.', { exact: true }).waitFor();
  await input.fill('renew@example.com,');
  await form.getByText('Already invited: renew@example.com.', { exact: false }).waitFor();
  await input.fill('lost@example.com, joined@example.com, pending@example.com, limited@example.com,');
  await form.getByText('6 people will join as Member.', { exact: true }).waitFor();
  await form.getByRole('button', { name: 'Invite 6 people', exact: true }).dblclick();
  const failures = form.getByRole('alert').filter({ hasText: 'Couldn’t invite' });
  await failures.waitFor();
  assert.equal(attempts.filter(command => command.email === 'ada@example.com').length, 0, 'members are skipped');
  assert.equal(new Set(attempts.map(command => command.requestId)).size, attempts.length, 'no double submit');
  assert.equal(attempts.length, 6);
  assert.equal(peak, 2);
  await status.getByText('Invited first@example.com and pending@example.com as Member.', { exact: false }).waitFor();
  await status
    .getByText('Replaced the pending invite for renew@example.com. They’ll join as Member.', { exact: false })
    .waitFor();
  await status.getByText('joined@example.com is already a member.', { exact: false }).waitFor();
  assert.deepEqual(await failures.getByRole('listitem').allInnerTexts(), [
    'lost@example.com: we couldn’t confirm the invite. Trying again won’t create a duplicate',
    'limited@example.com: the hourly invite limit was reached; try again later',
  ]);
  assert.deepEqual(await chipTexts(), ['ada@example.com', 'lost@example.com', 'limited@example.com']);
  await form.getByRole('button', { name: 'Invite 2 people', exact: true }).click();
  await failures.getByText('limited@example.com', { exact: false }).waitFor();
  await page.waitForFunction(() => !document.body.innerText.includes('lost@example.com: '));
  const lost = attempts.filter(item => item.email === 'lost@example.com');
  assert.equal(lost.length, 2);
  assert.deepEqual(lost[0], lost[1], 'a retry repeats the same request so it cannot duplicate');
  if (process.env.BATCH_SCREENSHOT_DIR)
    await page.screenshot({ path: `${process.env.BATCH_SCREENSHOT_DIR}/members-invite-page.png`, fullPage: true });
  await form.getByRole('link', { name: 'Cancel', exact: true }).click();

  const table = page.getByRole('table', { name: 'Workspace members' });
  await table.getByText('lost@example.com', { exact: true }).waitFor();
  assert.equal(await table.getByText('renew@example.com', { exact: true }).count(), 1, 'a replaced invite is one row');
  listFails = true;
  await invitationsChanged();
  await page.getByText('Pending invites couldn’t load.', { exact: false }).waitFor();
  listFails = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByText('Pending invites couldn’t load.', { exact: false }).waitFor({ state: 'hidden' });
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    });
  });
  await actions('first@example.com').click();
  await page.getByRole('menuitem', { name: 'Copy invite link for first@example.com', exact: true }).click();
  await status.getByText('Couldn’t copy the link. Invite link for first@example.com:', { exact: false }).waitFor();
  assert.ok((await status.innerText()).includes('/invite?token='));
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.BATCH_SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.BATCH_SCREENSHOT_DIR}/members-invitations-${theme}.png`,
        fullPage: true,
      });
  }
  await actions('lost@example.com').click();
  await page.getByRole('menuitem', { name: 'Resend invite to lost@example.com', exact: true }).click();
  await confirm.getByRole('button', { name: 'Resend invite', exact: true }).click();
  await confirm.getByText('We couldn’t confirm this change.', { exact: false }).waitFor();
  await confirm.getByRole('button', { name: 'Resend invite', exact: true }).click();
  await confirm.waitFor({ state: 'hidden' });
  await status.getByText('Resending the invite to lost@example.com. Their old link no longer works.').waitFor();
  assert.deepEqual(resendAttempts[1], resendAttempts[0]);
  assert.equal(items.filter(item => item.email === 'lost@example.com').length, 2);
  assert.equal(await table.getByText('lost@example.com', { exact: true }).count(), 1);
  await actions('first@example.com').click();
  await page.getByRole('menuitem', { name: 'Revoke invite for first@example.com', exact: true }).click();
  await confirm.getByRole('button', { name: 'Revoke invite', exact: true }).click();
  await confirm.waitFor({ state: 'hidden' });
  await status.getByText('Revoked the invite for first@example.com. Their link no longer works.').waitFor();
  await table.getByText('first@example.com', { exact: true }).waitFor({ state: 'hidden' });
  const pendingInvitation = items.find(item => item.email === 'pending@example.com');
  pendingInvitation.status = 'consumed';
  pendingInvitation.canCopy = false;
  await invitationsChanged();
  await table.getByText('pending@example.com', { exact: true }).waitFor({ state: 'hidden' });

  await page.getByRole('link', { name: 'Invite members', exact: true }).click();
  await input.fill('denied@example.com, stopped@example.com, never@example.com,');
  dropAccess = true;
  await form.getByRole('button', { name: 'Invite 3 people', exact: true }).click();
  // Reads retry 5xx before showing an error (cloud src/lib/query/policy.ts:15); recover only after the error is shown.
  await page.getByRole('button', { name: 'Try again', exact: true }).waitFor({ timeout: 60_000 });
  assert.equal(attempts.filter(command => command.email === 'never@example.com').length, 0);
  ownFails = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByText('Only admins can invite people to this workspace.', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  process.stdout.write(
    'Member batch browser checks passed. Search, final admin, confirmations, parsing, member and re-invite flags, partial outcomes, stable retry, bounded concurrency, invite rows, clipboard recovery, narrow themes and access loss.\n',
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
