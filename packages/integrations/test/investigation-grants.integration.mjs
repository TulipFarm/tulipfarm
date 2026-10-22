import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { canAccessAsset, lockAuthorization } from '@tulipfarm/access';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { fixture } from './fixture.mjs';

test('team investigation grants preserve issue-only access and require explicit capability grants', async () => {
  const f = await fixture();
  try {
    await f.service.create(f.workspaceId, f.creator, f.input);
    const sourceId = f.input.repositories[0].id;
    const base = {
      grants: [{ teamId: f.teamId, permissions: ['read', 'use'] }],
      sourceGrants: [{ teamId: f.teamId, sourceId }],
    };
    await f.service.setGrants(f.workspaceId, f.creator, f.input.id, { ...base, expectedGrantsVersion: 1 });
    const allowed = (actor, permission) =>
      f.runtime.transaction(f.workspaceId, commonCompatibility, async tx => {
        await lockAuthorization(tx);
        return canAccessAsset(tx, actor, sourceId, permission);
      });
    assert.equal(await allowed(f.member, 'github.issue.read'), true);
    for (const permission of ['github.code.read', 'github.issues.read', 'github.actions.read'])
      assert.equal(await allowed(f.member, permission), false);

    const investigationGrants = [
      { teamId: f.teamId, sourceId, permissions: ['github.code.read', 'github.pulls.read'] },
    ];
    const granted = await f.service.setGrants(f.workspaceId, f.creator, f.input.id, {
      ...base,
      expectedGrantsVersion: 2,
      investigationGrants,
    });
    assert.deepEqual(granted.investigationGrants, investigationGrants);
    assert.deepEqual(granted.sourceGrants, base.sourceGrants);
    assert.equal(await allowed(f.member, 'github.code.read'), true);
    assert.equal(await allowed(f.member, 'github.pulls.read'), true);
    assert.equal(await allowed(f.member, 'github.actions.read'), false);
    assert.equal(await allowed(f.actor, 'github.code.read'), false, 'workspace admin has no implicit access');
    assert.equal((await f.service.readIssue(f.workspaceId, f.member, f.request())).number, 17);

    const legacyEdit = await f.service.setGrants(f.workspaceId, f.creator, f.input.id, {
      ...base,
      expectedGrantsVersion: 3,
      sourceGrants: [],
    });
    assert.deepEqual(legacyEdit.investigationGrants, investigationGrants, 'omitted new fields preserve new grants');
    assert.equal(await allowed(f.member, 'github.issue.read'), false);
    assert.equal(await allowed(f.member, 'github.code.read'), true);
    await assert.rejects(f.service.readIssue(f.workspaceId, f.member, f.request()), /not found/);

    await f.service.setGrants(f.workspaceId, f.creator, f.input.id, {
      ...base,
      sourceGrants: [],
      expectedGrantsVersion: 4,
      investigationGrants: [],
    });
    assert.equal(await allowed(f.member, 'github.code.read'), false);
    assert.equal(await allowed(f.member, 'github.pulls.read'), false);
  } finally {
    await f.close();
  }
});

test('person investigation grants validate recipients and sources, preserve legacy edits and reject stale updates', async () => {
  const f = await fixture();
  try {
    await f.service.create(f.workspaceId, f.creator, f.input);
    const sourceId = f.input.repositories[0].id;
    const policy = {
      expectedGrantsVersion: 1,
      grants: [],
      sourceGrants: [],
      investigationPersonGrants: [{ memberId: f.member.membershipId, sourceId, permissions: ['github.actions.read'] }],
    };
    await assert.rejects(f.service.setGrants(f.workspaceId, f.member, f.input.id, policy), /not found/);
    await assert.rejects(
      f.service.setGrants(f.workspaceId, f.creator, f.input.id, {
        ...policy,
        investigationPersonGrants: [{ ...policy.investigationPersonGrants[0], sourceId: randomUUID() }],
      }),
      /not found/,
    );
    await assert.rejects(
      f.service.setGrants(f.workspaceId, f.creator, f.input.id, {
        ...policy,
        investigationPersonGrants: [{ ...policy.investigationPersonGrants[0], memberId: randomUUID() }],
      }),
      /not found/,
    );
    const result = await f.service.setGrants(f.workspaceId, f.creator, f.input.id, policy);
    assert.deepEqual(result.investigationPersonGrants, policy.investigationPersonGrants);
    assert.equal(result.grantsVersion, 2);
    await assert.rejects(f.service.setGrants(f.workspaceId, f.creator, f.input.id, policy), /conflict/);
    const preserved = await f.service.setGrants(f.workspaceId, f.creator, f.input.id, {
      ...policy,
      expectedGrantsVersion: 2,
      investigationPersonGrants: undefined,
      sourcePersonGrants: [],
    });
    assert.deepEqual(preserved.investigationPersonGrants, policy.investigationPersonGrants);
    const cleared = await f.service.setGrants(f.workspaceId, f.creator, f.input.id, {
      ...policy,
      expectedGrantsVersion: 3,
      investigationPersonGrants: [],
    });
    assert.equal(cleared.investigationPersonGrants, undefined);
  } finally {
    await f.close();
  }
});
