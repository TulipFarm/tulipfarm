import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import PptxGenJS from 'pptxgenjs';
import { chromium } from 'playwright';

const port = Number(process.env.PPTX_CHARTS_BROWSER_PORT ?? 5251);
const origin = `http://127.0.0.1:${port}`;

async function chartDeck() {
  const deck = new PptxGenJS();
  const data = [{ name: 'Revenue', labels: ['Q1', 'Q2', 'Q3', 'Q4'], values: [12, 18, 9, 22] }];
  for (const type of [deck.ChartType.bar, deck.ChartType.line, deck.ChartType.pie])
    deck.addSlide().addChart(type, data, { x: 0.5, y: 0.5, w: 8, h: 4.5, showLegend: true });
  return deck.write({ outputType: 'base64' });
}

test('the pptx renderer draws bar, line, and pie charts with the overridden echarts', { timeout: 120000 }, async () => {
  const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: new URL('..', import.meta.url),
    stdio: 'ignore',
    detached: true,
  });
  let browser;
  try {
    for (let attempt = 0; ; attempt++) {
      if (
        await fetch(origin).then(
          response => response.ok,
          () => false,
        )
      )
        break;
      assert.ok(attempt < 150 && server.exitCode === null, 'Vite starts');
      await delay(100);
    }
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/test/pptx-charts.page.ts`);
    await page.setContent('<!doctype html><body></body>');
    const deck = await chartDeck();
    const charts = await page.evaluate(
      async base64 => (await import('/test/pptx-charts.page.ts')).renderPptx(base64),
      deck,
    );
    assert.equal(charts.length, 3, 'three slides render');
    for (const [index, slide] of charts.entries()) {
      assert.equal(slide.length, 1, `slide ${index + 1} renders one chart`);
      assert.ok(slide[0].shapes > 10, `slide ${index + 1} chart draws its series`);
      assert.ok(slide[0].labels.includes('Revenue'), `slide ${index + 1} chart renders its legend`);
    }
    assert.ok(
      ['Q1', 'Q2', 'Q3', 'Q4'].every(label => charts[2][0].labels.includes(label)),
      'pie chart labels its slices',
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    try {
      process.kill(-server.pid);
    } catch {}
  }
});
