import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

test('invite chips add members and invite them without sending real mail', { timeout: 120000 }, async () => {
  const origin = 'http://127.0.0.1:5766';
  const streams = new Set();
  let streamsOpened = 0;
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { host: '127.0.0.1', port: 5766, strictPort: true },
    plugins: [
      {
        name: 'invitation-stream-fixture',
        configureServer(server) {
          server.middlewares.use('/__invite_recommendations', (_request, response) => {
            response.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            });
            response.write(': local invitation stream\n\n');
            streams.add(response);
            streamsOpened++;
            const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 10000);
            response.on('close', () => {
              streams.delete(response);
              clearInterval(heartbeat);
            });
          });
        },
      },
    ],
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
      requests.push(route.request().url());
      await route.abort('failed');
    });
    await page.addInitScript(
      expected => {
        const NativeEventSource = window.EventSource;
        window.EventSource = class extends NativeEventSource {
          constructor(url, options) {
            super(new URL(url, window.location.origin).href === expected ? '/__invite_recommendations' : url, options);
          }
        };
      },
      `${process.env.VITE_API_URL || 'http://localhost:3001'}/v1/workspaces/22222222-2222-4222-8222-222222222222/recommendations/events`,
    );
    const dialog = page.getByRole('dialog');
    const preview = page.getByRole('region', { name: 'People to invite' });
    const existing = page.getByRole('region', { name: 'Already in your workspace' });
    const input = dialog.getByRole('combobox', { name: 'Email addresses', exact: true });
    const chips = dialog.locator('[data-slot="combobox-chip"]');
    const hint = dialog.locator('#invitation-emails-hint');
    const cursors = page.locator('.invite-canvas [data-slot="presence-cursor"]');
    const send = () => dialog.getByRole('button', { name: 'Send invitations', exact: true }).click();
    const open = async (scenario = '') => {
      await page.goto(`${origin}/invite-mock/members${scenario ? `?scenario=${scenario}` : ''}`);
      await dialog.getByRole('button', { name: 'Send invitations', exact: true }).waitFor();
      await input.waitFor({ state: 'visible' });
    };
    const paste = text =>
      input.evaluate((element, value) => {
        const data = new DataTransfer();
        data.setData('text/plain', value);
        element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      }, text);
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
    const transform = () => cursors.first().evaluate(cursor => getComputedStyle(cursor).transform);

    await open();
    assert.equal(await existing.locator('li').count(), 3);
    assert.equal(await preview.locator('li').count(), 3);
    assert.doesNotMatch(await existing.innerText(), /@/);
    assert.deepEqual(await chips.allInnerTexts(), [
      'jessica@example.test',
      'justin@example.test',
      'jenny@example.test',
    ]);
    assert.equal(await dialog.getByRole('combobox', { name: 'Workspace member' }).count(), 0, 'no member picker');
    assert.equal(await dialog.getByRole('button', { name: /movement/ }).count(), 0, 'no pause control');
    const still = await transform();
    await delay(1800);
    assert.equal(await transform(), still, 'reduced motion stays still');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForFunction(start => {
      const cursor = document.querySelector('.invite-canvas [data-slot="presence-cursor"]');
      return getComputedStyle(cursor).transform !== start;
    }, still);
    await delay(5000);
    const settled = await transform();
    await delay(1800);
    assert.equal(await transform(), settled, 'motion stops within five seconds');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const positions = await cursors.evaluateAll(people => people.map(person => person.getBoundingClientRect().x));
    assert.ok(new Set(positions).size > 3, 'people are scattered');
    const sample = await existing.innerText();

    await dialog.getByRole('button', { name: 'Remove justin@example.test', exact: true }).click();
    assert.equal(await preview.locator('li').count(), 2);
    await input.fill('bad-address');
    await send();
    await hint.getByText('bad-address. It is not a valid email address.', { exact: false }).waitFor();
    assert.equal(await input.getAttribute('aria-invalid'), 'true');
    await input.fill('new.hire@example.test');
    await page.getByRole('option', { name: 'Invite new.hire@example.test', exact: true }).waitFor();
    await page.keyboard.press('Enter');
    assert.deepEqual(await chips.allInnerTexts(), [
      'jessica@example.test',
      'jenny@example.test',
      'new.hire@example.test',
    ]);
    assert.equal(await input.inputValue(), '');
    await input.fill('jenny@example.test,');
    await hint.getByText('Already added: jenny@example.test.', { exact: true }).waitFor();
    assert.equal(await chips.count(), 3, 'duplicates are not added twice');
    assert.equal(await existing.innerText(), sample, 'sample does not reshuffle on edits');
    assert.ok(await input.evaluate(element => element === document.activeElement), 'the email field keeps focus');

    await record();
    await send();
    await dialog.getByRole('button', { name: 'Sending invitations…', exact: true }).waitFor();
    assert.ok(await input.isDisabled());
    await dialog.getByText('3 invitations sent.', { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('region', { name: 'Invitation results' }).getByRole('alert').count(), 0);
    assert.equal(await preview.locator('li').count(), 3, 'invited people remain on the canvas');
    assert.equal(await chips.count(), 0, 'sent addresses leave the field');
    assert.equal(await input.getAttribute('aria-invalid'), null);
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
    assert.ok(invited['jessica@example.test'].workspaceMemberId, 'existing members are linked, not recreated');
    assert.notEqual(invited['jessica@example.test'].workspaceMemberId, invited['jenny@example.test'].workspaceMemberId);

    await open('limited');
    await paste(Array.from({ length: 30 }, (_, i) => `person${i}@example.test`).join('\n'));
    assert.equal(await chips.count(), 33, 'drafts are uncapped');
    assert.equal(await preview.locator('li').count(), 9, 'the canvas shows a readable subset');
    await preview.getByText('And 24 more', { exact: true }).waitFor();
    await send();
    await dialog.getByRole('button', { name: 'Send invitations', exact: true }).waitFor();
    const results = dialog.getByRole('region', { name: 'Invitation results' });
    assert.deepEqual(await results.getByRole('alert').allInnerTexts(), [
      '33 not sent: hourly limit reached, try again later.',
    ]);
    assert.equal(await results.getByRole('status').count(), 0, 'nothing is reported as sent');
    assert.equal(await chips.count(), 33, 'rate limiting retains every draft');
    assert.equal(await dialog.locator('[data-slot="combobox-chip"][data-status="failed"]').count(), 33);

    await open('error');
    await record();
    await send();
    await dialog.getByRole('button', { name: 'Retry 3 invitations', exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Send invitations', exact: true }).waitFor();
    assert.equal(
      await dialog.locator('[data-slot="combobox-chip"]').first().getAttribute('title'),
      'Not sent: not confirmed, retrying is safe',
    );
    await dialog.getByRole('button', { name: 'Retry 3 invitations', exact: true }).click();
    await dialog.getByRole('button', { name: 'Send invitations', exact: true }).waitFor();
    const retried = (await writes()).filter(
      write => write.url.endsWith('/invitations') && write.body.email === 'jessica@example.test',
    );
    assert.equal(retried.length, 2);
    assert.deepEqual(retried[0].body, retried[1].body, 'uncertain retries preserve the exact request');
    await page.setViewportSize({ width: 320, height: 900 });
    assert.ok(
      await dialog.evaluate(element => element.scrollWidth <= element.clientWidth),
      'failure actions fit on mobile',
    );
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Invite members', exact: true }).click();
    assert.equal(await chips.count(), 0, 'closing starts a fresh draft');
    assert.equal(await dialog.getByRole('region', { name: 'Invitation results' }).count(), 0, 'results reset');

    await open('empty');
    assert.equal(await existing.count(), 0);
    await input.focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace');
    assert.equal(await chips.count(), 0, 'Backspace removes chips');
    await preview.getByText('Add email addresses to see your invites here.').waitFor();
    await send();
    await hint.getByText('Add at least one email address.', { exact: true }).waitFor();

    await input.focus();
    await page.keyboard.type('tab.hire@example.test');
    await page.keyboard.press('Tab');
    await page.keyboard.type('esc.hire@example.test');
    await page.keyboard.press('Escape');
    assert.equal(await input.inputValue(), 'esc.hire@example.test', 'Escape keeps typed text');
    await page.keyboard.press('Enter');
    assert.deepEqual(await chips.allInnerTexts(), ['tab.hire@example.test', 'esc.hire@example.test']);
    assert.equal(await input.evaluate(element => element === document.activeElement), true, 'Tab stays in the field');
    await page.keyboard.press('Tab');
    assert.equal(await input.evaluate(element => element === document.activeElement), false, 'empty Tab moves on');

    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      for (const width of [320, 375, 414, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await open();
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `no page overflow at ${width}`,
        );
        assert.ok(
          await dialog.evaluate(element => element.scrollWidth <= element.clientWidth),
          `no dialog overflow at ${width}`,
        );
        const bounds = await dialog.boundingBox();
        assert.ok(bounds.x >= 15 && bounds.x + bounds.width <= width - 15, 'dialog keeps a screen-edge gutter');
        await preview.locator('li').first().scrollIntoViewIfNeeded();
        assert.equal(await preview.locator('li').count(), 3);
        assert.ok(
          await page.locator('.invite-board').evaluate(board => {
            const bounds = board.getBoundingClientRect();
            return [...board.querySelectorAll('[data-slot="presence-cursor"] > *')].every(part => {
              const rect = part.getBoundingClientRect();
              return (
                rect.left >= bounds.left &&
                rect.right <= bounds.right &&
                rect.top >= bounds.top &&
                rect.bottom <= bounds.bottom
              );
            });
          }),
          `every cursor stays inside the board at ${width}`,
        );
        await page.screenshot({ path: `/tmp/invite-members-${colorScheme}-${width}.png` });
      }
    }
    assert.deepEqual(errors, []);
    assert.ok(streamsOpened > 0, 'recommendations use a real local event stream');
    assert.deepEqual(requests, [], 'no account or workspace request reaches a real API');
  } finally {
    await browser?.close();
    for (const response of streams) response.end();
    await server.close();
  }
});

test('a one-member workspace offers inviting from the header until dismissed', { timeout: 120000 }, async () => {
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

    await page.goto(`${origin}/invite-mock/?scenario=solo`);
    await nudge.getByRole('button', { name: 'Invite members', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Send invitations', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });

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
