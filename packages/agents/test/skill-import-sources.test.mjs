import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSkillSourceReader, discoverSkillFiles, resolveSkillSource } from '../src/skill-import-sources.ts';
import { inspectSkillFiles, reviewSkillPackage } from '../src/skill-package-review.ts';
import { buildSkillPackage } from '../src/skill-packages.ts';

const markdown = name => Buffer.from(`---\nname: ${name}\ndescription: Repeat a task\n---\nUse the task steps.`);
test('source resolution preserves GitHub ref/path and skills.sh hints', () => {
  assert.deepEqual(resolveSkillSource('owner/repo'), { kind: 'github', repository: 'owner/repo', tail: [] });
  assert.deepEqual(resolveSkillSource('https://skills.sh/owner/repo/a-skill'), {
    kind: 'github',
    repository: 'owner/repo',
    tail: [],
    hint: 'a-skill',
  });
  assert.deepEqual(resolveSkillSource('https://github.com/owner/repo/tree/feature/topic/skills/a-skill'), {
    kind: 'github',
    repository: 'owner/repo',
    tail: ['feature', 'topic', 'skills', 'a-skill'],
  });
  assert.deepEqual(resolveSkillSource('https://raw.githubusercontent.com/owner/repo/main/skills/a-skill/SKILL.md#v1'), {
    kind: 'github',
    repository: 'owner/repo',
    tail: ['main', 'skills', 'a-skill', 'SKILL.md'],
    ref: 'v1',
  });
  for (const input of [
    'file:///etc/passwd',
    'http://example.com/SKILL.md',
    'https://me:secret@example.com/SKILL.md',
    'https://github.com/a/b/issues/42',
    'https://skills.sh/a/b',
    'https://127.0.0.1/SKILL.md',
    'https://example.com/a?token=secret',
  ])
    assert.throws(() => resolveSkillSource(input));
});
test('discovery separates nested packages and requires the exact directory', () => {
  const files = [
    { path: 'parent-skill/SKILL.md', bytes: markdown('parent-skill') },
    { path: 'parent-skill/child-skill/SKILL.md', bytes: markdown('child-skill') },
    { path: 'parent-skill/child-skill/data', bytes: Buffer.from('child') },
  ];
  const source = {
    submittedUrl: 'https://example.com/a.zip',
    canonicalUrl: 'https://example.com/a.zip',
    digest: 'a'.repeat(64),
  };
  const all = discoverSkillFiles(files, source);
  assert.equal(all.length, 2);
  assert.equal(all[0].files.length, 1);
  assert.equal(all[1].files.length, 2);
  assert.equal(discoverSkillFiles(files, source, 'parent-skill/child-skill')[0].definition.name, 'child-skill');
  assert.throws(() => discoverSkillFiles(files, source, 'child-skill'), /no-skills/);
});
test('websites offer published links or chat creation, never silently convert a page', async () => {
  const responses = new Map([
    ['https://example.com/page', { mediaType: 'text/html', bytes: Buffer.from('<h1>How to do a task</h1>') }],
    [
      'https://example.com/links',
      {
        mediaType: 'text/html',
        bytes: Buffer.from(
          '<a href="/one.skill">One</a><a href="https://github.com/a/b">Two</a><a href="javascript:bad()">No</a>',
        ),
      },
    ],
    ['https://example.com/SKILL.md', { mediaType: 'text/plain', bytes: markdown('a-skill') }],
  ]);
  const read = createSkillSourceReader(async url => ({ url, status: 200, ...responses.get(url) }));
  assert.deepEqual(await read('https://example.com/page'), { kind: 'page', url: 'https://example.com/page' });
  assert.deepEqual(await read('https://example.com/links'), {
    kind: 'links',
    links: ['https://example.com/one.skill', 'https://github.com/a/b'],
  });
  assert.equal((await read('https://example.com/SKILL.md')).skills[0].definition.name, 'a-skill');
});
test('GitHub downloads pin every package file to one commit and resolve slash refs', async () => {
  const sha = 'a'.repeat(40),
    treeSha = 'b'.repeat(40),
    visited = [];
  const body = markdown('a-skill');
  const read = createSkillSourceReader(async url => {
    visited.push(url);
    const base = { url, status: 200, mediaType: 'application/json' };
    if (url.endsWith('/commits/feature%2Ftopic'))
      return { ...base, bytes: Buffer.from(JSON.stringify({ sha, commit: { tree: { sha: treeSha } } })) };
    if (url.includes('/commits/')) return { ...base, status: 404, bytes: Buffer.from('{}') };
    if (url.includes('/git/trees/'))
      return {
        ...base,
        bytes: Buffer.from(
          JSON.stringify({
            truncated: false,
            tree: [
              { path: 'skills/a-skill/SKILL.md', mode: '100644', type: 'blob', sha: 'c'.repeat(40), size: body.length },
            ],
          }),
        ),
      };
    assert.equal(url, `https://raw.githubusercontent.com/a/b/${sha}/skills/a-skill/SKILL.md`);
    return { ...base, bytes: body };
  });
  const result = await read('https://github.com/a/b/tree/feature/topic/skills/a-skill');
  assert.equal(result.skills[0].source.commit, sha);
  assert.equal(result.skills[0].path, 'skills/a-skill');
  assert.ok(visited.every(url => !url.includes('raw.githubusercontent.com/a/b/feature')));
});
test('runtime restrictions and unreviewed files remain visible alongside AI review', async () => {
  const files = [
    { path: 'SKILL.md', bytes: markdown('a-skill') },
    { path: 'scripts/task.py', bytes: Buffer.from('import requests\nrequests.get("https://example.com")') },
    { path: 'assets/data', bytes: Buffer.from([255, 254]) },
  ];
  const unavailable = inspectSkillFiles(files, false);
  assert.ok(unavailable.findings.some(finding => finding.severity === 'blocked'));
  assert.deepEqual(unavailable.unreviewedFiles, ['assets/data']);
  const pkg = buildSkillPackage(files).definition.package;
  const reviewed = await reviewSkillPackage(
    'review',
    pkg,
    files,
    async () => ({ summary: 'Network use needs an approved tool.', findings: [] }),
    true,
  );
  assert.ok(reviewed.report.deterministic.some(finding => finding.severity === 'high'));
  assert.equal(reviewed.report.packageDigest, pkg.digest);
});

