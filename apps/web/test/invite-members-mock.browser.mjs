import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

test('the invite page links member rows and never reaches a real API', { timeout: 120000 }, async () => {
  const origin = 'http://127.0.0.1:5766';
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { host: '127.0.0.1', port: 5766, strictPort: true },
  });
  let browser;
  try {
    await server.listen();
    assert.equal((await fetch(origin)).ok, true, 'mock server starts');
    browser = await chromium.launch();
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      colorScheme: 'light',
      reducedMotion: 'reduce',
    });
    const errors = [];
    const requests = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/v1/**', async route => {
      // The recommendations stream is a separate feature; it fails closed here.
      if (!route.request().url().endsWith('/recommendations/events')) requests.push(route.request().url());
      await route.abort('failed');
    });
    const form = page.getByRole('form', { name: 'Invite members' });
    const input = form.getByRole('combobox', { name: 'Email addresses', exact: true });
    const chips = form.locator('[data-slot="combobox-chip"]');
    const failures = form.getByRole('alert').filter({ hasText: 'Couldn’t invite' });
    const open = async (scenario = '') => {
      await page.goto(`${origin}/invite-mock/members/invite${scenario ? `?scenario=${scenario}` : ''}`);
      await input.waitFor({ state: 'visible' });
    };
    const record = () =>
      page.evaluate(() => {
        const original = window.fetch;
        window.writes = [];
        window.fetch = (input, init) => {
          if (init?.method === 'POST') window.writes.push({ url: String(input), body: JSON.parse(init.body) });
          return original(input, init);
        };
      });
    const writes = () => page.evaluate(() => window.writes);

    await open();
    await record();
    await input.fill('jessica@example.test, jenny@example.test, new.hire@example.test,');
    await form.getByText('3 people will join as Member.', { exact: true }).waitFor();
    await form.getByRole('button', { name: 'Invite 3 people', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/invite-mock/members');
    await page
      .getByText('Invited jessica@example.test, jenny@example.test and new.hire@example.test as Member.', {
        exact: false,
      })
      .waitFor();
    const sent = await writes();
    const created = sent.filter(write => write.url.endsWith('/rows'));
    assert.equal(created.length, 1, 'only the unknown email gets a new member row');
    assert.equal(created[0].body.kind, 'create');
    assert.deepEqual(
      Object.values(created[0].body.values)
        .filter(value => value?.kind === 'text')
        .map(value => value.value),
      ['New Hire', 'new.hire@example.test'],
    );
    const invited = Object.fromEntries(
      sent.filter(write => write.url.endsWith('/invitations')).map(write => [write.body.email, write.body]),
    );
    assert.equal(invited['new.hire@example.test'].workspaceMemberId, created[0].body.recordId);
    assert.ok(invited['jessica@example.test'].workspaceMemberId, 'existing member rows are linked, not recreated');
    assert.notEqual(invited['jessica@example.test'].workspaceMemberId, invited['jenny@example.test'].workspaceMemberId);

    await open('limited');
    await input.fill(Array.from({ length: 30 }, (_, i) => `person${i}@example.test`).join(', ') + ',');
    assert.equal(await chips.count(), 30, 'drafts are uncapped');
    await form.getByRole('button', { name: 'Invite 30 people', exact: true }).click();
    await failures.waitFor();
    assert.ok(
      (await failures.innerText()).includes('the hourly invite limit was reached; try again later'),
      'the rate limit is named',
    );
    assert.equal(await chips.count(), 30, 'rate limiting keeps every draft');

    await open('error');
    await record();
    await input.fill('jessica@example.test,');
    await form.getByRole('button', { name: 'Invite', exact: true }).click();
    await failures.getByText('we couldn’t confirm the invite', { exact: false }).waitFor();
    await form.getByRole('button', { name: 'Invite', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('form [aria-busy="true"]').length === 0);
    await failures.getByText('we couldn’t confirm the invite', { exact: false }).waitFor();
    const retried = (await writes()).filter(
      write => write.url.endsWith('/invitations') && write.body.email === 'jessica@example.test',
    );
    assert.equal(retried.length, 2);
    assert.deepEqual(retried[0].body, retried[1].body, 'uncertain retries repeat the exact request');

    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      for (const width of [320, 375, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await open();
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `no page overflow at ${width}`,
        );
      }
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(requests, [], 'no account or workspace request reaches a real API');
  } finally {
    await browser?.close();
    await server.close();
  }
});

test('a one-member workspace nudges inviting outside Members until dismissed', { timeout: 120000 }, async () => {
  const origin = 'http://127.0.0.1:5767';
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { host: '127.0.0.1', port: 5767, strictPort: true },
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/v1/**', route => route.abort('failed'));
    const header = page.locator('header[aria-label="Workspace header"]');
    const nudge = header.getByRole('group', { name: 'Invite members' });

    await page.goto(`${origin}/invite-mock/`);
    await header.waitFor();
    await page.waitForTimeout(1000);
    assert.equal(await nudge.count(), 0, 'a workspace with other members gets no nudge');

    await page.goto(`${origin}/invite-mock/members?scenario=solo`);
    await page.getByRole('link', { name: 'Invite members', exact: true }).waitFor();
    await page.waitForTimeout(1000);
    assert.equal(await nudge.count(), 0, 'the Members page shows no nudge');

    await page.goto(`${origin}/invite-mock/?scenario=solo`);
    const people = page.getByRole('navigation', { name: 'Workspace navigation', exact: true });
    await people.getByRole('link', { name: 'Members', exact: true }).waitFor();
    await people.getByRole('link', { name: 'Teams', exact: true }).waitFor();
    await nudge.getByRole('button', { name: 'Invite members', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/invite-mock/members/invite');
    await page.getByRole('form', { name: 'Invite members' }).waitFor();
    await page.goto(`${origin}/invite-mock/?scenario=solo`);

    await nudge.getByRole('button', { name: 'Dismiss invite members' }).click();
    await nudge.waitFor({ state: 'detached' });
    // The router drops the trailing slash the mock needs, so open the page again rather than reloading.
    await page.goto(`${origin}/invite-mock/?scenario=solo`);
    await header.waitFor();
    await page.waitForTimeout(1000);
    assert.equal(await nudge.count(), 0, 'a dismissed nudge stays hidden');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
