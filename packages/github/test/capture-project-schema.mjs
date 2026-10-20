import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { buildSchema } from 'graphql';

const url = 'https://docs.github.com/public/fpt/schema.docs.graphql';
const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
assert.equal(response.status, 200);
const text = await response.text();
assert.ok(buildSchema(text).getType('UpdateProjectV2FieldInput'));
await writeFile(new URL('./project-schema.graphql.gz', import.meta.url), gzipSync(text));
await writeFile(
  new URL('./project-schema.json', import.meta.url),
  JSON.stringify(
    { url, checkedAt: new Date().toISOString(), sha256: createHash('sha256').update(text).digest('hex') },
    null,
    2,
  ) + '\n',
);
