import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { chat, draftText, id, isAuthority, messageText, startFixture, workspace } from './query-loading.fixture.mjs';

const mode = process.argv[2] ?? 'baseline';
assert.ok(
  ['baseline', 'acceptance'].includes(mode),
  'Usage: node test/query-loading.browser.mjs [baseline|acceptance]',
);
const port = Number(process.env.QUERY_LOADING_PORT ?? 5493);
const origin = `http://127.0.0.1:${port}`;
const appRoot = new URL('..', import.meta.url);
const fixture = await startFixture();
const report = {
  schemaVersion: 1,
  mode,
  measuredAt: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: appRoot, encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['status', '--porcelain'], { cwd: appRoot, encoding: 'utf8' }).trim().length > 0,
  environment: {
    node: process.version,
    platform: process.platform,
    browser: null,
    apiLatencyMs: fixture.state.latencyMs,
    server: 'Vite development',
    visibility: 'synthetic visibilityState + visibilitychange and focus events; real timers',
    payload:
      'uncompressed REST JSON bodies sent by loopback fixture, excludes headers, preflights, assets and aborted responses',
  },
  devices: [],
  failures: [],
};
let server;
let browser;
let serverLog = '';
const rounded = n => Math.round(n * 10) / 10;
const count = (rows, suffix) => rows.filter(row => row.path.endsWith(suffix)).length;

function summarize(rows) {
  const byPath = {};
  for (const row of rows) {
    const key = `${row.method} ${row.path}`;
    const item = (byPath[key] ??= {
      requests: 0,
      payloadBytes: 0,
      aborted: 0,
      authority: row.method === 'GET' && isAuthority(row.path),
    });
    item.requests++;
    item.payloadBytes += row.payloadBytes;
    item.aborted += Number(!!row.aborted);
  }
  return {
    requests: rows.length,
    featureRequests: rows.filter(row => !isAuthority(row.path)).length,
    payloadBytes: rows.reduce((n, row) => n + row.payloadBytes, 0),
    byPath,
  };
}

