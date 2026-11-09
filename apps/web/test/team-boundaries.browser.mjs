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
    adminTeam = randomUUID(),
    tableId = 'aaaaaaaa-1111-4111-8111-111111111111',
    namesakeId = 'bbbbbbbb-2222-4222-8222-222222222222';
  const directory = [
    { id: actorId, name: 'Ada', email: 'ada@example.com', image: null, role: 'member' },
    { id: otherId, name: 'Ben', email: 'ben@example.com', image: null, role: 'member' },
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
            adminTeamId: admin ? adminTeam : null,
            tables: admin
              ? [
                  { id: tableId, name: 'Invoices', owningTeamId: hiddenTeam },
                  { id: namesakeId, name: 'invoices', owningTeamId: adminTeam },
                ]
              : [],
            grants: admin ? grants : [],
            teamNames: [],
            personGrants: [],
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
      if (path.endsWith('/role')) {
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
  const tab = name => page.getByRole('tab', { name, exact: true }).click();
  failed = true;
  await page.goto(`${origin}/team-proof/teams`);
  await page.getByRole('heading', { name: 'Couldn’t load workspace access' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'No teams yet' }).count(), 0);
  failed = false;
  delay = 250;
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.getByRole('heading', { name: 'No teams yet' }).waitFor();
  await page.getByRole('button', { name: 'Create a team', exact: true }).click();
  await page.getByLabel('New team name').fill('Private operations');
  await page.getByRole('button', { name: 'Create team', exact: true }).dblclick();
  await page.getByRole('heading', { name: 'Private operations', exact: true }).waitFor();
  assert.equal(writes, 1, 'a double click creates one team');
  await tab('Settings');
  await page.getByText('You’re the only manager. Make someone else a manager before you leave.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Leave team', exact: true }).isDisabled(), true);
  await tab('Members');
  await page.getByRole('button', { name: 'Add members', exact: true }).click();
  const adding = page.getByRole('dialog', { name: 'Add members to Private operations' });
  await adding.getByRole('checkbox', { name: 'Ben' }).check();
  await adding.getByRole('button', { name: 'Add to team', exact: true }).click();
  await adding.waitFor({ state: 'hidden' });
  const roster = page.getByRole('table', { name: 'Members of Private operations' });
  await roster.getByText('ben@example.com', { exact: true }).waitFor();
  await page.getByLabel('Team role for Ben in Private operations').click();
  await page.getByRole('option', { name: 'Manager', exact: true }).click();
  await page.getByText('Ben is now a manager of Private operations.', { exact: true }).waitFor();
  await tab('Settings');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some(b => b.textContent === 'Leave team' && !b.disabled),
  );
  await page.getByLabel('Team name', { exact: true }).fill('Renamed operations');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('heading', { name: 'Renamed operations', exact: true }).waitFor();
  failed = true;
  await refresh();
  await page.getByRole('button', { name: 'Reload access' }).waitFor();
  assert.equal(await page.getByLabel('Team name', { exact: true }).inputValue(), 'Renamed operations');
  failed = false;
  await page.getByRole('button', { name: 'Reload access' }).click();
  await page.getByRole('button', { name: 'Reload access' }).waitFor({ state: 'hidden' });
  await tab('Members');
  await page.getByLabel('Team role for Ada in Renamed operations').click();
  await page.getByRole('option', { name: 'Member', exact: true }).click();
  await page.getByRole('button', { name: 'Add members', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.getByLabel('Team role for Ben in Renamed operations').count(), 0, 'members see roles only');
  await tab('Settings');
  assert.equal(await page.getByLabel('Team name', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Delete Renamed operations' }).count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: 'Leave team', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Leave Renamed operations?' })
    .getByRole('button', { name: 'Leave team' })
    .click();
  await page.getByRole('heading', { name: 'You can’t view this team' }).waitFor();
  await page.goto(`${origin}/team-proof/members`);
  await page.getByText('ben@example.com', { exact: true }).waitFor();
  await page.setViewportSize({ width: 1280, height: 900 });

  admin = true;
  grants.push({ teamId: hiddenTeam, target: { kind: 'table', id: tableId, permission: 'table.row.read' } });
  await page.goto(`${origin}/team-proof/grants`);
  const invoices = `Invoices · Team ${hiddenTeam.slice(0, 8)} · aaaaaaaa`,
    namesake = 'invoices · Workspace admins · bbbbbbbb';
  await page.getByRole('heading', { name: invoices, exact: true }).waitFor();
  await page.getByRole('heading', { name: namesake, exact: true }).waitFor();
  assert.equal(
    await page.getByLabel(`Owning team for ${invoices}`, { exact: true }).innerText(),
    'A team you can’t see',
  );
  assert.equal(await page.getByLabel(`Owning team for ${namesake}`, { exact: true }).innerText(), 'Workspace admins');
  await page
    .getByRole('table', { name: `Who can use ${invoices}` })
    .getByText('A team you can’t see')
    .waitFor();
  await page
    .getByRole('article', { name: namesake, exact: true })
    .getByText('Only admins can use this table.', { exact: true })
    .waitFor();
  assert.equal(await page.getByText('Private operations', { exact: true }).count(), 0);
  assert.equal(await page.getByText('Renamed operations', { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  process.stdout.write(
    'Verified ordinary creator and manager controls, handoff, read-only team membership, directory, opaque and workspace-admin table owners, duplicate table names, loading/error recovery and mobile layout.\n',
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await new Promise(resolve => server.once('exit', resolve));
}
