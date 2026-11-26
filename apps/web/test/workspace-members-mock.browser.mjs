import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { startWorkspaceMembersDemo } from './workspace-members-demo.mjs';

test(
  'members page handles people, recovery and personal links without real API traffic',
  { timeout: 120000 },
  async () => {
    const root = '/v1/workspaces/87654321-4321-4321-8321-000000000001';
    const memberTableId = '87654321-4321-4321-8321-000000000010';
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
      // The Members table has no table page: it opens the Members list.
      await page.goto(`${origin}/members-table-mock/tables/${memberTableId}`);
      await page.waitForURL(`${origin}/members-table-mock/members`);
      const list = page.getByRole('table', { name: 'Workspace members', exact: true });
      const person = text => list.getByRole('row').filter({ has: page.getByText(text, { exact: true }) });
      await person('Maya Rao').getByText('No account', { exact: true }).waitFor();
      assert.equal(await person('Alex Morgan').getByText('No account', { exact: true }).count(), 1);
      assert.equal(await person('Theo Park').getByText('Inactive', { exact: true }).count(), 1);
      assert.equal(await person('mira.patel@example.test').getByText('Active', { exact: true }).count(), 1);
      assert.equal(await list.getByText('Mira Patel', { exact: true }).count(), 0, 'a linked row is listed once');
      const expected = [
        ['/v1/google-workspace/availability', { configured: false }],
        [`${root}/google-workspace`, { status: 'disconnected' }],
        [`${root}/slack/status`, { state: 'disconnected', teamId: null, canManage: false, linked: false, scopes: [] }],
        [`${root}/github/accounts`, { configured: false, installUrl: null, accounts: [] }],
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

      // Add person keeps someone without an account, with the workspace's own fields.
      await page.getByRole('button', { name: 'Add person', exact: true }).click();
      let dialog = page.getByRole('dialog', { name: 'Add person', exact: true });
      assert.equal(await dialog.getByRole('textbox', { name: 'Account email', exact: true }).count(), 0);
      await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Jordan Chen');
      await dialog.getByRole('textbox', { name: 'Contact email', exact: true }).fill('jordan.chen@example.test');
      await dialog.getByRole('textbox', { name: 'Workday ID', exact: true }).fill('WD-106');
      await dialog.getByRole('button', { name: 'Add person', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page.getByText('Added Jordan Chen to Members.', { exact: true }).waitFor();
      await person('Jordan Chen').getByText('No account', { exact: true }).waitFor();
      assert.equal(await person('jordan.chen@example.test').count(), 1);

      await page.getByRole('button', { name: 'Profile sync status', exact: true }).click();
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
      await person('Robin Shah').waitFor();
      const memberRead = (await page.evaluate(() => window.memberMockReads))
        .filter(read => read.path === `${root}/tables/${memberTableId}/rows/page`)
        .at(-1);
      assert.equal(
        JSON.parse(memberRead.body).records.find(
          record => record.values['4de907c4-8590-49f1-9c45-694e9fc36101']?.value === 'Robin Shah',
        ).id,
        '87654321-4321-4321-8321-000000000026',
        'repair keeps the reserved identity',
      );

      // Removing someone without an account deletes their Members row.
      await page.getByRole('button', { name: 'Actions for Robin Shah', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Remove Robin Shah', exact: true }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Remove', exact: true }).click();
      await page.getByText('Removed Robin Shah from Members.', { exact: true }).waitFor();
      await person('Robin Shah').waitFor({ state: 'detached' });

      // An account member's page shows their Members profile; their name follows their own profile.
      await person('mira.patel@example.test').getByRole('link').first().click();
      await page.waitForURL(`${origin}/members-table-mock/members/87654321-4321-4321-8321-000000000004`);
      await page.getByRole('heading', { name: 'Profile', exact: true }).waitFor();
      await page.getByText('WD-101', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Edit profile', exact: true }).click();
      dialog = page.getByRole('dialog', { name: 'Edit member', exact: true });
      assert.ok(await dialog.getByRole('textbox', { name: 'Name', exact: true }).isDisabled());
      assert.ok(await dialog.getByRole('textbox', { name: 'Account email', exact: true }).isDisabled());
      assert.ok(await dialog.getByRole('textbox', { name: 'Workday ID', exact: true }).isEnabled());
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();

      // Tables leaves Members out, but other tables still link to people.
      await page.goto(`${origin}/members-table-mock/tables`);
      await page.getByRole('listitem', { name: 'Tickets', exact: true }).click();
      const tickets = page.getByRole('region', { name: 'Tickets rows', exact: true });
      await tickets.getByRole('cell', { name: 'Review the October rota', exact: true }).waitFor();
      assert.equal(await page.getByRole('listitem', { name: 'Workspace members', exact: true }).count(), 0);
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

      await tickets.getByRole('button', { name: /^Edit Review the October rota/ }).click();
      dialog = page.getByRole('dialog', { name: 'Edit row', exact: true });
      await dialog.getByRole('combobox', { name: 'Choose or search assignee', exact: true }).click();
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
      await tickets.getByRole('cell', { name: 'Mira Patel, Sam Lee and 3 more', exact: true }).waitFor();

      // A ticket's link to a hand-added person opens their person page, where their photo can change.
      await tickets.getByRole('link', { name: 'Jordan Chen', exact: true }).first().click();
      await page.waitForURL(/\/members-table-mock\/members\/people\/[0-9a-f-]{36}$/);
      const memberId = new URL(page.url()).pathname.split('/').at(-1);
      await page.getByRole('heading', { name: 'Jordan Chen', exact: true }).waitFor();
      await page.getByText('WD-106', { exact: true }).waitFor();
      await page.getByRole('link', { name: 'Invite to workspace', exact: true }).waitFor();
      const photo = page.getByRole('region', { name: 'Photo', exact: true });
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
          await page.getByRole('button', { name: 'Check row request', exact: true }).waitFor();
          assert.ok(await photo.getByRole('button', { name: 'Remove', exact: true }).isDisabled());
          await page.getByRole('button', { name: 'Check row request', exact: true }).click();
          if (recovery === 'retry')
            await page.getByRole('button', { name: 'Retry same row request', exact: true }).click();
          await photo.getByRole('button', { name: 'Remove', exact: true }).click({ trial: true });
          assert.ok(await photo.getByRole('button', { name: 'Remove', exact: true }).isEnabled());
          assert.deepEqual(
            errors.splice(previousErrors),
            ['Failed to load resource: net::ERR_FAILED'],
            'only the deliberately lost response may log an error',
          );
        }
        await page.waitForFunction(previous => {
          const image = document.querySelector('[aria-label="Photo"] img');
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
      await page.reload();
      await photo.locator('img').waitFor();
      assert.equal(
        await photo.locator('img').getAttribute('src'),
        secondImage,
        'document reload retains this server session’s image',
      );
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
        `${origin}${root}/tables/${memberTableId}/requests/*`,
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
      await photo.getByRole('button', { name: 'Remove', exact: true }).click();
      await photo.getByRole('button', { name: 'Upload image', exact: true }).waitFor();
      assert.equal(await photo.locator('img').count(), 0);

      assert.deepEqual(errors, []);
      assert.deepEqual(requests, [], 'fetch, images and EventSource must not reach a real API');
    } finally {
      await browser?.close();
      await server.close();
    }
  },
);

test(
  'member readers see people without changing them, and private account methods on small screens',
  { timeout: 90000 },
  async () => {
    const server = await startWorkspaceMembersDemo({ port: 5794, scenario: 'reader' });
    const browser = await chromium.launch({ headless: process.env.CHAT_BROWSER_HEADED !== '1' });
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
      await page.goto(`${server.origin}/members-table-mock/tables/87654321-4321-4321-8321-000000000010`);
      await page.waitForURL(`${server.origin}/members-table-mock/members`);
      const list = page.getByRole('table', { name: 'Workspace members', exact: true });
      const maya = list.getByRole('row').filter({ has: page.getByText('Maya Rao', { exact: true }) });
      await maya.getByText('No account', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Add person', exact: true }).count(), 0);
      assert.equal(
        await maya.getByRole('button', { name: 'Actions for Maya Rao', exact: true }).count(),
        0,
        'readers cannot invite or remove people',
      );
      await page.setViewportSize({ width: 375, height: 812 });
      await maya.getByRole('link', { name: 'Maya Rao', exact: true }).click();
      await page.waitForURL(`${server.origin}/members-table-mock/members/people/87654321-4321-4321-8321-000000000022`);
      await page.getByRole('heading', { name: 'Profile', exact: true }).waitFor();
      await page.getByText('WD-103', { exact: true }).waitFor();
      for (const name of ['Edit profile', 'Upload image', 'Remove'])
        assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0, name);
      assert.equal(await page.getByRole('link', { name: 'Invite to workspace', exact: true }).count(), 0);
      assert.equal(await page.locator('input[type="file"]').count(), 0);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: '/tmp/workspace-members-reader-mobile.png' });
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
      await browser.close();
      await server.close();
    }
  },
);
