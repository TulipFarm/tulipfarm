import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const port = Number(process.env.INVESTIGATION_PORT ?? 5183);
const origin = `http://127.0.0.1:${port}`;
const id = '11111111-1111-4111-8111-111111111111';
const screenshots = process.env.INVESTIGATION_SCREENSHOTS;
const base = process.env.INVESTIGATION_ORIGIN ?? origin;
let server;
let browser;

before(async () => {
  server = process.env.INVESTIGATION_ORIGIN
    ? null
    : spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
        cwd: new URL('..', import.meta.url),
        stdio: 'ignore',
      });
  for (let attempt = 0; ; attempt++) {
    if (
      await fetch(base).then(
        response => response.ok,
        () => false,
      )
    )
      break;
    assert.ok(attempt < 100, 'Vite starts');
    await delay(100);
  }
  if (screenshots) await mkdir(screenshots, { recursive: true });
  browser = await chromium.launch({ headless: process.env.CHAT_BROWSER_HEADED !== '1' });
});

after(async () => {
  await browser?.close();
  server?.kill('SIGTERM');
});

test('private investigation chooser states on real chat and task screens', { timeout: 120000 }, async t => {
  for (const task of [false, true]) {
    const context = await browser.newContext({
      viewport: task ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      colorScheme: task ? 'dark' : 'light',
      reducedMotion: 'reduce',
    });
    try {
      for (const scenario of [
        'choice',
        'slow',
        'empty',
        'error',
        'denied',
        'selected',
        'partial',
        'completed',
        'save-error',
        'end-error-empty',
      ])
        await t.test(`${task ? 'task' : 'chat'} ${scenario}`, async () => {
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', error => errors.push(String(error)));
          page.setDefaultTimeout(12000);
          try {
            await page.goto(
              `${base}/github-investigation-mock/${task ? 'agent-tasks' : 'chat'}/${id}?scenario=${scenario}${scenario === 'slow' ? '&hold=1' : ''}`,
            );
            if (scenario === 'slow') {
              await page.getByRole('status', { name: 'Loading GitHub investigation sources' }).waitFor();
              assert.equal(await page.getByText('No GitHub source available', { exact: true }).count(), 0);
              await page.evaluate(() => window.dispatchEvent(new Event('github-investigation-ready')));
            }
            if (scenario === 'denied') {
              await page.getByText('Investigation access unavailable', { exact: true }).waitFor();
              const loading = page.getByRole('status', { name: 'Loading GitHub investigation sources' });
              await loading.waitFor({ state: 'hidden' });
              const reads = Number(await page.locator('html').getAttribute('data-investigation-reads'));
              await page.getByRole('button', { name: 'Check GitHub sources', exact: true }).click();
              await page.waitForFunction(
                previous => Number(document.documentElement.dataset.investigationReads) > previous,
                reads,
              );
              await loading.waitFor({ state: 'hidden' });
              await page.getByText('Investigation access unavailable', { exact: true }).waitFor();
              assert.equal(await page.getByRole('status', { name: 'Loading GitHub investigation sources' }).count(), 0);
              assert.ok(
                Number(await page.locator('html').getAttribute('data-investigation-reads')) <= 4,
                'denied retries do not restart the parent in a loop',
              );
            } else if (scenario === 'error') {
              await page.getByText('Could not load GitHub sources', { exact: true }).waitFor();
              await page.getByRole('button', { name: 'Check GitHub sources', exact: true }).click();
              await page.getByRole('combobox', { name: 'GitHub source', exact: true }).waitFor();
            } else if (scenario === 'empty' || scenario === 'end-error-empty') {
              await page.getByText('No GitHub source available', { exact: true }).waitFor();
              if (scenario === 'end-error-empty') {
                await page.getByRole('button', { name: 'End investigation and clear context', exact: true }).click();
                await page.getByRole('alert').filter({ hasText: 'The choice is unconfirmed' }).waitFor();
              }
            } else {
              const picker = page.getByRole('region', { name: 'GitHub investigation', exact: true });
              await picker.getByRole('combobox', { name: 'GitHub source', exact: true }).waitFor();
              if (scenario === 'selected')
                await picker.getByText('Engineering repositories', { exact: true }).waitFor();
              if (scenario === 'choice' || scenario === 'save-error') {
                await picker.getByRole('combobox', { name: 'GitHub source', exact: true }).click();
                await page.getByRole('option', { name: 'Team · Engineering repositories', exact: true }).click();
                await picker.getByRole('button', { name: 'Use for investigation', exact: true }).click();
                if (scenario === 'save-error')
                  await picker
                    .getByText(/The choice is unconfirmed/)
                    .first()
                    .waitFor();
                else await picker.getByText('Engineering repositories', { exact: true }).waitFor();
              }
            }
            assert.equal(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
              true,
              'no horizontal overflow',
            );
            if (task)
              assert.equal(
                await page.getByRole('region', { name: 'Choose a GitHub account', exact: true }).count(),
                0,
                'investigation never shows the alternate personal selector',
              );
            assert.deepEqual(errors, []);
          } finally {
            try {
              if (screenshots)
                await page.screenshot({
                  path: `${screenshots}/investigation-${task ? 'task' : 'chat'}-${scenario}.png`,
                  fullPage: true,
                });
            } finally {
              await page.close();
            }
          }
        });
    } finally {
      await context.close();
    }
  }
});

test('permission saves survive readback and preserve legacy issue grants', { timeout: 120000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.setDefaultTimeout(12000);
  try {
    await page.goto(`${base}/github-investigation-mock/integrations`);
    await page.getByText('GitHub team', { exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Open Engineering repositories', exact: true }).click();
    const permissions = page.getByRole('region', { name: 'GitHub investigation permissions', exact: true });
    const recipient = permissions.getByRole('combobox', { name: 'Person or team', exact: true });
    const repository = permissions.getByRole('combobox', { name: 'Repository', exact: true });
    await recipient.click();
    await page.getByRole('option', { name: 'Team · Engineering', exact: true }).click();
    await repository.click();
    await page.getByRole('option', { name: 'example/web', exact: true }).click();
    await permissions.getByRole('checkbox', { name: 'Actions and checks', exact: true }).click();
    await permissions.getByRole('button', { name: 'Save investigation permissions', exact: true }).click();
    await recipient.filter({ hasText: 'Choose a person or team' }).waitFor();
    await recipient.click();
    await page.getByRole('option', { name: 'Team · Engineering', exact: true }).click();
    await repository.click();
    await page.getByRole('option', { name: 'example/web', exact: true }).click();
    assert.equal(
      await permissions.getByRole('checkbox', { name: 'Actions and checks', exact: true }).isChecked(),
      true,
    );
    assert.equal(
      await page.getByRole('checkbox', { name: 'Read issues in example/web', exact: true }).isChecked(),
      true,
    );
    assert.equal(await page.getByText('Integration status unavailable', { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
