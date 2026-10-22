import assert from 'node:assert/strict';
import { test } from 'node:test';
import { githubReadSchema } from '../src/github-read.ts';
import { githubInvestigationPermissions, githubInvestigationPermissionSchema } from '../src/github-investigation.ts';

test('every GitHub read has explicit investigation permissions or rejects non-repository projects', () => {
  for (const schema of githubReadSchema.options) {
    const kindSchema = schema.shape.kind;
    const kinds = kindSchema.options ?? [kindSchema.value];
    for (const kind of kinds) {
      if (kind.startsWith('project.')) {
        assert.throws(() => githubInvestigationPermissions({ kind }), /beyond repository investigation grants/);
        continue;
      }
      const permissions = githubInvestigationPermissions({ kind });
      assert.ok(permissions.length > 0, kind);
      assert.equal(new Set(permissions).size, permissions.length, kind);
      for (const permission of permissions)
        assert.equal(githubInvestigationPermissionSchema.safeParse(permission).success, true, kind);
      assert.equal(
        permissions.includes('github.issue.read'),
        false,
        'legacy issue access never grants investigation access',
      );
    }
  }
});

test('diffs and review snippets require code access; check results require Actions access', () => {
  for (const kind of ['pull.diff', 'pull.files', 'pull.commits', 'pull.review-comments']) {
    assert.deepEqual(githubInvestigationPermissions({ kind }), ['github.pulls.read', 'github.code.read']);
  }
  for (const kind of ['pull.checks', 'pull.status']) {
    assert.deepEqual(githubInvestigationPermissions({ kind }), ['github.pulls.read', 'github.actions.read']);
  }
  assert.deepEqual(githubInvestigationPermissions({ kind: 'issue.read' }), ['github.issues.read']);
  assert.deepEqual(githubInvestigationPermissions({ kind: 'actions.logs' }), ['github.actions.read']);
});
