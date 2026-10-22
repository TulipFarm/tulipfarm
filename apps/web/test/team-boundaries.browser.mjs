import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createWorkspaceFixture } from './workspace.fixture.mjs';
import { workspaceChange, ownMembership } from './workspace-query.fixture.mjs';

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
  for (let n = 0; ; n++) {
    if (
      await fetch(origin)
        .then(r => r.ok)
        .catch(() => false)
    )
      break;
    assert.ok(n < 100);
    await setTimeout(100);
  }
  browser = await chromium.launch();
  const page = await browser.newPage();
  const { workspace, session } = createWorkspaceFixture({ slug: 'team-proof', name: 'Team proof' });
  const actorId = ownMembership.membershipId,
    otherId = randomUUID(),
    hiddenTeam = randomUUID(),
    tableId = randomUUID();
  const directory = [
    { id: actorId, name: 'Ada', email: 'ada@example.com', image: null },
    { id: otherId, name: 'Ben', email: 'ben@example.com', image: null },
  ];
  let admin = false,
    failed = false,
    delay = 0,
    writes = 0;
  const teams = [];
  const grants = [];
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/v1/**', async route => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    let status = 200,
      json;
    if (path === '/v1/auth/get-session') json = session;
    else if (path === '/v1/workspaces') json = [workspace];
    else if (path === '/v1/workspaces/team-proof') json = workspace;
    else if (path.endsWith('/governance/me'))
      json = {
        ...ownMembership,
        role: admin ? 'admin' : 'member',
        teams: teams
          .filter(t => t.membershipIds.includes(actorId))
          .map(t => ({ id: t.id, name: t.name, role: t.managerIds.includes(actorId) ? 'manager' : 'member' })),
        capabilities: { manageGovernance: admin, canLeave: true },
      };
    else if (path.endsWith('/governance') && request.method() === 'GET') {
      await setTimeout(delay);
      status = failed ? 503 : 200;
      json = failed
        ? { error: 'workspace-unavailable' }
        : {
            actorMembershipId: actorId,
            directory,
            members: admin
              ? directory.map(m => ({
                  ...m,
                  userId: m.id === actorId ? 'ada' : 'ben',
                  role: m.id === actorId ? 'admin' : 'member',
                }))
              : [],
            teams: teams
              .filter(t => t.membershipIds.includes(actorId))
              .map(t => ({
                ...t,
                canManage: t.managerIds.includes(actorId),
                canLeave: !t.managerIds.includes(actorId) || t.managerIds.length > 1,
              })),
            tableTeamIds: admin ? [hiddenTeam, ...teams.map(t => t.id)] : [],
            tables: admin ? [{ id: tableId, name: 'Invoices', owningTeamId: hiddenTeam }] : [],
            grants: admin ? grants : [],
          };
    } else if (path.endsWith('/person-grants') && request.method() === 'GET') json = { grants: [] };
    else if (path.endsWith('/credits')) json = { balance: '0', spent: '0', reserved: '0' };
    else if (request.method() !== 'GET' && path.includes('/governance/')) {
      writes++;
      await setTimeout(100);
      const body = request.postDataJSON();
      const parts = path.split('/');
      const teamIndex = parts.indexOf('teams');
      const teamId = teamIndex < 0 ? null : parts[teamIndex + 1];
      const team = teams.find(t => t.id === teamId);
      if (path.endsWith('/grants')) {
        grants.push({ teamId: body.teamId, target: body.target });
      } else if (path.endsWith('/role')) {
        const id = parts.at(-2);
        team.managerIds =
          body.role === 'manager' ? [...new Set([...team.managerIds, id])] : team.managerIds.filter(m => m !== id);
      } else if (path.endsWith('/leave')) {
        team.membershipIds = team.membershipIds.filter(m => m !== actorId);
        team.managerIds = team.managerIds.filter(m => m !== actorId);
      } else if (path.includes('/members/')) {
        const id = parts.at(-1);
        team.membershipIds = body.enrolled
          ? [...new Set([...team.membershipIds, id])]
          : team.membershipIds.filter(m => m !== id);
      } else if (path.endsWith('/name')) {
        team.name = body.name;
        team.description = body.description;
      } else if (teamIndex >= 0 && !team)
        teams.push({
          id: teamId,
          name: body.name,
          description: body.description,
          membershipIds: [actorId],
          managerIds: [actorId],
        });
      else throw new Error(`Unexpected write ${path}`);
      json = { ok: true };
    } else {
      status = 404;
      json = { error: 'fixture-route-missing' };
    }
    await route.fulfill({
      status,
      json,
      headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' },
    });
  });
  const refresh = () => workspaceChange(page, workspace.id, 'ada', [['governance', 'administration']]);
  failed = true;
  await page.goto(`${origin}/team-proof/teams`);
  await page.getByRole('heading', { name: 'Could not load workspace access' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'No teams yet' }).count(), 0);
  failed = false;
  delay = 250;
  await page.getByRole('button', { name: 'Retry loading' }).click();
  await page.getByRole('heading', { name: 'No teams yet' }).waitFor();
  await page.getByRole('button', { name: 'New team', exact: true }).click();
  await page.getByLabel('New team name').fill('Private operations');
  await page.getByRole('button', { name: 'Create team', exact: true }).dblclick();
  await page.getByRole('heading', { name: 'Private operations details', exact: true }).waitFor();
  assert.equal(writes, 1);
  assert.equal(await page.getByRole('button', { name: 'Leave team', exact: true }).isDisabled(), true);
  await page.getByRole('checkbox', { name: 'Ben (ben@example.com)' }).check();
  await page.getByRole('button', { name: 'Add selected members (1)' }).click();
  await page.getByRole('heading', { name: 'Team members (2)' }).waitFor();
  await page.getByLabel('Team role for Ben').click();
  await page.getByRole('option', { name: 'Manager', exact: true }).click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some(b => b.textContent === 'Leave team' && !b.disabled),
  );
  await page.getByLabel('Team name', { exact: true }).fill('Renamed operations');
  await page.getByRole('button', { name: 'Save team details' }).click();
  await page.getByRole('heading', { name: 'Renamed operations details', exact: true }).waitFor();
  failed = true;
  await refresh();
  await page.getByRole('button', { name: 'Reload access' }).waitFor();
  assert.equal(await page.getByLabel('Team name', { exact: true }).inputValue(), 'Renamed operations');
  failed = false;
  await page.getByRole('button', { name: 'Reload access' }).click();
  await page.getByRole('button', { name: 'Reload access' }).waitFor({ state: 'hidden' });
  await page.getByLabel('Team role for Ada').click();
  await page.getByRole('option', { name: 'Member', exact: true }).click();
  await page.getByRole('button', { name: 'Save team details' }).waitFor({ state: 'hidden' });
  assert.equal(await page.getByLabel('Search workspace members').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Delete team' }).count(), 0);
  await page.getByRole('heading', { name: 'Team members (2)' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: 'Leave team', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm leave team' }).click();
  await page.getByRole('heading', { name: 'No teams yet' }).waitFor();
  await page.goto(`${origin}/team-proof/members`);
  await page.getByRole('heading', { name: 'Workspace directory' }).waitFor();
  await page.getByText('ben@example.com', { exact: true }).waitFor();
  admin = true;
  await page.goto(`${origin}/team-proof/grants`);
  await page.getByLabel('Team receiving access').click();
  await page.getByRole('option', { name: `Team ${hiddenTeam}`, exact: true }).click();
  await page.getByRole('checkbox', { name: 'Read rows', exact: true }).click();
  for (let n = 0; grants.length === 0; n++) {
    assert.ok(n < 100);
    await setTimeout(50);
  }
  await page.getByLabel('Team receiving access').waitFor();
  await page.getByLabel('Team receiving access').click();
  await page.getByRole('option', { name: `Team ${hiddenTeam}`, exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[role="checkbox"][aria-checked="true"]'));
  assert.equal(grants[0].teamId, hiddenTeam);
  assert.equal(await page.getByText('Private operations', { exact: true }).count(), 0);
  assert.equal(await page.getByText('Renamed operations', { exact: true }).count(), 0);
  assert.equal(await page.getByLabel('Owning team', { exact: true }).innerText(), `Team ${hiddenTeam}`);
  assert.deepEqual(errors, []);
  process.stdout.write(
    'Verified ordinary creator and manager controls, handoff, read-only team membership, directory, opaque table grants, loading/error recovery and mobile layout.\n',
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await new Promise(resolve => server.once('exit', resolve));
}