test('incomplete standalone packages report missing resources with exact evidence', () => {
  const files = [
    {
      path: 'SKILL.md',
      bytes: Buffer.from(
        '---\nname: incomplete\ndescription: Incomplete package\n---\nRead [the guide](references/missing.md) and run `scripts/report.py`.',
      ),
    },
  ];
  const { findings } = inspectSkillFiles(files, true);
  assert.equal(findings.length, 2);
  assert.ok(
    findings.every(finding => finding.severity === 'blocked' && finding.path === 'SKILL.md' && finding.line === 5),
  );
  assert.match(findings[0].message, /references\/missing.md/);
  assert.match(findings[1].message, /scripts\/report.py/);
});

test('source failures distinguish rate limits, missing sources, and malformed fragments', async () => {
  for (const [status, content, error] of [
    [429, '', 'source-rate-limit'],
    [403, 'API rate limit exceeded', 'source-rate-limit'],
    [503, '', 'source-unavailable'],
  ]) {
    const read = createSkillSourceReader(async url => ({
      url,
      status,
      mediaType: 'text/plain',
      bytes: Buffer.from(content),
    }));
    await assert.rejects(read('https://example.com/SKILL.md'), new RegExp(error));
  }
  assert.throws(() => resolveSkillSource('https://github.com/a/b#%ZZ'), /source-unsupported/);
  assert.throws(() => resolveSkillSource('https://github.com/a/b/tree/%ZZ'), /source-unsupported/);
});
