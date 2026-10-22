import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright'
);
const origin = 'http://127.0.0.1:5298';
const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', '5298', '--strictPort'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
});
let browser;
try {
  for (let n = 0; ; n++) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {}
    assert.ok(n < 100);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const workspace = {
    id: randomUUID(),
    name: 'Slack proof',
    slug: 'slack-proof',
    createdAt: '2026-09-30T00:00:00.000Z',
    status: 'ready',
    soulCommit: 'a'.repeat(40),
  };
  const agentId = randomUUID(),
    team = randomUUID();
  let status = 503,
    version = 0,
    attached = null,
    checks = 0;
  const writes = [];
  await page.route('**/v1/**', async route => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    let json;
    if (path === '/v1/auth/get-session')
      json = { session: { id: 'session', userId: 'bob' }, user: { id: 'bob', name: 'Bob', email: 'bob@example.test' } };
    else if (path === '/v1/workspaces') json = [workspace];
    else if (path === '/v1/workspaces/slack-proof') json = workspace;
    else if (path.endsWith('/governance/me'))
      json = {
        membershipId: team,
        role: 'member',
        teams: [],
        capabilities: { manageGovernance: false, canLeave: true },
      };
    else if (path.endsWith('/agents/authoring-context'))
      json = { currentSoulRevision: 'a'.repeat(40), teams: [], admin: false };
    else if (path.endsWith(`/agents/${agentId}`))
      json = {
        id: agentId,
        name: 'HR',
        owningTeamId: team,
        savedRevision: 'a'.repeat(40),
        definitionRevision: 'b'.repeat(64),
        definition: { name: 'HR', instructions: 'Answer HR questions.', tools: [] },
        capabilities: ['read', 'invoke'],
        admin: false,
        activations: [],
      };
    else if (path.includes('/slack/channels/')) {
      if (req.method() === 'GET') checks++;
      await new Promise(resolve => setTimeout(resolve, 400));
      if (status !== 200) return route.fulfill({ status, json: { error: 'slack-channels-disabled' } });
      if (req.method() === 'PUT') {
        writes.push(req.postDataJSON());
        version++;
        attached = agentId;
        json = { version, channelResponses: false };
      }
      // Channel reads report whether any agent holds the channel (cloud slack-queries.ts:30, packages/agents slack-channels.ts:127).
      else json = { version, agentId: attached, occupied: Boolean(attached), channelResponses: false };
    } else return route.fulfill({ status: 404, json: { error: 'unavailable' } });
    return route.fulfill({ json });
  });
  await page.goto(`${origin}/slack-proof/agents/${agentId}`);
  await page.getByRole('tab', { name: 'Slack', exact: true }).click();
  await page.getByRole('button', { name: 'Use a channel ID instead', exact: true }).click();
  await page.getByLabel('Slack channel ID', { exact: true }).fill('chr');
  await page.getByRole('button', { name: 'Check channel', exact: true }).click();
  await page.getByText('Enter a channel ID that starts with C or G.', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Slack channel ID', { exact: true }).getAttribute('aria-invalid'), 'true');
  await page.waitForFunction(() => document.activeElement?.id === 'agent-slack-channel');
  assert.equal(checks, 0);
  await page.getByLabel('Slack channel ID', { exact: true }).fill('CHR');
  await page.getByRole('button', { name: 'Check channel', exact: true }).click();
  await page.getByText('Checking channel…', { exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Could not check the channel' }).waitFor();
  assert.equal(await page.getByLabel('Slack channel ID', { exact: true }).inputValue(), 'CHR');
  status = 200;
  await page.getByRole('button', { name: 'Check channel again' }).click();
  await page.getByText('No agent is attached to this channel.', { exact: true }).waitFor();
  status = 503;
  await page.getByRole('button', { name: 'Attach agent', exact: true }).click();
  await page.getByRole('button', { name: 'Check status again', exact: true }).waitFor();
  const attach = page.getByRole('button', { name: 'Attach agent', exact: true });
  assert.equal(await attach.getAttribute('aria-disabled'), 'true');
  assert.equal(
    await attach.evaluate(node => document.getElementById(node.getAttribute('aria-describedby') ?? '')?.textContent),
    'Check the channel again before retrying.',
  );
  status = 200;
  await page.getByRole('button', { name: 'Check channel', exact: true }).click();
  await page.getByText('No agent is attached to this channel.', { exact: true }).waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some(
      button => button.textContent === 'Attach agent' && button.getAttribute('aria-disabled') !== 'true',
    ),
  );
  await attach.click();
  await page.getByRole('heading', { name: 'Agent attached', exact: true }).waitFor();
  assert.deepEqual(writes, [{ agentId, expectedVersion: 0 }]);
  for (const [width, height, colorScheme] of [
    [1440, 900, 'light'],
    [390, 844, 'dark'],
  ]) {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({
      path: `/var/folders/7d/qk8p6t3d1jvfnh4503bz0msr0000gn/T/opencode/channel-agent-${colorScheme}.png`,
      fullPage: true,
    });
  }
  console.log('Ordinary invoker attachment UI passed unavailable, loading, empty, saved, and responsive states.');
} finally {
  await browser?.close();
  server.kill();
}
