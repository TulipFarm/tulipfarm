import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('agent contracts load and parse Google calls without server modules or browser Buffer', () => {
  const entry = new URL('../src/contracts.ts', import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      ...process.execArgv,
      '--input-type=module',
      '--eval',
      `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (specifier.startsWith('node:') || specifier === 'pg' || specifier === '@tulipfarm/access' || specifier.startsWith('@tulipfarm/workspace-storage')) throw new Error('server module reached browser contracts: ' + specifier);
      return next(specifier, context);
    } });
    globalThis.Buffer = undefined;
    const { toolCallSchema } = await import(${JSON.stringify(entry)});
    const read = toolCallSchema.parse({ tool: 'google.read', operation: { kind: 'docs.documents.get', documentId: 'private-doc' } });
    const upload = contentBase64 => ({ tool: 'google.propose', operation: { kind: 'drive.files.upload', mimeType: 'text/plain', contentBase64 } });
    process.stdout.write(JSON.stringify({ read, valid: ['', 'Zg==', 'Zm8=', 'Zm9v', 'AAAA'.repeat(349525) + 'AA=='].map(value => toolCallSchema.safeParse(upload(value)).success), invalid: ['Zh==', 'Zm9=', 'Zg', 'Zm8==', '!!!!', 'AAAA'.repeat(349525) + 'AAA='].map(value => toolCallSchema.safeParse(upload(value)).success) }));
  `,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    read: { tool: 'google.read', operation: { kind: 'docs.documents.get', documentId: 'private-doc' } },
    valid: [true, true, true, true, true],
    invalid: [false, false, false, false, false, false],
  });
});
