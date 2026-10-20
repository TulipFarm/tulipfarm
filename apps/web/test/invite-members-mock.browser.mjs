import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { selectInvitationMember } from './invitation-members.fixture.mjs';

test(
  'invite canvas shows existing people and uncapped drafts without sending real mail',
  { timeout: 120000 },
  async () => {
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
              super(
                new URL(url, window.location.origin).href === expected ? '/__invite_recommendations' : url,
                options,
              );
            }
          };
        },
        `${process.env.VITE_API_URL || 'http://localhost:3001'}/v1/workspaces/22222222-2222-4222-8222-222222222222/recommendations/events`,
      );
      const dialog = page.getByRole('dialog');
      const preview = page.getByRole('region', { name: 'People to invite' });
      const open = async (scenario = '') => {
        await page.goto(`${origin}/invite-mock/members${scenario ? `?scenario=${scenario}` : ''}`);
        await dialog.getByRole('button', { name: 'Send invitations', exact: true }).waitFor();
        await page.getByRole('textbox', { name: 'Email 1', exact: true }).waitFor({ state: 'visible' });
      };
      await open();
      assert.equal(await page.getByRole('region', { name: 'Already in your workspace' }).locator('li').count(), 3);
      assert.equal(await preview.locator('li').count(), 3);
      assert.doesNotMatch(await page.getByRole('region', { name: 'Already in your workspace' }).innerText(), /@/);
      assert.equal(await dialog.getByText('Not sent', { exact: true }).count(), 0);
      const fieldLabel = dialog.locator('label[for="invitation-email-0"]');
      assert.equal(
        await fieldLabel.evaluate(label => getComputedStyle(label.parentElement.parentElement).position),
        'absolute',
        'repeated labels are screen-reader-only',
      );
      assert.equal(
        await page.getByRole('textbox', { name: 'Email 1', exact: true }).getAttribute('aria-required'),
        'true',
      );
      const movingPeople = page.locator('.invite-person-motion');
      assert.equal(
        await movingPeople.first().evaluate(person => getComputedStyle(person).animationName),
        'none',
        'reduced motion stays still',
      );
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.waitForFunction(
        () => getComputedStyle(document.querySelector('.invite-person-motion')).animationPlayState === 'running',
      );
      const startTransform = await movingPeople.first().evaluate(person => getComputedStyle(person).transform);
      await delay(300);
      assert.notEqual(
        await movingPeople.first().evaluate(person => getComputedStyle(person).transform),
        startTransform,
        'cursors actually move',
      );
      await dialog.getByRole('button', { name: 'Pause movement' }).click();
      const pausedTransform = await movingPeople.first().evaluate(person => getComputedStyle(person).transform);
      await delay(100);
      assert.equal(
        await movingPeople.first().evaluate(person => getComputedStyle(person).transform),
        pausedTransform,
        'pause stops motion',
      );
      await dialog.getByRole('button', { name: 'Resume movement' }).click();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const positions = await page
        .locator('.invite-person')
        .evaluateAll(people => people.map(person => person.getBoundingClientRect().x));
      assert.ok(new Set(positions).size > 3, 'people are scattered rather than aligned in two columns');
      const sample = await page.getByRole('region', { name: 'Already in your workspace' }).innerText();
      await dialog.getByRole('button', { name: 'Remove email 2', exact: true }).click();
      assert.equal(await preview.locator('li').count(), 2);
      await dialog.getByRole('button', { name: 'Add another', exact: true }).click();
      await page.getByRole('textbox', { name: 'Email 3', exact: true }).fill('bad-address');
      await dialog.getByRole('button', { name: 'Send invitations', exact: true }).click();
      await dialog.getByText('Enter a valid email address.').waitFor();
      assert.equal(
        await page.getByRole('textbox', { name: 'Email 3', exact: true }).getAttribute('aria-invalid'),
        'true',
      );
      await page.getByRole('textbox', { name: 'Email 3', exact: true }).fill('teammate@example.test');
      assert.equal(
        await page.getByRole('region', { name: 'Already in your workspace' }).innerText(),
        sample,
        'sample does not reshuffle on edits',
      );
      await dialog.getByRole('button', { name: 'Not now', exact: true }).click();
      await page.getByRole('button', { name: 'Invite members', exact: true }).click();
      assert.equal(
        await page.getByRole('textbox', { name: 'Email 3', exact: true }).inputValue(),
        'teammate@example.test',
      );
      await selectInvitationMember(page, 0, 'Jessica · jessica@example.test');
      await selectInvitationMember(page, 1, 'Jenny · jenny@example.test');
      await selectInvitationMember(page, 2, 'Teammate · teammate@example.test');
      await dialog.getByRole('button', { name: 'Send invitations', exact: true }).click();
      await dialog.getByRole('button', { name: 'Sending invitations…', exact: true }).waitFor();
      assert.ok(await page.getByRole('textbox', { name: 'Email 1', exact: true }).isDisabled());
      await dialog.getByText('3 of 3 recipients confirmed.', { exact: false }).waitFor();
      assert.equal(
        await preview.locator('li').count(),
        3,
        'invited people remain on the canvas without status clutter',
      );
      assert.equal(await page.getByRole('textbox', { name: 'Email 1', exact: true }).inputValue(), '');
      assert.equal(
        await dialog.getByText('Enter a valid email address.').count(),
        0,
        'successful sending does not mark the cleared field invalid',
      );

      await open('limited');
      const bulk = Array.from({ length: 30 }, (_, i) => `person${i}@example.test`).join('\n');
      await page.getByRole('textbox', { name: 'Email 1', exact: true }).evaluate((element, text) => {
        const data = new DataTransfer();
        data.setData('text/plain', text);
        element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
      }, bulk);
      assert.equal(await preview.locator('li').count(), 32);
      for (let index = 0; index < 30; index++)
        await selectInvitationMember(page, index, `Person ${index} · person${index}@example.test`);
      await selectInvitationMember(page, 30, 'Justin · justin@example.test');
      await selectInvitationMember(page, 31, 'Jenny · jenny@example.test');
      await dialog.getByRole('button', { name: 'Send invitations', exact: true }).click();
      await dialog.getByText('0 of 32 recipients confirmed.', { exact: false }).waitFor();
      await dialog.getByRole('button', { name: 'Send invitations', exact: true }).waitFor();
      assert.equal(await dialog.getByRole('region', { name: 'Invitation results' }).getByRole('alert').count(), 32);
      assert.equal(
        await page.getByRole('textbox', { name: /^Email \d+$/ }).count(),
        32,
        'rate limiting retains every draft',
      );

      await open('error');
      await page.evaluate(() => {
        const original = window.fetch;
        window.inviteRequests = [];
        window.fetch = (input, init) => {
          if (init?.method === 'POST' && String(input).endsWith('/invitations'))
            window.inviteRequests.push(JSON.parse(init.body));
          return original(input, init);
        };
      });
      for (const [index, name] of ['Jessica', 'Justin', 'Jenny'].entries()) {
        await selectInvitationMember(page, index, `${name} · ${name.toLowerCase()}@example.test`);
      }
      await dialog.getByRole('button', { name: 'Send invitations', exact: true }).click();
      await dialog.getByRole('button', { name: 'Retry invitation for jessica@example.test', exact: true }).waitFor();
      await dialog.getByRole('button', { name: 'Send invitations', exact: true }).waitFor();
      await dialog.getByRole('button', { name: 'Retry invitation for jessica@example.test', exact: true }).click();
      await dialog.getByRole('button', { name: 'Send invitations', exact: true }).waitFor();
      const sent = await page.evaluate(() =>
        window.inviteRequests.filter(request => request.email === 'jessica@example.test'),
      );
      assert.equal(sent.length, 2);
      assert.deepEqual(sent[0], sent[1], 'uncertain retries preserve the exact request');
      await page.setViewportSize({ width: 320, height: 900 });
      assert.ok(
        await dialog.evaluate(element => element.scrollWidth <= element.clientWidth),
        'failure actions fit on mobile',
      );

      await open('empty');
      assert.equal(await page.getByRole('region', { name: 'Already in your workspace' }).count(), 0);
      for (let i = 3; i > 0; i--) await dialog.getByRole('button', { name: `Remove email ${i}`, exact: true }).click();
      await preview.getByText('Add email addresses to see your invites here.').waitFor();
      await dialog.getByRole('button', { name: 'Send invitations', exact: true }).click();
      await dialog.getByText('Enter a valid email address.').waitFor();

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
            await page.locator('.invite-canvas').evaluate(canvas => {
              const bounds = canvas.getBoundingClientRect();
              return [...canvas.querySelectorAll('.invite-person-motion')].every(person => {
                const rect = person.getBoundingClientRect();
                return rect.left >= bounds.left && rect.right <= bounds.right;
              });
            }),
            `every cursor stays inside the canvas at ${width}`,
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
  },
);
