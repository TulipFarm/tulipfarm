import assert from 'node:assert/strict';
import { test } from 'node:test';
import { marketplacePackage, marketplacePackagesInPrompt } from '../src/package-links.ts';

const page = 'https://packages.tulipfarm.ai/packages/leave-management/1.0.0';
const link = { name: 'leave-management', version: '1.0.0', url: `${page}/package.json` };

test('package pages and definitions resolve to the same exact version', () => {
  for (const suffix of ['', '/', '/package.json', '/?source=chat#readme'])
    assert.deepEqual(marketplacePackage(`${page}${suffix}`), link);
  assert.deepEqual(marketplacePackage(page.replace('1.0.0', '2.0.0-rc.1+build.2')), {
    name: link.name,
    version: '2.0.0-rc.1+build.2',
    url: `${page.replace('1.0.0', '2.0.0-rc.1+build.2')}/package.json`,
  });
});

test('only versioned marketplace URLs are accepted', () => {
  for (const input of [
    'not a URL',
    '/packages/leave-management/1.0.0/',
    'https://packages.tulipfarm.ai/',
    'https://packages.tulipfarm.ai/catalog.json',
    page.replace('https:', 'http:'),
    page.replace('packages.tulipfarm.ai', 'packages.tulipfarm.ai.example.test'),
    page.replace('packages.tulipfarm.ai', 'packages.tulipfarm.ai@evil.example'),
    page.replace('packages.tulipfarm.ai', 'user:password@packages.tulipfarm.ai'),
    page.replace('packages.tulipfarm.ai', 'packages.tulipfarm.ai:8443'),
    page.replace('1.0.0', 'latest'),
    `${page}/readme`,
  ]) {
    assert.equal(marketplacePackage(input), null, input);
    assert.deepEqual(marketplacePackagesInPrompt(`Inspect ${input}`), [], input);
  }
});

test('prompt extraction handles Markdown, deduplicates links, and retains distinct versions', () => {
  assert.deepEqual(
    marketplacePackagesInPrompt(
      `Compare [this package](${page}/), \`${link.url}\`, and <${page.replace('1.0.0', '1.1.0')}/>!`,
    ),
    [link, { ...link, version: '1.1.0', url: link.url.replace('1.0.0', '1.1.0') }],
  );
  assert.deepEqual(marketplacePackagesInPrompt(`Inspect ${page.replace('https:', 'HTTPS:')}.`), [link]);
});
