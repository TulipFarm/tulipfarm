import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reservedWorkspaceSlugs, suggestWorkspaceSlug, workspaceSlugError } from '../src/lib/workspace-slug.ts';

test('accepts custom workspace URLs', () => {
  for (const slug of ['acme', 'acme-123', '123', 'a'.repeat(48)]) {
    assert.equal(workspaceSlugError(slug), undefined);
  }
});

test('reserves application paths, including mixed-case spellings', () => {
  for (const slug of reservedWorkspaceSlugs) {
    assert.match(workspaceSlugError(slug) ?? '', /reserved/);
    assert.match(workspaceSlugError(slug.toUpperCase()) ?? '', /reserved/);
  }
});

test('rejects ambiguous or malformed path segments', () => {
  for (const slug of [
    '',
    'ab',
    'a'.repeat(49),
    'Acme',
    '-acme',
    'acme-',
    'acme--inc',
    'acme/inc',
    'acme inc',
    'acme_inc',
    'café',
    'foo?bar',
    'foo%2fbar',
    '../foo',
  ]) {
    assert.ok(workspaceSlugError(slug), slug);
  }
});

test('suggests editable URLs from names', () => {
  assert.equal(suggestWorkspaceSlug('  Café & Company, Inc. '), 'cafe-company-inc');
  assert.equal(suggestWorkspaceSlug('Acme 123'), 'acme-123');
  assert.equal(suggestWorkspaceSlug('---'), '');
  assert.equal(suggestWorkspaceSlug('a'.repeat(47) + ' Company'), 'a'.repeat(47));
});
