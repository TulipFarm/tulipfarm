import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actorSchema, appActorSchema, humanActorSchema } from '../src/contracts.ts';

const appId = '0B0E7A51-3C5D-4B8E-9F21-6D2A7C4E1F00';
const releaseId = '7F3A9C2E-1B4D-4E6F-8A0B-2C3D4E5F6A7B';
const membershipId = 'C1D2E3F4-A5B6-4C7D-8E9F-0A1B2C3D4E5F';

test('an app actor parses with lowercased ids and an optional authenticated viewer', () => {
  assert.deepEqual(actorSchema.parse({ kind: 'app', appId, releaseId }), {
    kind: 'app',
    appId: '0b0e7a51-3c5d-4b8e-9f21-6d2a7c4e1f00',
    releaseId: '7f3a9c2e-1b4d-4e6f-8a0b-2c3d4e5f6a7b',
  });
  assert.deepEqual(
    actorSchema.parse({ kind: 'app', appId, releaseId, viewer: { kind: 'human', userId: 'user-1', membershipId } }),
    {
      kind: 'app',
      appId: '0b0e7a51-3c5d-4b8e-9f21-6d2a7c4e1f00',
      releaseId: '7f3a9c2e-1b4d-4e6f-8a0b-2c3d4e5f6a7b',
      viewer: { kind: 'human', userId: 'user-1', membershipId: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f' },
    },
  );
});

test('strict actor schemas reject an app posing as a person and kinds they do not name', () => {
  const app = { kind: 'app', appId, releaseId };
  assert.equal(humanActorSchema.safeParse(app).success, false);
  assert.equal(humanActorSchema.safeParse({ ...app, kind: 'human', userId: 'user-1', membershipId }).success, false);
  assert.equal(appActorSchema.safeParse({ ...app, membershipId }).success, false);
  assert.equal(appActorSchema.safeParse({ ...app, viewer: { kind: 'agent', runId: membershipId } }).success, false);
  assert.equal(appActorSchema.safeParse({ kind: 'app', appId }).success, false);
  assert.equal(actorSchema.safeParse({ kind: 'visitor', visitorId: appId }).success, false);
  assert.equal(actorSchema.safeParse({ kind: 'app', appId: 'not-a-uuid', releaseId }).success, false);
});
