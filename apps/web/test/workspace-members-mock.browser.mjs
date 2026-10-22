import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { startWorkspaceMembersDemo } from './workspace-members-demo.mjs';

test(
  'member directory handles people, recovery and personal links without real API traffic',
  { timeout: 120000 },
  async () => {
    const root = '/v1/workspaces/87654321-4321-4321-8321-000000000001';
    const server = await startWorkspaceMembersDemo({ port: 5794 });
    const { origin } = server;
    let browser;
    try {
      const rejected = await fetch(`${origin}/v1/user/visit`, {
        method: 'POST',
        headers: { Origin: 'https://example.test' },
      });
      assert.equal(rejected.status, 403, 'other origins cannot use the local fixture API');
      browser = await chromium.launch({ headless: process.env.CHAT_BROWSER_HEADED !== '1' });
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
      const errors = [],
        requests = [];
      page.on('pageerror', error => errors.push(String(error)));
      page.on('console', message => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await page.route('**/*', route => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        requests.push({
          method: route.request().method(),
          url: route.request().url(),
          resourceType: route.request().resourceType(),
        });
        return route.abort();
      });
      await page.addInitScript(() => {
        window.memberMockReads = [];
        const original = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          const response = await original(input, init);
          const path = new URL(input instanceof Request ? input.url : String(input), location.origin).pathname;
          if (path.startsWith('/v1/'))
            window.memberMockReads.push({
              path,
              method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
              status: response.status,
              body: await response.clone().text(),
            });
          return response;
        };
      });
      await page.goto(`${origin}/members-table-mock/tables/87654321-4321-4321-8321-000000000010`);
      const rows = page.getByRole('region', { name: 'Workspace members rows', exact: true });
      await rows.getByRole('cell', { name: 'Mira Patel', exact: true }).waitFor();
      assert.equal(await rows.getByRole('row').count(), 6);
      const expected = [
        ['/v1/google-workspace/availability', { configured: false }],
        [`${root}/google-workspace`, { status: 'disconnected' }],
        [`${root}/slack/status`, { state: 'disconnected', teamId: null, canManage: false, linked: false, scopes: [] }],
        [`${root}/github/accounts`, { configured: false, accounts: [] }],
        [`${root}/atlassian/accounts`, { accounts: [], providers: [] }],
        [
          `${root}/bud`,
          {
            conversationId: null,
            onboarding: 'ineligible',
            bubblesEnabled: false,
            snoozedUntil: null,
            nudge: null,
            preferences: [],
          },
        ],
      ];
      const lastUsed = '/v1/workspaces/members-table-mock/last-used';
      await page.waitForFunction(
        paths => paths.every(path => window.memberMockReads.some(read => read.path === path)),
        [lastUsed, ...expected.map(([path]) => path)],
      );
      const reads = await page.evaluate(() => window.memberMockReads);
      assert.deepEqual(
        reads.find(read => read.path === lastUsed),
        { path: lastUsed, method: 'PUT', status: 204, body: '' },
      );
      for (const [path, body] of expected) {
        const read = reads.find(read => read.path === path);
        assert.equal(read.status, 200, path);
        assert.deepEqual(JSON.parse(read.body), body, path);
      }
      const stream = await page.evaluate(async path => {
        const source = new EventSource(path, { withCredentials: true });
        let callbackOpened = false;
        source.onopen = () => {
          callbackOpened = true;
        };
        await new Promise((resolve, reject) => {
          source.addEventListener('open', resolve, { once: true });
          source.addEventListener('error', () => reject(new Error('Mock stream failed to open')), { once: true });
        });
        const opened = source.readyState === EventSource.OPEN;
        source.close();
        return {
          opened,
          callbackOpened,
          closed: source.readyState === EventSource.CLOSED,
          withCredentials: source.withCredentials,
        };
      }, `${root}/recommendations/events`);
      assert.deepEqual(stream, { opened: true, callbackOpened: true, closed: true, withCredentials: true });

      await page.getByRole('button', { name: 'Add member', exact: true }).click();
      let dialog = page.getByRole('dialog', { name: 'Add member', exact: true });
      assert.ok(await dialog.getByRole('textbox', { name: 'Account email', exact: true }).isDisabled());
      assert.ok(await dialog.getByRole('combobox', { name: 'Workspace access', exact: true }).isDisabled());
      await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Jordan Chen');
      await dialog.getByRole('textbox', { name: 'Contact email', exact: true }).fill('jordan.chen@example.test');
      await dialog.getByRole('textbox', { name: 'Workday ID', exact: true }).fill('WD-106');
      await dialog.getByRole('button', { name: 'Save new row', exact: true }).click();
      const jordan = rows
        .getByRole('row')
        .filter({ has: page.getByRole('cell', { name: 'Jordan Chen', exact: true }) });
      await jordan.getByRole('cell', { name: 'WD-106', exact: true }).waitFor();
      assert.equal(await jordan.getByRole('cell', { name: 'No access', exact: true }).count(), 1);

      const mira = rows.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Mira Patel', exact: true }) });
      await mira.getByRole('button', { name: /^Edit row/ }).click();
      dialog = page.getByRole('dialog', { name: 'Edit member', exact: true });
      assert.ok(await dialog.getByRole('textbox', { name: 'Name', exact: true }).isDisabled());
      assert.ok(await dialog.getByRole('textbox', { name: 'Account email', exact: true }).isDisabled());
      assert.ok(await dialog.getByRole('textbox', { name: 'Workday ID', exact: true }).isEnabled());
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();

      await mira.getByRole('button', { name: /^Actions for row/ }).click();
      await page.getByRole('menuitem', { name: 'History', exact: true }).click();
      const history = page.getByRole('region', { name: 'Row history', exact: true });
      await history.getByText('TulipFarm profile sync', { exact: true }).waitFor();
      await history.getByRole('button', { name: 'Details', exact: true }).click();
      const memberIdentity = history.getByText('Member ID: 87654321-4321-4321-8321-000000000020', { exact: true });
      await memberIdentity.waitFor();
      await history.getByRole('button', { name: 'Details', exact: true }).press('Enter');
      await memberIdentity.waitFor({ state: 'hidden' });
      await history.getByRole('button', { name: 'Review values before update', exact: true }).last().click();
      const historyRow = name =>
        history.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) });
      await historyRow('Name').getByRole('cell').nth(3).getByText('Kept current', { exact: true }).waitFor();
      assert.match(await historyRow('Name').getByRole('cell').nth(2).innerText(), /Mira Sharma/);
      assert.match(await historyRow('Name').getByRole('cell').nth(3).innerText(), /Mira Patel/);
      assert.match(await historyRow('Account email').getByRole('cell').nth(3).innerText(), /mira.patel@example.test/);
      assert.match(await historyRow('Workspace access').getByRole('cell').nth(3).innerText(), /Has access/);
      assert.equal(await historyRow('Photo').getByRole('cell').nth(3).locator('img').count(), 0);
      await historyRow('Photo')
        .getByRole('cell')
        .nth(2)
        .locator('img')
        .evaluate(image => image.decode());
      assert.equal(await historyRow('Workday ID').getByRole('cell').nth(3).innerText(), 'WD-001');
      await history.getByRole('button', { name: 'Restore reviewed values', exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: '/tmp/workspace-members-linked-history.png' });
      await history.getByRole('button', { name: 'Restore reviewed values', exact: true }).click();
      await mira.getByRole('cell', { name: 'WD-001', exact: true }).waitFor();
      assert.equal(await mira.getByRole('cell', { name: 'Mira Patel', exact: true }).count(), 1);
      assert.equal(await mira.getByRole('cell', { name: 'Has access', exact: true }).count(), 1);

      await page.getByRole('button', { name: 'Profile status', exact: true }).click();
      dialog = page.getByRole('dialog', { name: 'Member profile status', exact: true });
      await dialog.getByText('1 pending · 1 need retry · 1 need setup', { exact: true }).waitFor();
      await dialog.getByRole('button', { name: 'Retry profile sync', exact: true }).click();
      await dialog.getByText('2 pending · 0 need retry · 1 need setup', { exact: true }).waitFor();
      await dialog.getByRole('button', { name: 'Complete member', exact: true }).click();
      const repair = page.getByRole('dialog', { name: 'Complete member', exact: true });
      await repair.getByRole('textbox', { name: 'Name', exact: true }).fill('Robin Shah');
      await repair.getByRole('button', { name: 'Save new row', exact: true }).click();
      await dialog.getByText(/0 need setup/).waitFor();
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await rows.getByRole('cell', { name: 'Robin Shah', exact: true }).waitFor();
      const memberRead = (await page.evaluate(() => window.memberMockReads))
        .filter(read => read.path === `${root}/tables/87654321-4321-4321-8321-000000000010/query`)
        .at(-1);
      assert.equal(
        JSON.parse(memberRead.body).records.find(
          record => record.values['4de907c4-8590-49f1-9c45-694e9fc36101']?.value === 'Robin Shah',
        ).id,
        '87654321-4321-4321-8321-000000000026',
        'repair keeps the reserved identity',
      );

      await page
        .getByRole('navigation', { name: 'Breadcrumb' })
        .getByRole('link', { name: 'Tables', exact: true })
        .click();
      await page.getByRole('link', { name: 'Tickets', exact: true }).click();
      const tickets = page.getByRole('region', { name: 'Tickets rows', exact: true });
      await tickets.getByRole('cell', { name: 'Review the October rota', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Add filter', exact: true }).click();
      await page.getByRole('combobox', { name: 'Field', exact: true }).click();
      await page.getByRole('option', { name: 'Assignee', exact: true }).click();
      await page.getByRole('combobox', { name: 'Condition', exact: true }).click();
      await page.getByRole('option', { name: 'is me', exact: true }).click();
      assert.equal(await page.getByRole('textbox', { name: 'Value', exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Choose assignee', exact: true }).count(), 0);
      await page.getByRole('button', { name: 'Add filter', exact: true }).last().click();
      await tickets
        .getByRole('cell', { name: 'Replace the front-desk tablet', exact: true })
        .waitFor({ state: 'hidden' });
      await tickets.getByRole('cell', { name: 'Review the October rota', exact: true }).waitFor();
      assert.equal(await tickets.getByRole('row').count(), 2);
      assert.equal(new URL(page.url()).searchParams.get('where'), 'assignee=isme=true');

      await tickets.getByRole('button', { name: /^Edit row/ }).click();
      dialog = page.getByRole('dialog', { name: 'Edit row', exact: true });
      await dialog.getByRole('combobox', { name: 'Choose assignee', exact: true }).click();
      assert.equal(
        await page.getByRole('option', { name: /Theo Park/ }).count(),
        0,
        'inactive members cannot receive new links',
      );
      await page.getByRole('option', { name: 'Jordan Chen', exact: true }).click();
      await dialog.getByRole('button', { name: 'Save row', exact: true }).click();
      await page.getByRole('heading', { name: 'No rows match', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Clear filters', exact: true }).first().click();
      await tickets.getByRole('link', { name: 'Jordan Chen', exact: true }).waitFor();
      assert.equal(await tickets.getByRole('row').count(), 4);

      await page
        .getByRole('navigation', { name: 'Breadcrumb' })
        .getByRole('link', { name: 'Tables', exact: true })
        .click();
      await page.getByRole('link', { name: 'Workspace members', exact: true }).click();
      await jordan.getByRole('button', { name: /^Actions for row/ }).click();
      await page.getByRole('menuitem', { name: 'Profile and photo', exact: true }).click();
      dialog = page.getByRole('dialog', { name: 'Member profile', exact: true });
      const photo = dialog.getByRole('region', { name: 'Member photo', exact: true });
      await photo.getByRole('button', { name: 'Upload image', exact: true }).waitFor();
      const readImage = locator =>
        locator.evaluate(async image => {
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 128;
          const context = canvas.getContext('2d');
          context.drawImage(image, 0, 0);
          return {
            width: image.naturalWidth,
            height: image.naturalHeight,
            source: image.src,
            pixel: [...context.getImageData(64, 64, 1, 1).data],
          };
        });
      async function uploadPhoto(color, expectedPixel, previous = '', recovery = null) {
        const image = await page.evaluate(color => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 64;
          const context = canvas.getContext('2d');
          context.fillStyle = color;
          context.fillRect(0, 0, 64, 64);
          return canvas.toDataURL('image/png').split(',')[1];
        }, color);
        const previousErrors = errors.length;
        await photo
          .locator('input[type="file"]')
          .setInputFiles({ name: 'member.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') });
        if (recovery) {
          await dialog.getByRole('button', { name: 'Check row request', exact: true }).waitFor();
          assert.equal(await dialog.getByRole('button', { name: 'Close', exact: true }).count(), 0);
          assert.ok(await photo.getByRole('button', { name: 'Remove', exact: true }).isDisabled());
          await dialog.getByRole('button', { name: 'Check row request', exact: true }).click();
          if (recovery === 'retry')
            await dialog.getByRole('button', { name: 'Retry same row request', exact: true }).click();
          await dialog.getByRole('button', { name: 'Close', exact: true }).waitFor();
          await photo.getByRole('button', { name: 'Remove', exact: true }).click({ trial: true });
          assert.ok(await photo.getByRole('button', { name: 'Remove', exact: true }).isEnabled());
          assert.deepEqual(
            errors.splice(previousErrors),
            ['Failed to load resource: net::ERR_FAILED'],
            'only the deliberately lost response may log an error',
          );
        }
        await page.waitForFunction(previous => {
          const image = document.querySelector('[aria-label="Member photo"] img');
          return image?.src !== previous && image?.complete && image?.naturalWidth === 128;
        }, previous);
        const rendered = await readImage(photo.locator('img'));
        assert.equal(rendered.width, 128);
        assert.equal(rendered.height, 128);
        assert.ok(rendered.source.startsWith(`${origin}${root}/workspace-members/`));
        assert.ok(
          expectedPixel.every((value, index) => Math.abs(value - rendered.pixel[index]) <= 4),
          `uploaded pixels render: ${rendered.pixel}`,
        );
        assert.equal(rendered.pixel[3], 255);
        return rendered.source;
      }
      const firstImage = await uploadPhoto('#d52b3f', [213, 43, 63]);
      const secondImage = await uploadPhoto('#278443', [39, 132, 67], firstImage);
      assert.notEqual(firstImage, secondImage, 'replacement keeps a distinct canonical photo reference');
      await page.screenshot({ path: '/tmp/workspace-members-photo-after.png' });
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await jordan.locator('img').waitFor();
      await page.reload();
      await jordan.locator('img').waitFor();
      assert.equal(
        await jordan.locator('img').getAttribute('src'),
        secondImage,
        'document reload retains this server session’s image',
      );
      await jordan.getByRole('button', { name: /^Actions for row/ }).click();
      await page.getByRole('menuitem', { name: 'Profile and photo', exact: true }).click();
      await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
      await photo.getByRole('button', { name: 'Upload image', exact: true }).waitFor();
      assert.equal(await photo.locator('img').count(), 0);
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await jordan.getByRole('button', { name: /^Actions for row/ }).click();
      await page.getByRole('menuitem', { name: 'History', exact: true }).click();
      await history.getByRole('button', { name: 'Review values before update', exact: true }).first().click();
      await historyRow('Photo').getByRole('cell').nth(3).locator('img').waitFor();
      for (const column of [2, 3]) {
        const rendered = await readImage(historyRow('Photo').getByRole('cell').nth(column).locator('img'));
        assert.equal(rendered.source, secondImage);
        assert.equal(rendered.width, 128);
        assert.equal(rendered.height, 128);
        assert.ok([39, 132, 67].every((value, index) => Math.abs(value - rendered.pixel[index]) <= 4));
        assert.equal(rendered.pixel[3], 255);
      }
      await history.getByRole('button', { name: 'Restore reviewed values', exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: '/tmp/workspace-members-manual-history.png' });
      await history.getByRole('button', { name: 'Restore reviewed values', exact: true }).click();
      await jordan.locator('img').waitFor();
      assert.equal(await jordan.locator('img').getAttribute('src'), secondImage);

      await page
        .getByRole('navigation', { name: 'Breadcrumb' })
        .getByRole('link', { name: 'Tables', exact: true })
        .click();
      await page.getByRole('link', { name: 'Tickets', exact: true }).click();
      await tickets.getByRole('link', { name: 'Jordan Chen', exact: true }).click();
      await page.getByRole('button', { name: 'Profile and photo', exact: true }).click();
      await photo.getByRole('button', { name: 'Change image', exact: true }).waitFor();
      assert.equal(
        await photo.locator('img').getAttribute('src'),
        secondImage,
        'linked rows expose the same member profile and photo',
      );
      const memberId = new URL(page.url()).searchParams.get('row');
      assert.ok(memberId);
      const endpoint = `${origin}${root}/workspace-members/${memberId}`;
      const writes = [];
      page.on('request', request => {
        if (request.url() === endpoint && request.method() === 'POST') writes.push(request.postDataJSON());
      });
      let savedPhoto;
      const loseResponse = async () =>
        page.route(
          endpoint,
          async route => {
            const response = await route.fetch();
            assert.equal(response.status(), 200);
            savedPhoto = (await response.json()).values['4de907c4-8590-49f1-9c45-694e9fc36102'].value;
            await route.abort();
          },
          { times: 1 },
        );
      await loseResponse();
      const confirmedImage = await uploadPhoto('#2b5ed5', [43, 94, 213], secondImage, 'receipt');
      assert.equal(confirmedImage, `${origin}${savedPhoto}`);
      assert.equal(writes.length, 1, 'receipt recovery must not resend the photo');
      await page.screenshot({ path: '/tmp/workspace-members-photo-receipt-recovered.png' });
      await loseResponse();
      await page.route(
        `${origin}${root}/tables/87654321-4321-4321-8321-000000000010/requests/*`,
        route =>
          route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'unknown' }) }),
        { times: 1 },
      );
      const retriedImage = await uploadPhoto('#bb7d19', [187, 125, 25], confirmedImage, 'retry');
      assert.equal(
        retriedImage,
        `${origin}${savedPhoto}`,
        'retry reuses the existing image rather than replacing it again',
      );
      assert.equal(writes.length, 3);
      assert.deepEqual(writes[1], writes[2], 'unknown outcomes retry the exact request ID and payload');
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await page.getByRole('button', { name: 'Profile and photo', exact: true }).waitFor();
      await history.getByRole('button', { name: 'Close history', exact: true }).click();
      await page.getByRole('button', { name: 'Customize', exact: true }).click();
      await page.getByRole('button', { name: 'Add group', exact: true }).click();
      await page.getByRole('combobox', { name: 'Group field 1', exact: true }).click();
      await page.getByRole('option', { name: 'Photo', exact: true }).click();
      await page.keyboard.press('Escape');
      await page.getByRole('heading', { name: 'Summary', exact: true }).waitFor();
      const summary = page
        .getByRole('table')
        .filter({ has: page.getByRole('columnheader', { name: 'Photo', exact: true }) });
      await summary.locator('img').waitFor();
      assert.equal((await readImage(summary.locator('img'))).source, retriedImage);
      assert.equal(await summary.getByRole('cell', { name: 'Empty', exact: true }).count(), 1);
      assert.equal(
        await summary.getByRole('row').count(),
        3,
        'photo groups render an image and an explicit empty group',
      );
      assert.deepEqual(errors, []);
      assert.deepEqual(requests, [], 'fetch, images and EventSource must not reach a real API');
    } finally {
      await browser?.close();
      await server.close();
    }
  },
);

