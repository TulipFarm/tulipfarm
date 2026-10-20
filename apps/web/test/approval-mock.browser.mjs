import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';

test('local approval mock keeps decisions reachable and shows execution outcomes', { timeout: 120000 }, async () => {
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const url = `${origin}/approval-mock/chat/11111111-1111-4111-8111-111111111111`;
  const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: new URL('..', import.meta.url),
    stdio: 'ignore',
  });
  // Screenshots are evidence for design review; set APPROVAL_MOCK_SCREENSHOTS to a directory to keep them.
  const shots = process.env.APPROVAL_MOCK_SCREENSHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  const shoot = async (page, name) => {
    if (shots) await page.screenshot({ path: `${shots}/approval-mock-${name}.png` });
  };
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
      assert.ok(attempt < 150 && server.exitCode === null, 'mock server starts');
      await delay(100);
    }
    browser = await chromium.launch();
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      colorScheme: 'light',
      reducedMotion: 'reduce',
    });
    const errors = [];
    const apiRequests = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/v1/')) apiRequests.push(request.url());
    });
    const approval = page.getByRole('region', { name: 'Approval', exact: true });
    const select = async (label, option) => {
      await page.getByRole('combobox', { name: label }).click();
      await page.getByRole('option', { name: option, exact: true }).click();
    };
    await page.goto(url);
    await approval.getByRole('button', { name: 'Approve & create', exact: true }).waitFor();
    await shoot(page, 'review');
    await approval.getByRole('button', { name: 'Approve & create', exact: true }).click();
    await approval.getByRole('heading', { name: 'Recording your approval' }).waitFor();
    assert.ok(await approval.getByRole('button', { name: 'Approving...' }).isDisabled());
    await approval.getByRole('heading', { name: 'Creating Customers' }).waitFor();
    await shoot(page, 'progress');
    await approval.getByRole('heading', { name: 'Customers table created' }).waitFor();
    await shoot(page, 'success');
    await approval.getByRole('button', { name: 'View table', exact: true }).click();
    await page.getByText('Only the table structure was created in this mock.').waitFor();

    await select('Mock scenario', 'Three tables');
    assert.equal(await approval.locator('li').count(), 3);
    await approval.getByRole('button', { name: 'Approve & create', exact: true }).click();
    await approval.getByText('1 of 3 tables created. Applying the changes you approved.').waitFor();
    await approval.getByRole('heading', { name: 'All 3 tables created' }).waitFor();

    await select('Mock scenario', 'Failed creation');
    await approval.getByRole('button', { name: 'Approve & create', exact: true }).click();
    await approval.getByRole('heading', { name: 'Customers was not created' }).waitFor();
    await shoot(page, 'error');
    await approval.getByRole('button', { name: 'Retry creation' }).click();
    await approval.getByRole('heading', { name: 'Customers was not created' }).waitFor();
    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    await approval.getByRole('button', { name: 'Reject', exact: true }).click();
    await approval.getByRole('heading', { name: 'Proposal rejected' }).waitFor();
    await approval.getByRole('button', { name: 'Review again' }).click();
    await approval.getByRole('heading', { name: 'Ready for your approval' }).waitFor();

    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      for (const width of [320, 375, 414, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(url);
        // From 768px the mock opens the canvas (approval-mock.tsx:47), but beside the sidebar the split is under 720px,
        // so the canvas covers the chat as a sheet (cloud ui canvas.tsx:13,26); return to chat as its notice says.
        const sheet = page.getByRole('dialog', { name: 'Canvas', exact: true });
        await page.getByRole('region', { name: 'Conversation', exact: true }).or(sheet).first().waitFor();
        if (await sheet.isVisible()) await sheet.getByRole('button', { name: 'Back to chat', exact: true }).click();
        await approval.getByRole('button', { name: 'Approve & create', exact: true }).waitFor();
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `no page overflow at ${width} in ${colorScheme}`,
        );
        const box = await approval.boundingBox();
        assert.ok(
          box && box.x >= 0 && box.y > 0 && box.x + box.width <= width && box.y + box.height < 900,
          `approval is visible at ${width}`,
        );
        const before = box.y;
        await page.getByRole('region', { name: 'Conversation', exact: true }).evaluate(element => {
          const spacer = document.createElement('div');
          spacer.style.height = '2000px';
          element.append(spacer);
          element.scrollTop = element.scrollHeight;
        });
        assert.equal((await approval.boundingBox()).y, before, 'chat scrolling never moves approval');
        await shoot(page, `${colorScheme}-${width}`);
      }
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(apiRequests, [], 'mock never sends account or workspace requests to a real API');
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
  }
});
