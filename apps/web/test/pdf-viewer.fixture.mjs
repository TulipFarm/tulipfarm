import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { pdf, textStream } from '../../../packages/conversations/test/knowledge-extraction-fixtures.mjs';

export const pdfText = 'TulipFarm PDF evidence';
export const viewerPdf = pdf([textStream(pdfText)]);

export async function assertRenderedPdf(page) {
  let viewer;
  for (let attempt = 0; attempt < 100; attempt++) {
    viewer = page
      .frames()
      .find(frame => frame.url().startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'));
    if (viewer) break;
    await delay(100);
  }
  assert.ok(viewer, 'full Chromium opens its PDF viewer, not a download-only headless shell');
  // PDFium paints outside the DOM; inspect its parsed selection, not the source bytes.
  await viewer.waitForFunction(() => document.querySelector('pdf-viewer')?.loadProgress_ === 100, null, {
    timeout: 10000,
  });
  const text = await viewer.evaluate(async () => {
    const controller = document.querySelector('pdf-viewer').pluginController_;
    controller.selectAll();
    let timer;
    try {
      const selection = await Promise.race([
        controller.getSelectedText(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('PDFium did not return rendered text')), 10000);
        }),
      ]);
      return selection.selectedText;
    } finally {
      clearTimeout(timer);
    }
  });
  assert.equal(text.trim(), pdfText);
  await delay(200);
  await page.getByRole('heading', { name: 'Opening file', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.getByText('The embedded viewer is taking longer than expected.', { exact: true }).count(), 0);
}
