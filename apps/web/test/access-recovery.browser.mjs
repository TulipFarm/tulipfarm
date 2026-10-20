import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { installTurnstileFixture } from './turnstile-fixture.mjs';
import { createWorkspaceFixture } from './workspace.fixture.mjs';

const server = await createServer({
  root: new URL('..', import.meta.url).pathname,
  server: { host: '127.0.0.1', port: 0 },
});
let browser, agentSession;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const cdp = process.env.ACCESS_CDP_PORT;
  browser = await chromium.launch({ headless: true, args: cdp ? [`--remote-debugging-port=${cdp}`] : [] });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  const { workspace, session } = createWorkspaceFixture({ slug: 'access-proof', name: 'Access proof' });
  const actor = '22222222-2222-4222-8222-222222222222';
  const other = '33333333-3333-4333-8333-333333333333';
  const teamId = '44444444-4444-4444-8444-444444444444';
  const members = [
    { id: actor, userId: session.user.id, name: 'Ada', email: 'ada@example.test', role: 'admin' },
    { id: other, userId: 'ben', name: 'Ben', email: 'ben@example.test', role: 'member' },
  ];
  const team = {
    id: teamId,
    name: 'Operations',
    description: 'Fixture team',
    membershipIds: [actor],
    managerIds: [actor],
    canManage: true,
    canLeave: false,
  };
  const snapshot = {
    actorMembershipId: actor,
    members,
    directory: members.map(member => ({ id: member.id, name: member.name, email: member.email, image: null })),
    teams: [team],
    tableTeamIds: [teamId],
    tables: [],
    grants: [],
  };
  const invitation = (id, email) => ({
    id,
    kind: 'email',
    email,
    expiresAt: '2099-10-11T00:00:00.000Z',
    status: 'active',
    canCopy: true,
  });
  let anonymous = true,
    readFails = false,
    invitationFails = false,
    readDelay = 0,
    writeFails = true;
  const requests = [];
  const errors = [];
  await context.route('**/*', async route => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    if (!path.startsWith('/v1/')) return url.origin === origin ? route.continue() : route.abort();
    requests.push({ method: request.method(), path, search: url.search, body: request.postData() });
    let status = 200,
      json;
    if (path === '/v1/auth/get-session') json = anonymous ? null : session;
    else if (path === '/v1/auth/options') json = { turnstileSiteKey: 'fixture-site-key' };
    else if (path === '/v1/workspaces') json = [workspace];
    else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
    else if (path.endsWith('/governance/me'))
      json = {
        membershipId: actor,
        role: 'admin',
        teams: [{ id: teamId, name: team.name, role: 'manager' }],
        capabilities: { manageGovernance: true, canLeave: false },
      };
    else if (request.method() !== 'GET') {
      status = writeFails ? 503 : 200;
      json = writeFails ? { error: 'workspace-unavailable' } : { ok: true };
      if (!writeFails && /\/teams\/[^/]+$/.test(path))
        snapshot.teams.push({ ...team, id: path.split('/').at(-1), ...request.postDataJSON() });
      if (!writeFails && path.endsWith('/name')) Object.assign(team, request.postDataJSON());
      if (!writeFails && path.endsWith(`/members/${other}`)) team.membershipIds.push(other);
    } else if (path.endsWith('/governance')) {
      status = readFails ? 503 : 200;
      json = readFails ? { error: 'workspace-unavailable' } : snapshot;
      if (readDelay) await new Promise(resolve => setTimeout(resolve, readDelay));
    } else if (path.endsWith('/invitations')) {
      const query = url.searchParams.get('search') ?? '';
      const items = [invitation(actor, 'recent@example.test'), invitation(other, 'older-match@example.test')].filter(
        item => item.email.includes(query),
      );
      const index = url.searchParams.has('after') ? 1 : 0;
      status = invitationFails ? 503 : 200;
      json = invitationFails
        ? { error: 'workspace-unavailable' }
        : { items: items.slice(index, index + 1), nextCursor: items.length > index + 1 ? items[index].id : null };
    } else {
      status = 404;
      json = { error: 'fixture-unavailable' };
    }
    await route.fulfill({
      status,
      json,
      headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' },
    });
  });
  await installTurnstileFixture(context);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(String(error)));
  page.on('dialog', dialog => dialog.accept());
  const shot = async name => {
    if (!process.env.ACCESS_SCREENSHOTS) return;
    await mkdir(process.env.ACCESS_SCREENSHOTS, { recursive: true });
    const path = `${process.env.ACCESS_SCREENSHOTS}/${name}.png`;
    if (cdp) {
      agentSession = `access-proof-${cdp}`;
      execFileSync('agent-browser', ['--session', agentSession, '--cdp', cdp, 'screenshot', path]);
    } else await page.screenshot({ path, fullPage: true });
  };
  for (const route of ['login', 'register'])
    for (const width of [320, 375, 1280]) {
      await page.setViewportSize({ width, height: 850 });
      await page.goto(`${origin}/${route}`);
      await page.getByText('Test verification widget', { exact: true }).waitFor();
      await page.evaluate(() => window.challenge.interact());
      const bounds = await page.evaluate(() => ({
        client: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
        right: document.querySelector('#email').getBoundingClientRect().right,
      }));
      await shot(`${route}-${width}`);
      assert.equal(bounds.client, width);
      assert.ok(bounds.scroll <= width && bounds.right <= width, JSON.stringify(bounds));
    }
  anonymous = false;
  await page.goto(`${origin}/${workspace.slug}/members`);
  const tab = page.getByRole('tab', { name: 'Invitations', exact: true });
  await tab.waitFor();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => {
      document.documentElement.classList.remove('light', 'dark');
      document.documentElement.classList.add(theme);
    }, theme);
    const ratio = await tab.evaluate(el => {
      const canvas = document.createElement('canvas'),
        ctx = canvas.getContext('2d');
      const rgb = color => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        return [...ctx.getImageData(0, 0, 1, 1).data];
      };
      const foreground = rgb(getComputedStyle(el).color),
        background = rgb(getComputedStyle(el.parentElement).backgroundColor);
      const lum = color =>
        color
          .slice(0, 3)
          .map(v => v / 255)
          .map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
          .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
      const blended = foreground
        .slice(0, 3)
        .map((v, i) => (v * foreground[3]) / 255 + background[i] * (1 - foreground[3] / 255));
      const a = lum(blended),
        b = lum(background);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    assert.ok(ratio >= 4.5, `${theme} inactive Invitations contrast ${ratio}`);
    await shot(`members-${theme}`);
  }
  await page.evaluate(() => {
    document.documentElement.classList.remove('dark');
    document.documentElement.classList.add('light');
  });
  const writes = () => requests.filter(request => request.method !== 'GET');
  const recover = async (name, root = page) => {
    const reload = root.getByRole('button', { name: 'Reload access', exact: true });
    await reload.waitFor();
    await reload.scrollIntoViewIfNeeded();
    await shot(name);
    const count = writes().length;
    readFails = true;
    await reload.click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('button')].some(
        button => button.textContent.includes('Reload access') && !button.disabled,
      ),
    );
    assert.equal(writes().length, count, 'failed recovery must not repeat the write');
    readFails = false;
    readDelay = 200;
    await reload.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('button')].some(
        button => button.textContent.includes('Reload access') && !button.disabled,
      ),
    );
    assert.equal(writes().length, count, 'successful recovery must only read');
    readDelay = 0;
  };
  await page.getByRole('button', { name: 'Make admin', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm role change' }).click();
  await recover('member-role-recovery', page.getByRole('dialog'));
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.goto(`${origin}/${workspace.slug}/teams`);
  await page.getByRole('button', { name: 'New team', exact: true }).click();
  await page.getByLabel('New team name').fill('Draft operations');
  await page.getByRole('button', { name: 'Create team', exact: true }).click();
  const attempt = writes().at(-1);
  await recover('team-create-recovery', page.getByRole('dialog'));
  writeFails = false;
  await page.getByRole('button', { name: 'Retry creating team', exact: true }).click();
  await page.getByRole('button', { name: 'View Draft operations details', exact: true }).waitFor();
  assert.deepEqual(writes().at(-1), attempt, 'creation retry must retain its identity and values');
  writeFails = true;
  await page.goto(`${origin}/${workspace.slug}/teams`);
  await page.getByRole('button', { name: 'View Operations details', exact: true }).click();
  await page.getByLabel('Team name', { exact: true }).fill('Draft rename');
  await page.getByRole('button', { name: 'Save team details', exact: true }).click();
  await recover('team-edit-recovery');
  assert.equal(await page.getByLabel('Team name', { exact: true }).inputValue(), 'Draft rename');
  writeFails = false;
  await page.getByRole('button', { name: 'Save team details', exact: true }).click();
  await page.getByRole('heading', { name: 'Draft rename details', exact: true }).waitFor();
  writeFails = true;
  await page.getByRole('checkbox', { name: 'Ben (ben@example.test)', exact: true }).check();
  await page.getByRole('button', { name: 'Add selected members (1)', exact: true }).click();
  await recover('team-membership-recovery');
  assert.equal(await page.getByRole('checkbox', { name: 'Ben (ben@example.test)', exact: true }).isChecked(), true);
  writeFails = false;
  await page.getByRole('button', { name: 'Add selected members (1)', exact: true }).click();
  await page.getByRole('heading', { name: 'Team members (2)', exact: true }).waitFor();
  await page.goto(`${origin}/${workspace.slug}/members`);
  await tab.click();
  await page.getByText('recent@example.test', { exact: true }).waitFor();
  const search = page.getByLabel('Search invitations', { exact: true });
  await search.fill('older-match');
  await page.getByText('older-match@example.test', { exact: true }).waitFor();
  assert.equal(await page.getByText('recent@example.test', { exact: true }).count(), 0);
  assert.ok(requests.some(request => request.search === '?search=older-match'));
  await shot('invitation-search');
  await search.fill('no-match');
  await page.getByRole('heading', { name: 'No invitations match' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'No invitations yet' }).count(), 0);
  await page.getByRole('button', { name: 'Clear search', exact: true }).last().click();
  await page.getByText('recent@example.test', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Load older invitations' }).click();
  await page.getByText('older-match@example.test', { exact: true }).waitFor();
  invitationFails = true;
  await search.fill('unavailable');
  await page.getByRole('button', { name: 'Reload invitations' }).click();
  await page.getByRole('button', { name: 'Reload invitations' }).waitFor();
  assert.equal(await search.inputValue(), 'unavailable');
  invitationFails = false;
  await search.fill('recent');
  await page.getByText('recent@example.test', { exact: true }).waitFor();
  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 850 });
    await shot(`invitations-${width}`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  }
  await page.goto(`${origin}/${workspace.slug}/teams`);
  await page.getByRole('button', { name: 'View Draft rename details', exact: true }).click();
  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 850 });
    await shot(`teams-${width}`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  }
  assert.deepEqual(errors, []);
  console.log(
    'Access recovery: layouts, contrast, read-only recovery, retained writes, search and pagination passed (HTTP fixtures).',
  );
} finally {
  if (agentSession) execFileSync('agent-browser', ['--session', agentSession, 'close']);
  await browser?.close();
  await server.close();
}
