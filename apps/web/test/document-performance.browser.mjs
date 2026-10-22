import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import { chromium } from 'playwright';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';

const outDir = await mkdtemp(join(tmpdir(), 'tulipfarm-rendering-'));
const root = fileURLToPath(new URL('..', import.meta.url));
let server;
let browser;
try {
  await build({
    root,
    logLevel: 'warn',
    plugins: [
      {
        name: 'rendering-fixture',
        transformIndexHtml: {
          order: 'pre',
          handler: () =>
            '<!doctype html><html lang="en" data-sprout-theme="tulipfarm"><head><meta charset="UTF-8"><title>Rendering verification</title></head><body><div id="root"></div><script type="module" src="/test/rendering-fixture.tsx"></script></body></html>',
        },
      },
    ],
    build: { outDir, emptyOutDir: true },
  });
  server = await preview({ root, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
  const address = server.httpServer.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const markdown = Array.from(
    { length: 200 },
    (_, index) =>
      `## Document section ${index + 1}\n\n**Customer review** with [source](https://example.test).\n\n| Customer | Action |\n| --- | --- |\n| Cedar | Review |\n\n- Confirm ownership.\n- Request approval.\n`,
  ).join('\n');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet(
      Array.from({ length: 1200 }, (_, row) =>
        Array.from({ length: 12 }, (_, column) => `Row ${row + 1} column ${column + 1}`),
      ),
    ),
    'Customers',
  );
  const docx = await JSZip.loadAsync(await readFile(new URL('./fixtures/documents/follow-ups.docx', import.meta.url)));
  const documentXml = await docx.file('word/document.xml').async('string');
  docx.file(
    'word/document.xml',
    documentXml.replace(
      '</w:body>',
      Array.from(
        { length: 500 },
        (_, index) =>
          `<w:p><w:r><w:t>Document paragraph ${index + 1}. Confirm customer ownership before sending the proposal.</w:t></w:r></w:p>`,
      ).join('') + '</w:body>',
    ),
  );
  const slides = await JSZip.loadAsync(
    await readFile(new URL('./fixtures/documents/follow-ups.pptx', import.meta.url)),
  );
  const slideXml = await slides.file('ppt/slides/slide1.xml').async('string');
  const slideRels = await slides.file('ppt/slides/_rels/slide1.xml.rels').async('string');
  let types = await slides.file('[Content_Types].xml').async('string');
  let presentation = await slides.file('ppt/presentation.xml').async('string');
  let relationships = await slides.file('ppt/_rels/presentation.xml.rels').async('string');
  for (let index = 10; index < 50; index++) {
    slides.file(
      `ppt/slides/slide${index}.xml`,
      slideXml.replace(/<a:t>[^<]*<\/a:t>/, `<a:t>Large deck slide ${index}</a:t>`),
    );
    slides.file(`ppt/slides/_rels/slide${index}.xml.rels`, slideRels);
    types = types.replace(
      '</Types>',
      `<Override PartName="/ppt/slides/slide${index}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`,
    );
    presentation = presentation.replace(
      '</p:sldIdLst>',
      `<p:sldId id="${1000 + index}" r:id="perf${index}"/></p:sldIdLst>`,
    );
    relationships = relationships.replace(
      '</Relationships>',
      `<Relationship Id="perf${index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index}.xml"/></Relationships>`,
    );
  }
  slides.file('[Content_Types].xml', types);
  slides.file('ppt/presentation.xml', presentation);
  slides.file('ppt/_rels/presentation.xml.rels', relationships);
  const fixtures = [
    { name: 'large.md', mimeType: 'text/markdown', buffer: Buffer.from(markdown), ready: 'markdown' },
    {
      name: 'large.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }),
      ready: 'sheet',
    },
    {
      name: 'large.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: await docx.generateAsync({ type: 'nodebuffer' }),
      ready: 'document',
    },
    {
      name: 'sample.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      buffer: await readFile(new URL('./fixtures/documents/follow-ups.pptx', import.meta.url)),
      ready: 'slides',
    },
    {
      name: 'large.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      buffer: await slides.generateAsync({ type: 'nodebuffer' }),
      ready: 'large-slides',
    },
  ];
  browser = await chromium.launch();
  const results = [];
  for (let run = 0; run < 3; run++) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('https://example.test/**', route => route.abort());
    await page.goto(origin);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cdp.send('Performance.enable');
    await page.getByRole('heading', { name: 'Revision 1' }).waitFor();
    assert.equal(await page.locator('[data-slot="message-response"]').getAttribute('aria-busy'), 'true');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    assert.equal(await page.getByLabel('Selected link').textContent(), 'first');
    await page.getByRole('button', { name: 'Change link authority' }).click();
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    assert.equal(await page.getByLabel('Selected link').textContent(), 'second');
    await page.getByRole('button', { name: 'Toggle streaming' }).click();
    assert.equal(await page.locator('[data-slot="message-response"]').getAttribute('aria-busy'), 'false');
    await page.getByRole('button', { name: 'Toggle streaming' }).click();
    await page.getByRole('button', { name: 'Append response' }).click();
    await page.getByRole('heading', { name: 'Revision 2' }).waitFor();
    assert.equal(await page.locator('[data-slot="message-response"]').getAttribute('aria-busy'), 'true');
    assert.equal(
      await page.locator('[data-slot="message-response"] img, [data-slot="message-response"] script').count(),
      0,
    );
    for (const fixture of fixtures) {
      const before = (await cdp.send('Performance.getMetrics')).metrics;
      const started = performance.now();
      await page
        .getByLabel('Local document')
        .setInputFiles({ name: fixture.name, mimeType: fixture.mimeType, buffer: fixture.buffer });
      const dialog = page.getByRole('dialog');
      await page.waitForFunction(kind => {
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog || [...dialog.querySelectorAll('h2')].some(node => node.textContent === 'Opening file'))
          return false;
        if (kind === 'markdown')
          return [...dialog.querySelectorAll('h2')].some(node => node.textContent === 'Document section 200');
        if (kind === 'sheet')
          return [...dialog.querySelectorAll('td')].some(node => node.textContent === 'Row 1000 column 12');
        const text = dialog.querySelector('iframe')?.contentDocument?.body?.textContent;
        if (kind === 'document') return text?.includes('Document paragraph 500.');
        return kind === 'large-slides' ? text?.includes('Large deck slide 49') : text?.toLowerCase().includes('follow');
      }, fixture.ready);
      const openMs = Math.round(performance.now() - started);
      const after = (await cdp.send('Performance.getMetrics')).metrics;
      const delta = name =>
        Math.round(
          1000 * (after.find(metric => metric.name === name).value - before.find(metric => metric.name === name).value),
        );
      const taskMs = delta('TaskDuration');
      const officeMode = fixture.ready.includes('slides')
        ? await page.evaluate(() =>
            document.querySelector('iframe')?.contentDocument?.body?.textContent.includes('Reading view.')
              ? 'text fallback'
              : 'slide renderer',
          )
        : null;
      if (fixture.ready === 'markdown') {
        assert.equal(await dialog.getByRole('table').count(), 200);
        // sprout FileContent (file-viewer.js TextFile) labels the markdown toggle Show source / Show formatted.
        await dialog.getByRole('button', { name: 'Show source', exact: true }).click();
        assert.match(await dialog.locator('pre').textContent(), /## Document section 200/);
        await dialog.getByRole('button', { name: 'Show formatted', exact: true }).click();
        await dialog.getByRole('heading', { name: 'Document section 200', exact: true }).waitFor();
      }
      if (fixture.ready === 'sheet') {
        assert.equal(await dialog.getByRole('row').count(), 1001);
        await dialog.getByText('Showing up to 1,000 rows and 100 columns.', { exact: false }).waitFor();
        const worksheet = dialog.getByRole('region', { name: 'Customers worksheet', exact: true });
        await worksheet.evaluate(element => {
          element.scrollTop = element.scrollHeight;
        });
        assert.equal(
          await worksheet.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight < 2),
          true,
        );
      }
      await dialog.getByRole('button', { name: 'Close file viewer' }).click();
      await dialog.waitFor({ state: 'detached' });
      results.push({
        run,
        file: fixture.name,
        bytes: fixture.buffer.length,
        openMs,
        taskMs,
        scriptMs: delta('ScriptDuration'),
        layoutMs: delta('LayoutDuration'),
        styleMs: delta('RecalcStyleDuration'),
        officeMode,
      });
    }
    for (const [name, content, expected] of [
      ['empty.txt', '', 'This file is empty'],
      ['broken.docx', 'broken', 'Could not open this file'],
    ]) {
      await page.getByLabel('Local document').setInputFiles({ name, mimeType: '', buffer: Buffer.from(content) });
      await page.getByRole('heading', { name: expected }).waitFor();
      await page.getByRole('button', { name: 'Close file viewer' }).click();
    }
    let documentReads = 0;
    await page.route('**/retry.docx', async route => {
      documentReads++;
      await route.fulfill({
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        body: documentReads === 1 ? Buffer.from('broken') : await docx.generateAsync({ type: 'nodebuffer' }),
      });
    });
    await page.getByRole('button', { name: 'Open retry document', exact: true }).click();
    await page.getByRole('heading', { name: 'Could not open this file' }).waitFor();
    assert.equal(documentReads, 1);
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await page
      .frameLocator('iframe[title="retry.docx document"]')
      .getByText('Document paragraph 500.', { exact: false })
      .waitFor();
    await page.getByRole('heading', { name: 'Could not open this file' }).waitFor({ state: 'detached' });
    assert.equal(documentReads, 2, 'Retry reads the document again and renders the restored content');
    await page.getByRole('button', { name: 'Close file viewer' }).click();
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(
    JSON.stringify(
      {
        method:
          'Isolated production fixture build, 4x CPU, local files, 200 markdown sections, 1200x12 spreadsheet bounded to 1000 rows, 500 added DOCX paragraphs, existing PPTX sample and 40 added slides. Animation-frame content readiness includes parsing and rendering, not input generation.',
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
  await rm(outDir, { recursive: true, force: true });
}