try {
  assert.equal(
    await fetch(origin).then(
      () => true,
      () => false,
    ),
    false,
    `Port ${port} must be unused`,
  );
  server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: appRoot,
    env: { ...process.env, VITE_API_URL: fixture.origin },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => {
    serverLog = (serverLog + chunk).slice(-8000);
  });
  server.stderr.on('data', chunk => {
    serverLog = (serverLog + chunk).slice(-8000);
  });
  for (
    let attempt = 0;
    !(await fetch(origin).then(
      response => response.ok,
      () => false,
    ));
    attempt++
  ) {
    assert.ok(attempt < 200 && server.exitCode === null, `Vite starts: ${serverLog}`);
    await delay(100);
  }
  browser = await chromium.launch({ headless: true });
  report.environment.browser = browser.version();
  for (const mobile of [false, true]) {
    const result = {
      device: mobile ? 'mobile' : 'desktop',
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      phases: [],
      observations: {},
      checks: [],
    };
    report.devices.push(result);
    const context = await browser.newContext({
      viewport: result.viewport,
      isMobile: mobile,
      hasTouch: mobile,
      colorScheme: mobile ? 'dark' : 'light',
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
    });
    const external = [];
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if ([origin, fixture.origin].includes(url.origin)) return route.continue();
      external.push(url.origin + url.pathname);
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(120000);
    const goto = url => page.goto(url, { waitUntil: 'domcontentloaded' });
    const reload = () => page.reload({ waitUntil: 'domcontentloaded' });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const input = page.getByRole('textbox', { name: 'Message', exact: true });
    const detail = `${origin}/${workspace.slug}/chat/${id}`;
    fixture.state.status = 'completed';
    fixture.state.available = 1000;

    function check(name, passed, detail) {
      result.checks.push({ name, passed, detail });
      if (mode === 'acceptance' && !passed) report.failures.push(`${result.device}: ${name}`);
    }
    async function settle() {
      for (let i = 0; i < 100; i++) {
        const rows = fixture.state.requests;
        const last = rows.at(-1);
        if (!last || (rows.every(row => row.completedAt || row.aborted) && performance.now() - last.startedAt > 150))
          return;
        await delay(25);
      }
      throw Error('REST fixture did not become idle');
    }
    async function usableChat() {
      await page.getByRole('heading', { name: chat.title, exact: true }).waitFor();
      await page.getByText(messageText, { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Model: Claude Sonnet', exact: true }).waitFor();
      await input.fill(draftText);
      await page.waitForFunction(() => document.querySelector('button[aria-label="Send message"]')?.disabled === false);
    }
    async function clearDraft() {
      // Editor keys keep ProseMirror's selection in step; a DOM select-all fill can race it and delete nothing under load.
      await input.focus();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Backspace');
      // The leave-edits guard reads the committed draft, so navigate only after the cleared draft disables sending (a running reply shows Stop instead).
      await page.waitForFunction(() => document.querySelector('button[aria-label="Send message"]')?.disabled ?? true);
    }
    async function measure(name, action, usable, minimumWindowMs = 0) {
      await settle();
      const start = performance.now();
      const index = fixture.state.requests.length;
      await action();
      await usable?.();
      const usableMs = usable ? rounded(performance.now() - start) : null;
      await delay(Math.max(0, minimumWindowMs - (performance.now() - start)));
      await settle();
      const rows = fixture.state.requests.slice(index);
      const phase = { name, usableMs, windowMs: rounded(performance.now() - start), ...summarize(rows) };
      result.phases.push(phase);
      return { phase, rows, start };
    }
    async function visibility(hidden, focus = false) {
      await page.evaluate(
        ({ hidden, focus }) => {
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            get: () => (hidden ? 'hidden' : 'visible'),
          });
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
          document.dispatchEvent(new Event('visibilitychange'));
          if (focus) window.dispatchEvent(new Event('focus'));
        },
        { hidden, focus },
      );
    }
    async function toList() {
      await clearDraft();
      await page.getByRole('button', { name: 'Back to chats', exact: true }).click();
      await page.getByRole('button', { name: chat.title, exact: true }).waitFor();
    }
    async function navigateLink(path) {
      // Use a real router link, including the collapsed mobile sidebar and workspace menu, without a document reload.
      const link = page.locator(`a[href="/${workspace.slug}${path}"]`).first();
      if (!(await link.isVisible()) && mobile)
        await page.getByRole('button', { name: 'Toggle Sidebar', exact: true }).first().click();
      if (!(await link.isVisible()))
        await page.getByRole('button', { name: `Workspace menu, ${workspace.name}`, exact: true }).click();
      await link.click();
    }
    try {
      const cold = await measure('cold-startup', () => goto(detail), usableChat);
      check(
        'cold chat deduplicates model catalog reads',
        count(fixture.state.requests.slice(-result.phases[0].requests), '/model-catalog') === 1,
        'one chat model catalog GET',
      );
      check(
        'ordinary chat leaves GitHub account reads on demand',
        !cold.rows.some(row => row.path.includes('/github/')),
        cold.phase.byPath,
      );
      await clearDraft();
      await measure('warm-reload', reload, usableChat);
      const focus = await measure(
        'focus-return',
        async () => {
          await visibility(true);
          await delay(100);
          await visibility(false, true);
          await delay(10);
          result.observations.sendEnabledDuringFocus = await page
            .getByRole('button', { name: 'Send message', exact: true })
            .isEnabled();
        },
        async () => {
          await page.getByText(messageText, { exact: true }).waitFor();
          await page.waitForFunction(
            () => document.querySelector('button[aria-label="Send message"]')?.disabled === false,
          );
        },
        650,
      );
      result.observations.draftAfterFocus = await input.textContent();
      check(
        'focus has zero feature GETs',
        focus.rows.filter(row => row.method === 'GET' && !isAuthority(row.path)).length === 0,
        focus.phase.byPath,
      );
      check('focus retains draft', (await input.textContent()) === draftText, result.observations.draftAfterFocus);
      check(
        'focus keeps send enabled',
        result.observations.sendEnabledDuringFocus,
        'sampled 10ms after focus with 40ms REST delay',
      );
      await toList();
      await measure(
        'fresh-revisit',
        () => page.getByRole('button', { name: chat.title, exact: true }).click(),
        usableChat,
      );
      await toList();
      await delay(31000);
      await measure(
        'stale-revisit',
        () => page.getByRole('button', { name: chat.title, exact: true }).click(),
        usableChat,
      );
      await clearDraft();
      await measure(
        'older-page',
        () => page.getByRole('button', { name: 'Load older messages', exact: true }).click(),
        () => page.getByText('Older measured message.', { exact: true }).waitFor(),
      );

      await goto(detail);
      await usableChat();
      await clearDraft();
      await settle();
      const models = await measure(
        'models-second-consumer',
        async () => {
          await navigateLink('/settings');
          await page.getByLabel('Workspace name', { exact: true }).waitFor();
          await navigateLink('/settings/models');
        },
        () => page.getByRole('row', { name: 'Claude Sonnet', exact: true }).waitFor(),
      );
      check(
        'fresh catalog reused by settings model consumer',
        count(models.rows, '/model-catalog') === 0,
        count(models.rows, '/model-catalog'),
      );

      const concurrentModels = await measure(
        'models-concurrent-consumers',
        () => goto(`${origin}/${workspace.slug}/agents/${id}`),
        async () => {
          await page.getByText('Claude Sonnet is available.', { exact: true }).waitFor();
          await page.getByRole('tab', { name: 'Instructions', exact: true }).click();
          await page.getByLabel('Preferred model family', { exact: true }).waitFor();
          // The family is a custom Select whose trigger shows the chosen family (cloud 9be14feb features/models/agent-model-picker.tsx:21-25).
          assert.equal(
            (await page.getByLabel('Preferred model family', { exact: true }).innerText()).trim(),
            'Claude Sonnet',
          );
        },
      );
      check(
        'agent readiness and picker deduplicate models',
        count(concurrentModels.rows, '/model-catalog') <= 1,
        count(concurrentModels.rows, '/model-catalog'),
      );

      fixture.state.status = 'processing';
      await goto(detail);
      await usableChat();
      await clearDraft();
      await page.getByRole('button', { name: 'Load older messages', exact: true }).click();
      await page.getByText('Older measured message.', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Stop reply', exact: true }).waitFor();
      await settle();
      const terminal = await measure('terminal-transition-two-pages', async () => {
        fixture.state.status = 'completed';
        fixture.state.available = 975;
        await page.waitForFunction(() => !document.querySelector('button[aria-label="Stop reply"]'));
        await delay(1000);
      });
      const observed = terminal.rows.some(row => row.turnStatus === 'completed');
      assert.ok(observed, 'Fixture terminal response must be observed before measuring terminal invalidation');
      result.observations.terminalObserved = observed;
      check('terminal transition observed through polling', observed, terminal.phase.byPath);
      check(
        'terminal leaves unrelated catalogs alone',
        count(terminal.rows, '/model-catalog') === 0 &&
          !terminal.rows.some(row => row.path.includes('/github/') || row.path.includes('/google-workspace/')),
        terminal.phase.byPath,
      );
      await measure('unchanged-terminal', () => delay(3000));

      fixture.state.status = 'processing';
      await reload();
      await usableChat();
      await clearDraft();
      const hidden = await measure('hidden-polling', async () => {
        await visibility(true);
        await delay(16000);
      });
      check(
        'synthetic hidden state suspends chat polling',
        !hidden.rows.some(row => row.path.endsWith('/messages')),
        hidden.phase.byPath,
      );
      const resumed = await measure('resumed-polling', async () => {
        await visibility(false, true);
        await delay(17000);
      });
      const chatRows = resumed.rows.filter(row => row.path.endsWith('/messages'));
      result.observations.resumedChatDelaysMs = chatRows.map(row => rounded(row.startedAt - resumed.start));
      check(
        'return waits full chat interval then resumes',
        chatRows.length > 0 &&
          chatRows[0].startedAt - resumed.start >= 1900 &&
          chatRows[0].startedAt - resumed.start < 3500,
        result.observations.resumedChatDelaysMs,
      );
      assert.deepEqual(errors, [], 'No browser runtime errors');
      assert.deepEqual(external, [], 'No external services requested');
      assert.deepEqual(fixture.state.unknown, [], 'All REST routes explicitly stubbed');
    } finally {
      await context.close();
    }
  }
  assert.equal(report.devices.length, 2);
  assert.ok(
    report.devices.every(
      device => device.phases.length >= 10 && device.phases[0].requests > 0 && device.phases[0].payloadBytes > 0,
    ),
    'Nonempty measured report',
  );
} catch (error) {
  report.failures.push(String(error.stack ?? error));
} finally {
  await browser?.close();
  server?.kill('SIGTERM');
  await fixture.close();
  if (process.env.QUERY_LOADING_REPORT)
    await writeFile(process.env.QUERY_LOADING_REPORT, JSON.stringify(report, null, 2) + '\n');
  const summary = {
    report: process.env.QUERY_LOADING_REPORT,
    devices: report.devices.map(({ device, phases, observations, checks }) => ({
      device,
      phases: phases.map(({ byPath: _byPath, ...phase }) => phase),
      observations,
      checks: checks.map(({ name, passed }) => ({ name, passed })),
    })),
    failures: report.failures,
  };
  console.log(JSON.stringify(process.env.QUERY_LOADING_REPORT ? summary : report, null, 2));
}
if (report.failures.length) process.exitCode = 1;
