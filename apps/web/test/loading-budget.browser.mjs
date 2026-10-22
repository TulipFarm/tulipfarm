import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { preview as serveBuild } from 'vite';
import { fileURLToPath } from 'node:url';

const app = process.env.UI_APP_ROOT ?? new URL('..', import.meta.url);
const output = new URL('../../../docs/evidence/ui-ux-remaining/', import.meta.url);
await mkdir(output, { recursive: true });
const origin = 'http://127.0.0.1:5460';
const server = await serveBuild({
  root: typeof app === 'string' ? app : fileURLToPath(app),
  configFile: false,
  preview: { host: '127.0.0.1', port: 5460, strictPort: true },
});
let browser;
try {
  for (
    let i = 0;
    !(await fetch(origin).then(
      r => r.ok,
      () => false,
    ));
    i++
  ) {
    if (i > 100) throw Error('Server unavailable');
    await delay(100);
  }
  browser = await chromium.launch({ headless: true });
  const runs = [];
  for (let index = 0; index < 3; index++) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await page.route('**/v1/**', route =>
      route.fulfill({
        json: new URL(route.request().url()).pathname.endsWith('/get-session')
          ? null
          : { error: 'controlled-unavailable' },
        status: new URL(route.request().url()).pathname.endsWith('/get-session') ? 200 : 503,
      }),
    );
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 150,
      downloadThroughput: 200000,
      uploadThroughput: 100000,
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    let scriptBytes = 0;
    const pending = [];
    page.on('response', response => {
      if (new URL(response.url()).pathname.endsWith('.js'))
        pending.push(
          response.body().then(body => {
            scriptBytes += body.byteLength;
          }),
        );
    });
    const started = performance.now();
    await page.goto(origin + '/login');
    const email = page.getByRole('textbox', { name: 'Email', exact: true });
    await email.fill('reader@example.test');
    assert.equal(await email.inputValue(), 'reader@example.test');
    const usableMs = Math.round(performance.now() - started);
    await Promise.all(pending);
    const timing = await page.evaluate(() => ({
      scriptDurationMs: performance
        .getEntriesByType('table')
        .filter(item => item.initiatorType === 'script')
        .reduce((sum, item) => sum + item.duration, 0),
      scripts: performance.getEntriesByType('table').filter(item => item.initiatorType === 'script').length,
    }));
    runs.push({ usableMs, decodedJavaScriptBytes: scriptBytes, ...timing });
    await page.close();
  }
  const median = [...runs].sort((a, b) => a.usableMs - b.usableMs)[1];
  if (process.env.UI_BASELINE !== '1')
    assert.ok(
      median.decodedJavaScriptBytes < 1800000,
      'Cold login JavaScript must remain under the 1.8 MB decoded budget',
    );
  const result = {
    method:
      'Local production build, Chromium, cold cache, 390px, 4x CPU slowdown, 150ms latency, 200000 bytes/s download. Controlled auth errors; not a physical-device measurement.',
    runs,
    median,
  };
  await writeFile(
    new URL(`${process.env.UI_BASELINE === '1' ? 'before' : 'after'}-loading.json`, output),
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
