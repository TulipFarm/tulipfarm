// Joins apps/*.json into src/generated/catalog.json, sorted by id, and writes the JSON Schema.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { appJsonSchema } from '../src/schema.ts';

const root = new URL('../', import.meta.url);
const folder = new URL('apps/', root);
const apps = readdirSync(folder)
  .filter(file => file.endsWith('.json'))
  .sort()
  .map(file => {
    const { $schema: _, ...app } = JSON.parse(readFileSync(new URL(file, folder), 'utf8'));
    return app;
  });
mkdirSync(new URL('src/generated/', root), { recursive: true });
writeFileSync(new URL('src/generated/catalog.json', root), `${JSON.stringify(apps)}\n`);
writeFileSync(new URL('schemas/app.v1.json', root), `${JSON.stringify(appJsonSchema(), null, 2)}\n`);
