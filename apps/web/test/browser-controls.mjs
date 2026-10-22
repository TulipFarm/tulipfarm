import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export async function chooseOption(page, trigger, name) {
  await trigger.focus();
  await trigger.press('Enter');
  const option = page.getByRole('option', { name, exact: true });
  await option.waitFor();
  await option.press('Enter');
  await page.getByRole('listbox').waitFor({ state: 'hidden' });
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
}

export async function assertVisibleFocus(page) {
  const focus = await page.evaluate(() => {
    const element = document.activeElement;
    const style = getComputedStyle(element);
    return {
      visible: element.matches(':focus-visible'),
      painted: (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none',
    };
  });
  assert.deepEqual(focus, { visible: true, painted: true }, 'keyboard focus has a visible outline or ring');
}

export const evidenceBrowserArgs = () =>
  process.env.BROWSER_CDP_PORT ? [`--remote-debugging-port=${process.env.BROWSER_CDP_PORT}`] : [];

export async function captureEvidence(page, path) {
  if (!process.env.BROWSER_CDP_PORT) return page.screenshot({ path });
  await page.bringToFront();
  const run = (...args) =>
    execFileSync('agent-browser', ['--session', 'audit-evidence', '--cdp', process.env.BROWSER_CDP_PORT, ...args], {
      encoding: 'utf8',
      timeout: 15000,
    });
  const result = JSON.parse(run('tab', 'list', '--json'));
  assert.equal(result.success, true);
  const targets = result.data.tabs.filter(tab => tab.url === page.url());
  assert.equal(targets.length, 1, 'capture targets exactly the tested page, including across browser contexts');
  run('tab', targets[0].tabId);
  run('screenshot', path);
  const image = await readFile(path);
  assert.deepEqual(
    { width: image.readUInt32BE(16), height: image.readUInt32BE(20) },
    page.viewportSize(),
    'captured PNG matches the tested viewport',
  );
}
