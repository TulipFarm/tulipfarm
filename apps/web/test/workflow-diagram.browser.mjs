import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

test('workflow page and chat show inspectable, immutable diagrams', async t => {
  const port = process.env.WORKFLOW_DIAGRAM_PORT ?? '5877';
  const origin = `http://127.0.0.1:${port}`;
  // Agent artwork is opt-in; configure the origin this test routes.
  const server = spawn(
    process.execPath,
    [
      new URL('../node_modules/vite/bin/vite.js', import.meta.url).pathname,
      '--host',
      '127.0.0.1',
      '--port',
      port,
      '--strictPort',
    ],
    {
      cwd: new URL('..', import.meta.url),
      stdio: 'ignore',
    },
  );
  let browser;
  try {
    for (
      let attempt = 0;
      !(await fetch(origin).then(
        response => response.ok,
        () => false,
      ));
      attempt++
    ) {
      assert.ok(attempt < 150 && server.exitCode === null, 'Vite starts on its own port');
      await delay(100);
    }
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(10000);
    const errors = [],
      apiRequests = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/v1/')) apiRequests.push(request.url());
    });
    const load = (scenario = 'pr', state = 'draft', surface = 'workflows') =>
      page.goto(`${origin}/workflow-mock/${surface}?scenario=${scenario}&state=${state}`);
    const fit = () =>
      page.waitForFunction(() => {
        const transform = document.querySelector('.react-flow__viewport')?.style.transform;
        return transform && transform !== 'translate(0px, 0px) scale(1)';
      });
    const positions = () =>
      page
        .locator('.react-flow__node')
        .evaluateAll(nodes => nodes.map(node => [node.dataset.id, node.style.transform]));
    const viewport = () => page.locator('.react-flow__viewport').getAttribute('style');
    const inspect = page.getByRole('region', { name: 'Step details', exact: true });
    const noOverflow = async () =>
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        'page does not overflow horizontally',
      );

    await t.test('definitions are inspectable and immutable', { timeout: 60000 }, async () => {
      await load();
      await fit();
      assert.equal(await page.locator('.workflow-node').count(), 3);
      assert.equal(await page.locator('.workflow-node [data-brand="slack"]').count(), 1);
      assert.equal(await page.locator('.workflow-node [data-brand="github"]').count(), 1);
      assert.equal(
        await page.locator('.workflow-viewer').locator('input, textarea, select').count(),
        0,
        'the definition has no form controls',
      );
      assert.equal(await page.getByRole('button', { name: /Toggle Interactivity/ }).count(), 0);
      const before = await positions();
      const prepare = page.getByRole('button', { name: 'Inspect Prepare PR summary', exact: true });
      const box = await prepare.boundingBox();
      await page.mouse.move(box.x + 40, box.y + 50);
      await page.mouse.down();
      await page.mouse.move(box.x + 130, box.y + 80, { steps: 8 });
      await page.mouse.up();
      await prepare.focus();
      for (const key of ['ArrowDown', 'ArrowRight', 'Delete', 'Backspace', 'Enter']) await page.keyboard.press(key);
      assert.deepEqual(await positions(), before, 'mouse and keyboard cannot change node positions or remove nodes');
      const handle = await page.locator('.react-flow__handle-bottom').first().boundingBox();
      await page.mouse.move(handle.x + 3, handle.y + 3);
      await page.mouse.down();
      await page.mouse.move(handle.x + 110, handle.y + 80);
      await page.mouse.up();
      assert.equal(await page.locator('.react-flow__edge').count(), 2, 'dragging handles cannot connect or reconnect');
      assert.equal(await page.locator('.react-flow__edgeupdater').count(), 0);
      await page.getByRole('button', { name: 'Inspect Notify engineering', exact: true }).click();
      assert.equal(await inspect.locator('[data-brand="slack"]').count(), 1);
      await inspect.getByText('The requester or sponsor approves each exact message before it is sent.').waitFor();
      assert.equal(await inspect.locator('pre').count(), 0, 'raw configuration starts collapsed');
      await inspect.getByRole('button', { name: 'Details', exact: true }).click();
      await inspect.locator('pre').waitFor();
      await inspect.getByRole('button', { name: 'Prepare PR summary', exact: true }).click();
      await inspect.getByRole('heading', { name: 'Prepare PR summary' }).waitFor();
    });

    await t.test('live state preserves viewport and respects reduced motion', { timeout: 60000 }, async () => {
      await load('agent', 'running');
      await fit();
      await page.locator('.workflow-path-marker').waitFor();
      await page.locator('.workflow-node[data-step-id="research"] [data-slot="avatar-image"]').waitFor();
      await inspect.locator('[data-slot="avatar-image"]').waitFor();
      await page.getByRole('button', { name: 'Zoom In', exact: true }).click();
      await delay(300);
      const zoomed = await viewport();
      await page.getByRole('button', { name: 'Next state', exact: true }).click();
      await page.locator('.workflow-node[data-state="waiting"]').waitFor();
      assert.equal(await viewport(), zoomed, 'status updates keep the viewport');
      assert.equal(await page.locator('.workflow-path-marker').count(), 0);
      await page.getByRole('button', { name: 'Next state', exact: true }).click();
      assert.equal(await page.locator('.workflow-node[data-state="completed"]').count(), 4);
      await load('agent', 'running');
      await fit();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.waitForFunction(() => document.querySelector('.workflow-diagram')?.dataset.motion === 'false');
      assert.equal(await page.locator('animateMotion').count(), 0, 'reduced motion removes the moving marker');
      assert.equal(
        await page
          .locator('.workflow-activity-mark')
          .last()
          .evaluate(el => getComputedStyle(el).animationName),
        'none',
      );
    });

    await t.test('loading, access and refresh states recover', { timeout: 60000 }, async () => {
      for (const [state, heading, action] of [
        ['error', 'Could not load workflow', 'Retry loading'],
        ['denied', 'Workflow unavailable', 'Recheck access'],
        ['loading', 'Loading workflow', 'Finish sample load'],
        ['dismissed', 'Draft dismissed', 'Review again'],
      ]) {
        await load('pr', state);
        await (
          state === 'loading'
            ? page.getByRole('status', { name: heading })
            : page.getByRole('heading', { name: heading })
        ).waitFor();
        assert.equal(await page.locator('.workflow-node').count(), 0);
        await page.getByRole('button', { name: action, exact: true }).click();
        await fit();
      }
      await load('pr', 'stale');
      await page.getByText('Refresh failed. This is the last loaded version, not a confirmed current view.').waitFor();
      assert.equal(await page.locator('.workflow-node').count(), 3);
      await page.getByRole('button', { name: 'Refresh workflow', exact: true }).click();
      assert.equal(await page.getByText('Refresh failed.', { exact: true }).count(), 0);
      await load('pr', 'empty');
      await page.getByRole('heading', { name: 'No workflows yet' }).waitFor();
      assert.equal(await page.locator('.workflow-node').count(), 0);
    });

    const chat = 'chat/11111111-1111-4111-8111-111111111111';
    await t.test('Canvas retains composer and supports close and reopen', { timeout: 60000 }, async () => {
      await load('pr', 'draft', chat);
      await fit();
      await page.locator('[contenteditable="true"]').fill('Keep my notes about the release.');
      await page.getByRole('button', { name: 'Edit in chat', exact: true }).click();
      await page.getByText('Your edit request is in the composer. Nothing has been sent.').waitFor();
      assert.match(await page.locator('[contenteditable="true"]').innerText(), /Help me edit.*Pull request updates/);
      assert.match(await page.locator('[contenteditable="true"]').innerText(), /Keep my notes about the release/);
      assert.equal(await page.locator('[contenteditable="true"]').evaluate(el => el === document.activeElement), true);
      await page.getByRole('button', { name: /Show canvas/ }).click();
      await fit();
      await page.getByRole('button', { name: 'Close Workflow', exact: true }).click();
      await page.getByRole('heading', { name: 'No workflow open' }).waitFor();
      await page.getByRole('button', { name: 'Open workflow', exact: true }).click();
      await fit();
      await page.getByRole('button', { name: 'Save workflow', exact: true }).click();
      await page.getByText('Sample saved state only. No workflow was saved or activated.').waitFor();
      await page.getByRole('button', { name: 'Steps', exact: true }).click();
      await page.locator('.workflow-step-list [data-brand="slack"]').waitFor();
      await page
        .getByRole('list', { name: 'Workflow steps' })
        .getByRole('button', { name: 'Inspect Notify engineering' })
        .click();
      await inspect.getByRole('heading', { name: 'Notify engineering' }).waitFor();
    });

    await t.test('page and Canvas show branches and formatted waits', { timeout: 60000 }, async () => {
      for (const surface of ['workflows', chat]) {
        await load('approval', 'draft', surface);
        await fit();
        const { yes, no } = await page.evaluate(() => ({
          yes: document.querySelector('.workflow-node[data-step-id="review"]').getBoundingClientRect().toJSON(),
          no: document.querySelector('.workflow-node[data-step-id="record"]').getBoundingClientRect().toJSON(),
        }));
        assert.ok(yes.x + yes.width < no.x, 'Yes and No cards occupy separate lanes');
        assert.ok(Math.abs(yes.y - no.y) < 1, 'exclusive branches share a level');
        assert.ok(
          await page.locator('.workflow-diagram').evaluate(diagram => {
            const bounds = diagram.getBoundingClientRect();
            return [...diagram.querySelectorAll('.workflow-node')].every(node => {
              const card = node.getBoundingClientRect();
              return card.top >= bounds.top && card.bottom <= bounds.bottom;
            });
          }),
          'short branching diagrams show every card without vertical clipping',
        );
        await load('waiting', 'draft', surface);
        await page.getByRole('button', { name: 'Steps', exact: true }).click();
        await page.getByRole('list', { name: 'Workflow steps' }).getByText('30 minutes', { exact: true }).waitFor();
        await page
          .getByRole('list', { name: 'Workflow steps' })
          .getByRole('button', { name: 'Inspect Wait until a date' })
          .click();
        assert.ok(!(await inspect.innerText()).includes('2027-01-12T03:30:00Z'));
      }
    });

    for (const width of [320, 375, 414, 768]) {
      await t.test(`workflow and Canvas attach at ${width}px`, { timeout: 60000 }, async () => {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: width === 375 || width === 768 ? 'dark' : 'light' });
        await load('long');
        await fit();
        await noOverflow();
        assert.equal(await page.locator('.workflow-node').count(), 33);
        const card = await page.locator('.workflow-node').first().boundingBox();
        assert.ok(card.width >= 185, 'long workflows start at a readable scale');
        await page.getByRole('button', { name: 'Steps', exact: true }).click();
        assert.equal(await page.getByRole('list', { name: 'Workflow steps' }).getByRole('button').count(), 33);
        await noOverflow();
        const list = page.locator('.workflow-step-list');
        assert.ok(await list.evaluate(el => el.scrollWidth <= el.clientWidth), 'ordered steps wrap long titles');
        await load('agent', 'running', chat);
        if (width < 768) await page.getByRole('button', { name: /Show canvas/ }).click();
        await fit();
        assert.equal(
          await page.getByRole('region', { name: 'Canvas', exact: true }).locator('.workflow-node').count(),
          4,
          'the graph is connected inside Canvas on first open',
        );
        await noOverflow();
        if (width === 375)
          assert.equal(
            await page
              .locator('.workflow-node')
              .first()
              .evaluate(el => getComputedStyle(el).backgroundColor),
            'rgb(22, 23, 26)',
            'graph uses the app dark palette',
          );
        await page.setViewportSize({ width: 1440, height: 1000 });
        await fit();
        await page.getByRole('region', { name: 'Canvas', exact: true }).locator('.workflow-node').first().waitFor();
      });
    }
    assert.deepEqual(
      await page.evaluate(async () => {
        const paths = ['/v1/workspaces', '/v1/workspaces/mock/workflows', '/v1/workspaces/mock/conversations'];
        return Promise.all(paths.map(async path => (await fetch(path, { method: 'POST', body: '{}' })).status));
      }),
      [403, 403, 403],
    );
    assert.deepEqual(apiRequests, [], 'all API calls stayed inside the mock interceptor');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
  }
});
