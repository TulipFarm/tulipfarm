import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccessDenied, SourceAuthorizationUnavailable } from '@tulipfarm/access';
import { requireReadableFile } from '../dist/index.js';
import { visibleSkillFiles } from '../dist/skill-sources.js';

const actor = { kind: 'human', userId: 'owner', membershipId: '00000000-0000-4000-8000-000000000001' };
const file = {
  id: '00000000-0000-4000-8000-000000000002',
  kind: 'file',
  creator_membership_id: actor.membershipId,
  parent_id: null,
  name: 'Private.txt',
  trashed_at: null,
  created_at: new Date(0),
  object_key: '00000000-0000-4000-8000-000000000003',
  media_type: 'text/plain',
  size: 7,
  sha256: 'a'.repeat(64),
  ready: true,
};
function transaction({ chain = [file], level = 3, member = true, role = 'member', installed = true, sources } = {}) {
  return {
    schema: 'workspace',
    client: {
      query: async (sql, args) => {
        let rows;
        if (sql === 'SELECT to_regclass($1) IS NOT NULL AS installed') {
          assert.deepEqual(args, ['"workspace"."tf_file_skill_sources"']);
          rows = [{ installed }];
        } else if (sql.includes('SELECT sources FROM "workspace"."tf_file_skill_sources"')) {
          assert.equal(installed, true);
          assert.deepEqual(args, [file.id]);
          rows = sources ? [{ sources }] : [];
        } else if (sql.includes('removed_at IS NULL')) {
          assert.deepEqual(args, [actor.membershipId, actor.userId]);
          rows = member ? [{ id: actor.membershipId, user_id: actor.userId, role }] : [];
        } else if (sql.includes('SELECT * FROM ancestors')) rows = chain;
        else if (sql.includes('END AS level')) rows = [{ level }];
        else throw new Error(`Unexpected query ${sql}`);
        return { rows, rowCount: rows.length };
      },
    },
  };
}

test('readable file returns only an immutable content identity, without a storage key, for an authorized viewer', async () => {
  const reference = await requireReadableFile(transaction({ level: 1 }), actor, file.id);
  assert.deepEqual(
    reference,
    { id: file.id, sha256: 'a'.repeat(64), size: 7 },
    'no object key: since 0110 a key alone does not locate the bytes',
  );
  assert.equal(Object.isFrozen(reference), true);
  assert.throws(() => {
    reference.size = 99;
  }, TypeError);
});

test('readable file denies removed members and ungranted admins', async () => {
  await assert.rejects(requireReadableFile(transaction({ member: false }), actor, file.id), AccessDenied);
  await assert.rejects(requireReadableFile(transaction({ role: 'admin', level: 0 }), actor, file.id), AccessDenied);
});

test('readable file preserves pre-package workspaces and checks generated-file sources', async () => {
  const expected = { id: file.id, sha256: file.sha256, size: file.size };
  assert.deepEqual(await requireReadableFile(transaction({ installed: false }), actor, file.id), expected);
  assert.deepEqual(
    await requireReadableFile(
      transaction({ sources: [{ kind: 'public-web', url: 'https://example.com/skill' }] }),
      actor,
      file.id,
    ),
    expected,
  );
  for (const kind of ['unknown', 'unavailable']) {
    await assert.rejects(requireReadableFile(transaction({ sources: [{ kind }] }), actor, file.id), AccessDenied);
  }
});

test('readable file denies missing, unready, trashed and non-file entries or incomplete content references', async () => {
  for (const chain of [
    [],
    ...[
      { ready: false },
      { trashed_at: new Date() },
      { kind: 'folder' },
      { object_key: null },
      { sha256: null },
      { size: null },
    ].map(change => [{ ...file, ...change }]),
    [file, { ...file, id: '00000000-0000-4000-8000-000000000004', trashed_at: new Date() }],
  ]) {
    await assert.rejects(requireReadableFile(transaction({ chain }), actor, file.id), AccessDenied);
  }
});

test('Files listing hides denied sources but surfaces temporary authorization failures', async () => {
  assert.deepEqual(await visibleSkillFiles(transaction(), actor, [file], requireReadableFile), [file]);
  assert.deepEqual(
    await visibleSkillFiles(transaction({ sources: [{ kind: 'unknown' }] }), actor, [file], requireReadableFile),
    [],
  );
  for (const error of [new SourceAuthorizationUnavailable(), new Error('source-lookup-failed')]) {
    const tx = {
      schema: 'workspace',
      client: {
        query: async () => {
          throw error;
        },
      },
    };
    await assert.rejects(visibleSkillFiles(tx, actor, [file], requireReadableFile), caught => caught === error);
  }
});
