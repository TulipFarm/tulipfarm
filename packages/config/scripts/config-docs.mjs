// Writes the documents generated from packages/config/src/settings.ts and the model catalog JSON Schema.
// --check exits non-zero instead of writing when a document is stale.
// The configuration reference lives in the docs site repository.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { modelCatalogJsonSchema } from '../src/model-catalog-file.ts';
import { renderEnvExample } from '../src/settings-docs.ts';

const root = new URL('../../../', import.meta.url);
const targets = [
  [new URL('self-host/.env.example', root), () => renderEnvExample()],
  [
    new URL('packages/config/schemas/model-catalog.v1.json', root),
    () => `${JSON.stringify(modelCatalogJsonSchema(), null, 2)}\n`,
  ],
];
const check = process.argv.includes('--check');
const stale = [];
for (const [file, render] of targets) {
  const expected = render();
  if (existsSync(file) && readFileSync(file, 'utf8') === expected) continue;
  stale.push(file.pathname.slice(root.pathname.length));
  if (!check) writeFileSync(file, expected);
}
if (check && stale.length) {
  process.stderr.write(`Stale generated configuration documents: ${stale.join(', ')}. Run pnpm config:docs.\n`);
  process.exitCode = 1;
} else if (!check)
  process.stdout.write(stale.length ? `Updated ${stale.join(', ')}\n` : 'Configuration documents are current\n');
