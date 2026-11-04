// Draws and prints the sample plan document with a local Chromium, without Temporal or object storage.
// Run after `pnpm build`: node scripts/smoke.mjs [output.pdf]
// Set CHROMIUM_EXECUTABLE_PATH to use a Chrome or Chromium other than Playwright's own.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { model, stamp, timeZone } from '../../../packages/plan-documents/scripts/sample.mjs';
import { renderDocument } from '../dist/activities.js';
import { createRenderer } from '../dist/render.js';

const output = process.argv[2] ?? fileURLToPath(new URL('../dist/plan-document-sample.pdf', import.meta.url));
const renderer = await createRenderer({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
try {
  const drawn = await renderDocument(renderer, {
    workspaceId: '00000000-0000-4000-8000-000000000000',
    model,
    stamp,
    timeZone,
  });
  await writeFile(output, drawn.pdf);
  await writeFile(output.replace(/\.pdf$/, '') + '.html', drawn.html);
  console.log(`Wrote ${output} (${drawn.pdf.byteLength} bytes)`);
  if (drawn.undrawn.length) {
    console.error(`Diagrams not drawn: ${drawn.undrawn.join(', ')}`);
    process.exitCode = 1;
  }
} finally {
  await renderer.close();
}
