import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tableDefinitionJsonSchema, tableDocumentJsonSchema } from '../src/json-schema.ts';

const root = new URL('../../../', import.meta.url);
const targets = [
  ['packages/tables/schemas/table.v1.json', tableDefinitionJsonSchema],
  ['packages/tables/schemas/soul-table.v1.json', tableDocumentJsonSchema],
];
const check = process.argv.includes('--check');
const stale = [];
for (const [path, render] of targets) {
  const file = new URL(path, root);
  const expected = `${JSON.stringify(render(), null, 2)}\n`;
  if (existsSync(file) && readFileSync(file, 'utf8') === expected) continue;
  stale.push(path);
  if (!check) {
    mkdirSync(dirname(file.pathname), { recursive: true });
    writeFileSync(file, expected);
  }
}
if (check && stale.length) {
  process.stderr.write(`Stale generated table schemas: ${stale.join(', ')}. Run pnpm tables:schemas.\n`);
  process.exitCode = 1;
} else if (!check) {
  process.stdout.write(stale.length ? `Updated ${stale.join(', ')}\n` : 'Table schemas are current\n');
}
