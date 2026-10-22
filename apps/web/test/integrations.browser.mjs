import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { governanceSnapshot } from './governance-snapshot.mjs';
import { shellRead } from './shell-reads.mjs';

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright'
);
const port = Number(process.env.INTEGRATIONS_BROWSER_PORT ?? 5198);
const origin = `http://127.0.0.1:${port}`;
const server = spawn(
  'pnpm',
  [
    'exec',
    'vite',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
    ...(process.env.INTEGRATIONS_VITE_CONFIG ? ['--config', process.env.INTEGRATIONS_VITE_CONFIG] : []),
  ],
  { cwd: new URL('..', import.meta.url), stdio: 'ignore' },
);
let browser;
try {
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {
      if (attempt === 100) throw new Error('Integrations browser server did not start');
    }
    await setTimeout(100);
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(15_000);
  const select = async (label, option) => {
    await page.getByLabel(label, { exact: true }).click();
    await page.getByRole('option', { name: option, exact: true }).click();
  };
  page.setDefaultNavigationTimeout(60000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const workspaceId = '11111111-1111-4111-8111-111111111111';
  const membershipId = '22222222-2222-4222-8222-222222222222';
  const teamId = '33333333-3333-4333-8333-333333333333';
  const secondTeamId = '44444444-4444-4444-8444-444444444444';
  const workspace = {
    id: workspaceId,
    name: 'Acme',
    slug: 'acme',
    createdAt: '2026-09-27T00:00:00.000Z',
    status: 'ready',
    soulCommit: 'a'.repeat(40),
  };
  const teams = [
    { id: teamId, name: 'Engineering', description: '', membershipIds: [membershipId] },
    { id: secondTeamId, name: 'Support', description: '', membershipIds: [] },
  ];
  const snapshot = governanceSnapshot({
    actorMembershipId: membershipId,
    members: [{ id: membershipId, userId: 'ada', name: 'Ada', email: 'ada@example.com', role: 'admin' }],
    teams,
    resources: [],
    grants: [],
  });
  let admin = true;
  let memberDestinations = [];
  let creationStatus = 200;
  let listStatus = 503;
  let detailStatus = 200;
  let delay = 0;
  let writeStatus = 200;
  let dropWrite = false;
  let issueFails = false;
  const integrations = [];
  const writes = [];
  const issueRequests = [];
  let creationTeams = [];
  let creationVersion = 'a'.repeat(64);
  const capabilities = { read: true, use: true, manage: true, administer: true };
  await page.route('**/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    let status = 200;
    let json;
    // The shell's own writes (last-used, visit) are not integration writes.
    const shellWrite = method === 'GET' ? undefined : shellRead(method, path, workspace);
    if (shellWrite) {
      await route.fulfill({
        ...shellWrite,
        headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' },
      });
      return;
    }
    if (path === '/v1/auth/get-session')
      json = { session: { id: 'session', userId: 'ada' }, user: { id: 'ada', name: 'Ada', email: 'ada@example.com' } };
    else if (path === '/v1/workspaces') json = [workspace];
    else if (path === '/v1/workspaces/acme') json = workspace;
    else if (path.endsWith('/governance/me'))
      json = {
        membershipId,
        role: admin ? 'admin' : 'member',
        teams: [],
        capabilities: { manageGovernance: admin, canLeave: true },
      };
    else if (path.endsWith('/governance/directory'))
      json = { members: [{ id: membershipId, name: 'Ada', email: 'ada@example.com', image: null }] };
    // Editor recipients come from the integration collaborators read since cloud e445ed86 (#478), src/lib/integrations.ts:26.
    else if (path.endsWith('/integrations/collaborators')) {
      status = admin ? 200 : 404;
      json = admin
        ? { teams: teams.map(({ id, name }) => ({ id, name })), members: [{ id: membershipId, name: 'Ada' }] }
        : { error: 'not-found' };
    } else if (path.endsWith('/governance')) {
      status = admin ? 200 : 404;
      json = admin ? snapshot : { error: 'governance-not-found' };
    } else if (path.endsWith('/integrations/creation-context')) {
      status = creationStatus;
      json =
        status === 200
          ? {
              teams: (admin ? teams : teams.filter(team => memberDestinations.includes(team.id))).map(
                ({ id, name }) => ({ id, name }),
              ),
            }
          : { error: 'unavailable' };
    } else if (path.includes('/integrations/creation-grants/'))
      json = { owningTeamId: path.split('/').at(-1), teamIds: creationTeams, version: creationVersion };
    else if (path.endsWith('/integrations/creation-grants')) {
      const body = request.postDataJSON();
      writes.push({ path, method, body });
      await setTimeout(250);
      status = writeStatus;
      if (status === 200) {
        memberDestinations = body.teamIds.includes(teamId) ? [body.owningTeamId] : [];
        creationTeams = body.teamIds;
        creationVersion = 'b'.repeat(64);
        json = { owningTeamId: body.owningTeamId, teamIds: body.teamIds };
      } else json = { error: 'rejected' };
    } else if (path.endsWith('/integrations/read-issue')) {
      const body = request.postDataJSON();
      issueRequests.push(body);
      await setTimeout(200);
      if (issueFails) {
        await route.abort('failed');
        return;
      }
      json = {
        number: body.issueNumber,
        title: 'Fix invoice export',
        body: 'A bounded issue description. <script>unsafe()</script>',
        state: 'open',
        url: 'https://github.com/acme/billing/issues/17',
      };
    } else if (path.endsWith('/integrations') && method === 'GET') {
      await setTimeout(delay);
      status = listStatus;
      json =
        status === 200
          ? {
              integrations: integrations
                .filter(item => admin || item.capabilities.read)
                .map(
                  ({ repositories: _repositories, grants: _grants, sourceGrants: _sources, ...metadata }) => metadata,
                ),
            }
          : { error: 'unavailable' };
    } else if (method === 'GET') {
      await setTimeout(delay);
      status = detailStatus;
      const item = integrations.find(integration => path.endsWith(integration.id));
      if (!admin && item && !item.capabilities.read) status = 404;
      json = status === 200 && item ? structuredClone(item) : { error: 'unavailable' };
      if (!item) status = 404;
      if (!admin && item && status === 200) {
        delete json.grants;
        delete json.sourceGrants;
      }
    } else {
      const body = method === 'DELETE' ? undefined : request.postDataJSON();
      writes.push({ path, method, body });
      await setTimeout(250);
      status = writeStatus;
      if (status === 200) {
        if (path.endsWith('/integrations')) {
          const existing = integrations.find(item => item.id === body.id);
          const item = existing ?? {
            id: body.id,
            name: body.name,
            owningTeamId: body.owningTeamId,
            enabled: true,
            generation: 1,
            grantsVersion: 1,
            capabilities: admin ? { ...capabilities } : { read: false, use: false, manage: false, administer: false },
            repositories: body.repositories.map(repository => ({ ...repository, canReadIssues: true })),
            grants: [],
            sourceGrants: [],
          };
          if (!existing) integrations.push(item);
          const { repositories: _repositories, grants: _grants, sourceGrants: _sources, ...metadata } = item;
          json = metadata;
        } else {
          const item = integrations[0];
          if (path.endsWith('/rotate')) {
            assert.equal(body.expectedGeneration, item.generation);
            item.generation++;
          } else if (path.endsWith('/grants')) {
            if (body.expectedGrantsVersion !== item.grantsVersion) {
              status = 409;
              json = { error: 'conflict' };
            } else {
              item.grants = body.grants;
              item.sourceGrants = body.sourceGrants;
              item.grantsVersion++;
            }
          } else if (path.endsWith('/owner')) item.owningTeamId = body.owningTeamId;
          else if (method === 'DELETE') {
            integrations.splice(0, 1);
            json = { removed: true };
          } else Object.assign(item, body);
          json ??= structuredClone(item);
        }
        if (dropWrite) {
          dropWrite = false;
          await route.abort('failed');
          return;
        }
      } else json = { error: 'rejected' };
    }
    await route.fulfill({
      status,
      json,
      headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' },
    });
  });
  await page.goto(`${origin}/acme/integrations#github-integrations`);
  await page.getByRole('heading', { name: 'Could not load integrations' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'No integrations available' }).count(), 0);
  await page.getByRole('button', { name: 'Retry loading integrations', exact: true }).click();
  await setTimeout(4500);
  await page.getByRole('heading', { name: 'Could not load integrations' }).waitFor();
  listStatus = 200;
  delay = 400;
  await page.getByRole('button', { name: 'Retry loading integrations', exact: true }).click();
  await page.getByRole('heading', { name: 'No integrations available' }).waitFor();
  await page.getByRole('button', { name: 'Add GitHub integration', exact: true }).click();
  await page.getByLabel('Integration name', { exact: true }).fill('Billing GitHub');
  await select('Owning team', 'Engineering');
  await page.getByLabel('GitHub token', { exact: true }).fill('browser-only-create-secret');
  await page.getByLabel('Repository 1 owner').fill('acme');
  await page.getByLabel('Repository 1 name').fill('billing');
  listStatus = 503;
  await page.getByRole('button', { name: 'Refresh integrations', exact: true }).click();
  // The sheet's app status reads the same list since 3ceeb002 (#286), so the setup panel shows its own copy of the error.
  await page
    .getByRole('region', { name: 'Team GitHub setup', exact: true })
    .getByText('The request could not be completed. Check your connection and try again.', { exact: true })
    .waitFor();
  assert.equal(await page.getByLabel('Integration name', { exact: true }).inputValue(), 'Billing GitHub');
  assert.equal(await page.getByLabel('GitHub token', { exact: true }).getAttribute('type'), 'password');
  writeStatus = 409;
  await page.getByRole('button', { name: 'Create integration', exact: true }).click();
  await page.getByText(/request conflicts with saved work/).waitFor();
  assert.equal(await page.getByLabel('GitHub token', { exact: true }).inputValue(), 'browser-only-create-secret');
  writeStatus = 200;
  listStatus = 200;
  delay = 0;
  dropWrite = true;
  const beforeCreate = writes.length;
  await page.getByRole('button', { name: 'Create integration', exact: true }).dblclick();
  await page.getByRole('button', { name: 'Check creation status', exact: true }).waitFor();
  assert.equal(writes.length, beforeCreate + 1);
  const createRequest = writes.at(-1);
  assert.equal(await page.getByLabel('Integration name', { exact: true }).isDisabled(), true);
  listStatus = 404;
  admin = false;
  await page.getByRole('button', { name: 'Refresh integrations', exact: true }).click();
  await page.getByRole('heading', { name: 'Integrations unavailable', exact: true }).waitFor();
  assert.equal(await page.getByLabel('GitHub token', { exact: true }).count(), 0);
  listStatus = 200;
  admin = true;
  await page.getByRole('button', { name: 'Refresh integrations', exact: true }).click();
  await page.getByRole('button', { name: 'Check creation status', exact: true }).waitFor();
  assert.equal(await page.getByLabel('GitHub token', { exact: true }).inputValue(), 'browser-only-create-secret');
  assert.equal(await page.getByLabel('Integration name', { exact: true }).isDisabled(), true);
  assert.equal(writes.length, beforeCreate + 1);
  await page.getByRole('button', { name: 'Check creation status', exact: true }).click();
  await page.getByRole('heading', { name: 'Billing GitHub', exact: true }).waitFor();
  assert.equal(writes.length, beforeCreate + 1);
  assert.equal(integrations[0].id, createRequest.body.id);
  assert.equal(await page.getByLabel('GitHub token', { exact: true }).inputValue(), '');
  assert.equal(
    await page
      .getByRole('heading', { name: 'Billing GitHub', exact: true })
      .evaluate(element => document.activeElement === element),
    true,
  );
  assert.equal(await page.getByText('browser-only-create-secret', { exact: false }).count(), 0);
  assert.equal(await page.getByRole('checkbox', { name: 'Use integration', exact: true }).first().isChecked(), false);
  await page.getByRole('checkbox', { name: 'Use integration', exact: true }).first().click();
  await page.getByText('Select Read metadata explicitly for every team receiving Use or Manage.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Save team grants', exact: true }).isDisabled(), true);
  await page.getByRole('checkbox', { name: 'Read metadata', exact: true }).first().click();
  await page.getByRole('checkbox', { name: 'Read issues in acme/billing', exact: true }).first().click();
  await page.getByRole('button', { name: 'Save team grants', exact: true }).click();
  await page.getByText('Save grants confirmed.', { exact: true }).waitFor();
  assert.deepEqual(writes.at(-1).body, {
    expectedGrantsVersion: 1,
    grants: [{ teamId, permissions: ['use', 'read'] }],
    sourceGrants: [{ teamId, sourceId: createRequest.body.repositories[0].id }],
  });
  await select('Transfer to team', 'Support');
  await page.getByRole('button', { name: 'Transfer ownership', exact: true }).click();
  await page.getByText('Transfer ownership confirmed.', { exact: true }).waitFor();
  assert.equal(integrations[0].owningTeamId, secondTeamId);
  assert.deepEqual(integrations[0].grants, [{ teamId, permissions: ['use', 'read'] }]);
  integrations[0].grants = [{ teamId, permissions: ['read'] }];
  integrations[0].sourceGrants = [];
  integrations[0].grantsVersion++;
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith(`/integrations/${integrations[0].id}`)),
    page.getByRole('button', { name: 'Refresh integrations', exact: true }).click(),
  ]);
  await page.getByRole('button', { name: 'Save team grants', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('checkbox', { name: 'Use integration', exact: true }).first().isChecked(),
    false,
    'Untouched grant controls reflect the second admin revocation',
  );
  assert.equal(
    await page.getByRole('checkbox', { name: 'Read issues in acme/billing', exact: true }).first().isChecked(),
    false,
  );
  await page.getByRole('checkbox', { name: 'Use integration', exact: true }).first().click();
  await page.getByRole('checkbox', { name: 'Read issues in acme/billing', exact: true }).first().click();
  integrations[0].grants = [];
  integrations[0].grantsVersion++;
  const beforeConflict = writes.length;
  await page.getByRole('button', { name: 'Refresh integrations', exact: true }).click();
  await page.getByText(/Another manager changed these grants/).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: 'Use integration', exact: true }).first().isChecked(), true);
  assert.equal(await page.getByRole('button', { name: 'Save team grants', exact: true }).isDisabled(), true);
  assert.equal(writes.length, beforeConflict);
  detailStatus = 503;
  await page.getByRole('button', { name: 'Reload grants', exact: true }).click();
  await page
    .getByText('The request could not be completed. Check your connection and try again.', { exact: true })
    .waitFor();
  assert.equal(await page.getByRole('checkbox', { name: 'Use integration', exact: true }).first().isChecked(), true);
  detailStatus = 200;
  await page.getByRole('button', { name: 'Reload grants', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Read metadata', exact: true }).first().waitFor();
  await page.waitForFunction(() => !document.querySelector('[id$="-read"]').checked);
  assert.equal(await page.getByRole('checkbox', { name: 'Use integration', exact: true }).first().isChecked(), false);
  assert.equal(
    await page.getByRole('checkbox', { name: 'Read issues in acme/billing', exact: true }).first().isChecked(),
    false,
  );
  await page.getByRole('checkbox', { name: 'Read metadata', exact: true }).first().click();
  integrations[0].grantsVersion++;
  await page.getByRole('button', { name: 'Save team grants', exact: true }).click();
  await page.getByText(/Another manager changed these grants/).waitFor();
  assert.equal(writes.at(-1).body.expectedGrantsVersion, 4);
  assert.deepEqual(integrations[0].grants, []);
  await page.getByRole('button', { name: 'Reload grants', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[id$="-read"]').checked);
  await page.getByRole('checkbox', { name: 'Read metadata', exact: true }).first().click();
  await page.getByRole('button', { name: 'Save team grants', exact: true }).click();
  await page.getByText('Save grants confirmed.', { exact: true }).waitFor();
  assert.deepEqual(writes.at(-1).body, {
    expectedGrantsVersion: 5,
    grants: [{ teamId, permissions: ['read'] }],
    sourceGrants: [],
  });
  // The creation-grants editor (cloud src/features/integrations/setup.tsx:82) is not rendered anywhere since e445ed86 (#478); grant Engineering creation into Support through the API instead.
  assert.equal(await page.getByRole('button', { name: 'Who can create GitHub integrations', exact: true }).count(), 0);
  memberDestinations = [secondTeamId];
  creationTeams = [teamId];
  admin = false;
  await page.getByRole('button', { name: 'Refresh integrations', exact: true }).click();
  await page.getByLabel('Owning team', { exact: true }).click();
  await page.getByRole('option', { name: 'Select a team', exact: true }).waitFor();
  assert.deepEqual(await page.getByRole('option').allTextContents(), ['Select a team', 'Support']);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('heading', { name: 'Integration creation grants', exact: true }).count(), 0);
  await page.getByLabel('Integration name', { exact: true }).fill('Member integration');
  creationStatus = 503;
  await page.getByRole('button', { name: 'Refresh integrations', exact: true }).click();
  await page.getByText(/Could not check integration creation access/).waitFor();
  assert.equal(await page.getByLabel('Integration name', { exact: true }).count(), 0);
  creationStatus = 200;
  await page.getByRole('button', { name: 'Refresh integrations', exact: true }).click();
  await page.getByLabel('Integration name', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Integration name', { exact: true }).inputValue(), 'Member integration');
  await select('Owning team', 'Support');
  await page.getByLabel('GitHub token', { exact: true }).fill('member-create-secret');
  await page.getByLabel('Repository 1 owner').fill('acme');
  await page.getByLabel('Repository 1 name').fill('support');
  dropWrite = true;
  await page.getByRole('button', { name: 'Create integration', exact: true }).click();
  await page.getByRole('button', { name: 'Retry saved request', exact: true }).waitFor();
  const originalMemberRequest = writes.at(-1).body;
  const beforeMemberRetry = writes.length;
  await page.getByRole('button', { name: 'Check creation status', exact: true }).click();
  await page.getByText(/Creation is still unconfirmed or you do not have read access/).waitFor();
  assert.equal(writes.length, beforeMemberRetry);
  assert.equal(await page.getByLabel('Integration name', { exact: true }).isDisabled(), true);
  assert.equal(await page.getByLabel('GitHub token', { exact: true }).inputValue(), 'member-create-secret');
  writeStatus = 404;
  await page.getByRole('button', { name: 'Retry saved request', exact: true }).dblclick();
  await page
    .getByText('This integration or action is unavailable. A manager may have changed your access.', { exact: true })
    .waitFor();
  assert.equal(writes.length, beforeMemberRetry + 1);
  assert.deepEqual(writes.at(-1).body, originalMemberRequest);
  assert.equal(await page.getByLabel('Integration name', { exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Create integration', exact: true }).count(), 0);
  writeStatus = 200;
  dropWrite = true;
  await page.getByRole('button', { name: 'Retry saved request', exact: true }).click();
  await page
    .getByText(
      'The response could not be confirmed. Check status before submitting again. Your inputs remain in this tab.',
      { exact: true },
    )
    .waitFor();
  assert.equal(writes.length, beforeMemberRetry + 2);
  assert.deepEqual(writes.at(-1).body, originalMemberRequest);
  assert.equal(integrations.length, 2);
  await page.getByText(/Retrying will not create a second integration/).waitFor();
  await page.getByRole('button', { name: 'Retry saved request', exact: true }).dblclick();
  await page
    .getByText('Integration saved. You can grant metadata access, use, management, and repository scope separately.', {
      exact: true,
    })
    .waitFor();
  assert.equal(writes.length, beforeMemberRetry + 3);
  assert.deepEqual(writes.at(-1).body, originalMemberRequest);
  assert.equal(integrations.length, 2);
  assert.equal(await page.getByRole('button', { name: 'Open Member integration', exact: true }).count(), 0);
  for (const label of ['Integration name', 'GitHub token', 'Repository 1 owner', 'Repository 1 name']) {
    assert.equal(await page.getByLabel(label, { exact: true }).inputValue(), '');
    assert.equal(await page.getByLabel(label, { exact: true }).isEnabled(), true);
  }
  assert.equal(await page.getByLabel('Owning team', { exact: true }).innerText(), 'Select a team');
  assert.equal(await page.getByLabel('Owning team', { exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Retry saved request', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Check creation status', exact: true }).count(), 0);
  assert.equal(writes.at(-1).body.owningTeamId, secondTeamId);
  integrations.pop();
  admin = true;
  await page.getByRole('button', { name: 'Open Billing GitHub', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh integrations', exact: true }).click();
  await page.getByRole('heading', { name: 'Team grants', exact: true }).waitFor();
  memberDestinations = [];
  await page.getByLabel('Replacement GitHub token').fill('browser-only-rotation-secret');
  dropWrite = true;
  await page.getByRole('button', { name: 'Rotate token', exact: true }).dblclick();
  await page.getByText(/Rotate token is unconfirmed/).waitFor();
  assert.equal(writes.at(-1).body.expectedGeneration, 1);
  const rotationCount = writes.filter(item => item.path.endsWith('/rotate')).length;
  await page.getByRole('button', { name: 'Check uncertain change status', exact: true }).click();
  await page.getByText(/Current generation is 2/).waitFor();
  assert.equal(writes.filter(item => item.path.endsWith('/rotate')).length, rotationCount);
  await page.getByRole('button', { name: 'Finish status review', exact: true }).click();
  assert.equal(await page.getByLabel('Replacement GitHub token').inputValue(), '');
  // Investigation permissions also have a Repository field since cloud 6a97dbef (#1044), investigation-grants.tsx:47.
  await page
    .locator('form')
    .filter({ has: page.getByRole('button', { name: 'Read issue', exact: true }) })
    .getByLabel('Repository', { exact: true })
    .click();
  await page.getByRole('option', { name: 'acme/billing', exact: true }).click();
  await page.getByLabel('Issue number', { exact: true }).fill('17');
  issueFails = true;
  await page.getByRole('button', { name: 'Read issue', exact: true }).dblclick();
  await page.getByRole('button', { name: 'Retry reading issue', exact: true }).waitFor();
  assert.equal(issueRequests.length, 1);
  issueFails = false;
  await page.getByRole('button', { name: 'Retry reading issue', exact: true }).click();
  await page.getByRole('heading', { name: '#17 Fix invoice export', exact: true }).waitFor();
  assert.deepEqual(issueRequests[1], issueRequests[0]);
  assert.equal(
    await page.getByText('A bounded issue description. <script>unsafe()</script>', { exact: true }).count(),
    1,
  );
  await page.getByRole('button', { name: 'Disable integration', exact: true }).click();
  await page.getByText('Disable integration confirmed.', { exact: true }).waitFor();
  assert.equal(writes.at(-1).body.enabled, false);
  await page.getByRole('button', { name: 'Enable integration', exact: true }).click();
  await page.getByText('Enable integration confirmed.', { exact: true }).waitFor();
  assert.equal(writes.at(-1).body.enabled, true);
  await page.getByLabel('Saved integration name').fill('Retained management draft');
  admin = false;
  integrations[0].capabilities = { read: true, use: false, manage: false, administer: false };
  integrations[0].repositories[0].canReadIssues = false;
  await page.getByRole('button', { name: 'Refresh integrations', exact: true }).click();
  await page.getByText(/Management alone does not permit reading issues/).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Connect GitHub', exact: true }).count(), 0);
  assert.equal(await page.getByLabel('Saved integration name').count(), 0);
  assert.equal(await page.getByRole('heading', { name: 'Team grants', exact: true }).count(), 0);
  assert.equal(await page.getByRole('heading', { name: '#17 Fix invoice export', exact: true }).count(), 0);
  assert.equal(await page.getByRole('heading', { name: 'Billing GitHub', exact: true }).count(), 1);
  integrations[0].capabilities = { read: true, use: false, manage: true, administer: false };
  await page.getByRole('button', { name: 'Refresh integrations', exact: true }).click();
  await page.getByLabel('Saved integration name').waitFor();
  assert.equal(await page.getByLabel('Saved integration name').inputValue(), 'Retained management draft');
  assert.equal(await page.getByRole('button', { name: 'Read issue', exact: true }).count(), 0);
  assert.equal(await page.getByRole('heading', { name: 'Team grants', exact: true }).count(), 0);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement !== document.body), true);
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('browser-only')), false);
  assert.equal(page.url().includes('browser-only'), false);
  detailStatus = 404;
  await page.getByRole('button', { name: 'Check integration status', exact: true }).click();
  await page.getByRole('heading', { name: 'Integration status unavailable', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Replacement GitHub token').count(), 0);
  detailStatus = 200;
  await page.getByRole('button', { name: 'Check integration status', exact: true }).click();
  await page.getByLabel('Saved integration name').waitFor();
  assert.equal(await page.getByLabel('Saved integration name').inputValue(), 'Retained management draft');
  await page
    .getByRole('checkbox', { name: 'Delete this integration and stop future use. This cannot be undone.', exact: true })
    .click();
  await page.getByRole('button', { name: 'Delete integration', exact: true }).click();
  await page.getByRole('heading', { name: 'No integrations available', exact: true }).waitFor();
  assert.equal(writes.at(-1).method, 'DELETE');
  assert.deepEqual(errors, []);
  process.stdout.write(
    'Integrations browser checks passed. Initial and repeated read failure, empty recovery, retained drafts, untouched grant refresh, two-admin dirty conflict and explicit reload, failed reload retention, stale CAS rejection and recovery, creation-grant replacement and failure recovery, creation-only member receipt recovery with immutable replay after rejection and repeated response loss, cleared drafts, creation-context failure recovery, explicit grants and repository scope, transfer, duplicate suppression, uncertain create and rotation status checks, stable issue retry, bounded text result, enable/disable/delete, member and management-only controls, access loss/restoration, mobile dark mode and keyboard.\n',
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