test(
  'member readers see loading, protected history and private account methods on small screens',
  { timeout: 90000 },
  async () => {
    const server = await startWorkspaceMembersDemo({ port: 5794, scenario: 'reader' });
    const browser = await chromium.launch({ headless: process.env.CHAT_BROWSER_HEADED !== '1' });
    let releaseRows;
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
      const errors = [],
        outside = [];
      page.on('pageerror', error => errors.push(String(error)));
      page.on('console', message => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await page.route('**/*', route => {
        if (new URL(route.request().url()).origin === server.origin) return route.continue();
        outside.push(route.request().url());
        return route.abort();
      });
      const held = new Promise(resolve => {
        releaseRows = resolve;
      });
      await page.route(
        '**/tables/87654321-4321-4321-8321-000000000010/query',
        async route => {
          await held;
          await route.continue();
        },
        { times: 1 },
      );
      await page.goto(`${server.origin}/members-table-mock/tables/87654321-4321-4321-8321-000000000010`);
      const rows = page.getByRole('region', { name: 'Workspace members rows', exact: true });
      await rows.locator('[data-loading-row]').first().waitFor();
      assert.equal(await page.getByRole('heading', { name: 'No rows yet', exact: true }).count(), 0);
      releaseRows();
      const mira = rows.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Mira Patel', exact: true }) });
      await mira.waitFor();
      assert.equal(await page.getByRole('button', { name: 'Add member', exact: true }).count(), 0);
      assert.equal(await mira.getByRole('button', { name: /^Edit row/ }).count(), 0);
      await mira.getByRole('button', { name: /^Actions for row/ }).click();
      assert.equal(await page.getByRole('menuitem', { name: 'Edit row', exact: true }).count(), 0);
      await page.getByRole('menuitem', { name: 'History', exact: true }).click();
      const history = page.getByRole('region', { name: 'Row history', exact: true });
      await history.getByRole('button', { name: 'Review values before update', exact: true }).last().click();
      await history.getByRole('heading', { name: 'Historical values', exact: true }).waitFor();
      assert.equal(await history.getByRole('button', { name: 'Restore reviewed values', exact: true }).count(), 0);
      await history.getByRole('button', { name: 'Close history', exact: true }).click();
      await page.setViewportSize({ width: 375, height: 812 });
      await mira.getByRole('button', { name: /^Actions for row/ }).click();
      await page.getByRole('menuitem', { name: 'Profile and photo', exact: true }).click();
      const profile = page.getByRole('dialog', { name: 'Member profile', exact: true });
      await profile.getByText('Profile synced', { exact: true }).waitFor();
      assert.equal(await profile.getByRole('button', { name: 'Upload image', exact: true }).count(), 0);
      assert.equal(await profile.locator('input[type="file"]').count(), 0);
      assert.ok(await profile.getByRole('button', { name: 'Close', exact: true }).isVisible());
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: '/tmp/workspace-members-reader-mobile.png' });
      await page.keyboard.press('Escape');
      await profile.waitFor({ state: 'hidden' });
      await page.goto(`${server.origin}/members-table-mock/settings/account`);
      await page.getByText('Email link · Google', { exact: true }).waitFor();
      await page
        .getByText('Private to your account. Available ways to sign in, not a record of past logins.', { exact: true })
        .waitFor();
      assert.ok(
        await page.getByRole('textbox', { name: 'Name', exact: true }).isEnabled(),
        'personal profile stays editable without business-table rights',
      );
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: '/tmp/workspace-members-private-methods-mobile.png' });
      assert.deepEqual(errors, []);
      assert.deepEqual(outside, []);
    } finally {
      releaseRows?.();
      await browser.close();
      await server.close();
    }
  },
);
