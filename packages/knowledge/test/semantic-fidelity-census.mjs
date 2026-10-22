import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { toMarkdownBytes, formatFromExtension } from '@firecrawl/anydoc/index.js';
import { KnowledgeParseError, parseKnowledgeDocument } from '../dist/parser.js';
import { qualification, semanticFidelityFixtures } from './fixtures/semantic-fidelity.mjs';

const require = createRequire(import.meta.url);
const args = new Set(process.argv.slice(2));
assert.ok(
  [...args].every(arg => ['--list', '--assert'].includes(arg)),
  'Usage: node packages/knowledge/test/semantic-fidelity-census.mjs [--list] [--assert]',
);
const fixtures = await semanticFidelityFixtures();
assert.equal(new Set(fixtures.map(fixture => fixture.id)).size, fixtures.length, 'Fixture IDs must be unique');
const fingerprint = {};
for (const name of [
  'convert',
  'office',
  'word',
  'spreadsheet',
  'presentation',
  'opendocument',
  'pdf',
  'rtf',
  'contracts',
  'process',
  'worker',
  'xml',
  'archive',
  'chunks',
]) {
  for (const [kind, extension] of [
    ['src', 'ts'],
    ['dist', 'js'],
  ]) {
    const path = `../${kind}/internal/parser/${name}.${extension}`;
    fingerprint[`${kind}/${name}`] = createHash('sha256')
      .update(await readFile(new URL(path, import.meta.url)))
      .digest('hex');
  }
}
console.log(
  JSON.stringify({
    kind: 'qualification',
    ...qualification,
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    anydoc: require('@firecrawl/anydoc/package.json').version,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    fingerprint,
    command: 'node packages/knowledge/test/semantic-fidelity-census.mjs',
    assertCommand: 'node packages/knowledge/test/semantic-fidelity-census.mjs --assert',
  }),
);

function missingFacts(markdown, expected) {
  if (expected.reject) return ['invalid fixture was accepted'];
  const missing = expected.allOf.filter(alternatives => !alternatives.some(value => markdown.includes(value)));
  const forbidden = expected.noneOf.filter(value => markdown.includes(value));
  return [
    ...missing.map(alternatives => ({ missingOneOf: alternatives })),
    ...forbidden.map(value => ({ forbidden: value })),
  ];
}

function rejection(error, guarded) {
  if (guarded) {
    if (!(error instanceof KnowledgeParseError)) throw error;
    assert.ok(['unsupported', 'malformed', 'ocr-required', 'encrypted', 'resource-limited'].includes(error.code));
    return { status: 'reject', code: error.code, message: error.message };
  }
  if (!(error instanceof Error) || typeof error.code !== 'string') throw error;
  return { status: 'reject', code: error.code, message: error.message };
}

async function measure(action, expected, guarded) {
  let markdown;
  try {
    markdown = await action();
  } catch (error) {
    return rejection(error, guarded);
  }
  assert.equal(typeof markdown, 'string', 'A successful parser must produce actual text');
  const missing = missingFacts(markdown, expected);
  return {
    status: guarded ? (missing.length ? 'acceptedloss' : 'accepted-preserved') : missing.length ? 'loss' : 'preserved',
    markdown,
    missing,
  };
}

const rows = [];
for (const fixture of fixtures) {
  const { build, ...metadata } = fixture;
  if (args.has('--list')) {
    console.log(JSON.stringify({ kind: 'fixture', ...metadata }));
    continue;
  }
  const bytes = Buffer.from(await build());
  assert.ok(bytes.length > 0, `${fixture.id} fixture is empty`);
  const native = await measure(
    () => toMarkdownBytes(bytes, fixture.format === 'csv' ? formatFromExtension('csv') : undefined),
    fixture.expected,
    false,
  );
  const guard = await measure(
    async () =>
      (
        await parseKnowledgeDocument({
          bytes,
          filename: `${fixture.id}.${fixture.format}`,
          mediaType: fixture.format === 'txt' ? 'text/plain' : 'application/octet-stream',
        })
      ).markdown,
    fixture.expected,
    true,
  );
  const row = {
    kind: 'case',
    ...metadata,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    native,
    guard,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}

if (!args.has('--list')) {
  const tally = selected => ({
    cases: selected.length,
    native: Object.fromEntries(
      ['preserved', 'loss', 'reject'].map(status => [
        status,
        selected.filter(row => row.native.status === status).length,
      ]),
    ),
    guard: Object.fromEntries(
      ['accepted-preserved', 'acceptedloss', 'reject'].map(status => [
        status,
        selected.filter(row => row.guard.status === status).length,
      ]),
    ),
  });
  const valid = rows.filter(row => row.validity === 'valid-minimal');
  const losses = valid.filter(row => row.guard.status === 'acceptedloss').map(row => row.id);
  const rejectedControls = rows
    .filter(row => row.mustAccept && row.guard.status !== 'accepted-preserved')
    .map(row => row.id);
  console.log(
    JSON.stringify({
      kind: 'summary',
      ...tally(rows),
      valid: tally(valid),
      invalid: tally(rows.filter(row => row.validity !== 'valid-minimal')),
      byFormat: Object.fromEntries(
        [...new Set(rows.map(row => row.format))].map(format => [
          format,
          tally(rows.filter(row => row.format === format)),
        ]),
      ),
      acceptedLossClasses: losses,
      policySensitiveLossClasses: valid
        .filter(
          row =>
            row.guard.status === 'acceptedloss' && row.interpretation === 'explicit review-history or emphasis policy',
        )
        .map(row => row.id),
      rejectedControls,
      unexpectedTableRejections: rows.filter(row => row.guard.code === 'resource-limited').map(row => row.id),
      verdict: losses.length ? 'premise falsified' : 'no accepted loss observed in this corpus',
    }),
  );
  if (args.has('--assert')) {
    assert.deepEqual(
      rejectedControls,
      [],
      'Ordinary format controls must remain accepted and preserve their declared facts',
    );
    assert.deepEqual(
      rows
        .filter(row => row.guard.status === 'acceptedloss' || row.guard.code === 'resource-limited')
        .map(row => row.id),
      [],
      'Guard must preserve each declared fact or explicitly reject, without counting infrastructure/resource failures as semantic protection',
    );
  }
}
