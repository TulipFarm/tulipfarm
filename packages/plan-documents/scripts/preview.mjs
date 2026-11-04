// Writes a sample plan document as HTML without drawing diagrams: each diagram slot shows its Mermaid source.
// Run after `pnpm build`: node scripts/preview.mjs [output.html]
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { escapeHtml, planDocumentDiagrams, renderPlanDocumentHtml } from '../dist/index.js';
import { model, stamp, timeZone } from './sample.mjs';

const output = process.argv[2] ?? fileURLToPath(new URL('../dist/plan-document-sample.html', import.meta.url));
const source = text => `<pre>${escapeHtml(text)}</pre>`;
const html = renderPlanDocumentHtml(model, {
  diagramSvgs: Object.fromEntries(planDocumentDiagrams(model).map(diagram => [diagram.key, source(diagram.source)])),
  stamp,
  timeZone,
});
await writeFile(output, html);
console.log(`Wrote ${output}`);
