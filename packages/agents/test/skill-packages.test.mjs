import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildSkillPackage,
  readSkillDocument,
  skillDefinitionRevision,
  verifySkillPackage,
} from '../src/skill-packages.ts';
import { skillPackageLimits, skillPathSchema } from '../src/skill-package-contracts.ts';

const document = (
  frontmatter = 'name: sample-skill\ndescription: Do a repeatable task',
  body = 'Read references when needed.',
) => Buffer.from(`---\n${frontmatter}\n---\n${body}\n`);
const sample = () => [
  { path: 'SKILL.md', bytes: document() },
  { path: 'assets/data.bin', bytes: Uint8Array.of(0, 128, 255, 10) },
];

test('package digests preserve binary bytes, ordering, metadata, and local files', () => {
  const first = buildSkillPackage(sample());
  const second = buildSkillPackage(sample().reverse());
  assert.deepEqual(first, second);
  assert.equal(first.definition.package.manifest.format, 1);
  assert.deepEqual([...first.files[1].bytes], [0, 128, 255, 10]);
  assert.deepEqual(verifySkillPackage(first.definition.package, first.files), first);
  const changed = sample();
  changed[1].bytes[0] = 1;
  assert.throws(() => verifySkillPackage(first.definition.package, changed), /package-mismatch/);
  assert.notEqual(buildSkillPackage(changed).definition.package.digest, first.definition.package.digest);
});

test('package input is copied and unsafe paths or ambiguous manifests are rejected', () => {
  const files = sample(),
    built = buildSkillPackage(files);
  files[1].bytes[0] = 17;
  assert.equal(built.files[1].bytes[0], 0);
  for (const path of [
    '/file',
    '../file',
    './file',
    'a/../b',
    'a//b',
    'C:/b',
    'a\\b',
    '.git/config',
    'node_modules/a',
    'a\0b',
    'a.',
    'a ',
    `${'a/'.repeat(8)}b`,
  ]) {
    assert.equal(skillPathSchema.safeParse(path).success, false, path);
  }
  for (const path of ['SKILL.md', 'skill.md', 'assets', 'assets/data.bin']) {
    assert.throws(() => buildSkillPackage([...sample(), { path, bytes: Buffer.from('duplicate') }]));
  }
});

test('frontmatter requires standard metadata and rejects malformed YAML and expansion', () => {
  assert.equal(
    readSkillDocument(document('name: sample-skill\ndescription: |\n  A useful task\n  with context')).metadata
      .description,
    'A useful task\nwith context',
  );
  assert.throws(() => readSkillDocument(document(), 'wrong-folder'));
  for (const metadata of [
    'name: Uppercase\ndescription: text',
    'name: double--hyphen\ndescription: text',
    'name: sample-skill',
    'name: sample-skill\ndescription: one\ndescription: two',
    'name: &name sample-skill\ndescription: *name',
    'name: sample-skill\ndescription: !!unknown text',
    'name: sample-skill\ndescription: text\nmetadata:\n  score: 123',
  ])
    assert.throws(() => readSkillDocument(document(metadata)), metadata);
  assert.throws(() => readSkillDocument(Uint8Array.of(255, 254)));
  assert.throws(() => readSkillDocument(Buffer.from('Not a skill package')));
});

test('exact package bounds are enforced without dropping files', () => {
  const files = [{ path: 'SKILL.md', bytes: document() }];
  for (let i = 1; i < skillPackageLimits.files; i++) files.push({ path: `assets/${i}.txt`, bytes: Buffer.alloc(0) });
  assert.equal(buildSkillPackage(files).files.length, 256);
  assert.throws(() => buildSkillPackage([...files, { path: 'extra', bytes: Buffer.alloc(0) }]), /package-limit/);
  const skill = document();
  const exact = [
    { path: 'SKILL.md', bytes: skill },
    { path: 'assets/blob', bytes: Buffer.alloc(skillPackageLimits.bytes - skill.length) },
  ];
  assert.equal(buildSkillPackage(exact).files.length, 2);
  exact[1].bytes = Buffer.alloc(skillPackageLimits.bytes - skill.length + 1);
  assert.throws(() => buildSkillPackage(exact), /package-limit/);
});

test('legacy definition hashes remain canonical and unchanged', () => {
  assert.equal(
    skillDefinitionRevision({ name: 'Example', instructions: 'Do the task.' }),
    skillDefinitionRevision({ instructions: 'Do the task.', name: 'Example' }),
  );
});
