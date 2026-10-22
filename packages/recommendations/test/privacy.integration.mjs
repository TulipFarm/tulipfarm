import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { resolveHuman } from '@tulipfarm/access';
import { createFiles } from '@tulipfarm/files';
import { createProjects } from '@tulipfarm/conversations/projects';
import { recordRecommendationChange, recommendationCompatibility } from '@tulipfarm/workspace-storage/recommendations';
import { collectRecommendationContext, fallbackRecommendations, readSavedRecommendations } from '../dist/index.js';
import { createRecommendationWork } from '../src/work.ts';
import { conversationFixture } from '../../conversations/test/fixture.mjs';
import { createGovernanceService } from '../../workspaces/dist/governance.js';

for (const grant of ['individual', 'team'])
  test(
    `${grant} access loss clears all saved and in-flight project dependents, not unrelated members`,
    { timeout: 60000 },
    async () => {
      const f = await conversationFixture();
      try {
        const { id: workspaceId } = f.workspace;
        const alice = { id: randomUUID(), userId: randomUUID() },
          bob = { id: randomUUID(), userId: randomUUID() };
        for (const person of [alice, bob])
          await f.db.platform.query(
            `INSERT INTO ${f.table('tf_memberships')}(id,user_id,role) VALUES($1,$2,'member')`,
            [person.id, person.userId],
          );
        const objects = new Map();
        const files = createFiles(f.runtime, {
          putIfAbsent: async (key, bytes) => {
            objects.set(key, Buffer.from(bytes));
          },
          read: async key => Buffer.from(objects.get(key)),
          remove: async key => {
            objects.delete(key);
          },
        });
        const projects = createProjects(f.runtime, undefined, files);
        const governance = createGovernanceService({
          runtime: f.runtime,
          identity: f.db.platform,
          compatibility: recommendationCompatibility,
        });
        const projectId = randomUUID(),
          fileId = randomUUID(),
          teamId = randomUUID();
        await projects.create(workspaceId, alice.userId, { id: projectId, name: 'Private launch' });
        await projects.member(workspaceId, alice.userId, projectId, {
          membershipId: bob.id,
          role: 'member',
          removed: false,
        });
        await files.upload(
          workspaceId,
          alice.userId,
          fileId,
          { name: 'Launch.txt', parentId: null, mediaType: 'text/plain' },
          Buffer.from('Secret launch date: November 12.'),
        );
        if (grant === 'team') {
          await governance.createTeam(workspaceId, alice.userId, teamId, { name: 'Project readers', description: '' });
          await governance.setEnrollment(workspaceId, alice.userId, teamId, bob.id, { enrolled: true });
        }
        await files.share(
          workspaceId,
          alice.userId,
          fileId,
          { kind: grant, id: grant === 'team' ? teamId : bob.id },
          'viewer',
        );
        await projects.addFile(workspaceId, alice.userId, projectId, { fileId, commandId: randomUUID() });
        const work = createRecommendationWork(f.runtime);
        const tx = operation => f.runtime.transaction(workspaceId, recommendationCompatibility, operation);
        const due = () =>
          f.db.platform.query(
            `UPDATE ${f.table('tf_recommendation_refresh')} SET due_at=clock_timestamp()-interval '1 second'`,
          );
        const generic = { onboarding: false, items: fallbackRecommendations };
        const output = async person => {
          const context = await tx(async transaction =>
            collectRecommendationContext(transaction, await resolveHuman(transaction, person.userId)),
          );
          assert.ok(context.sources.some(source => source.kind === 'file' && source.id === fileId));
          return { ...generic, fingerprint: context.fingerprint, sources: context.sources };
        };
        await tx(transaction =>
          recordRecommendationChange(transaction, {
            id: randomUUID(),
            kind: 'seed',
            sourceId: 'privacy-fixture',
            membershipIds: [f.workspace.membershipId],
          }),
        );
        await due();
        const aliceClaim = await work.claim(workspaceId, alice.id),
          bobClaim = await work.claim(workspaceId, bob.id);
        const aliceOutput = await output(alice),
          bobOutput = await output(bob);
        await work.publish(workspaceId, aliceClaim, aliceOutput);
        await work.trackSources(workspaceId, bobClaim, bobOutput.sources);
        await work.saveOutput(workspaceId, bobClaim, bobOutput);
        await work.publish(workspaceId, await work.claim(workspaceId, f.workspace.membershipId), {
          ...generic,
          fingerprint: 'b'.repeat(64),
          sources: [],
        });
        await tx(transaction =>
          recordRecommendationChange(transaction, {
            id: randomUUID(),
            kind: 'repair',
            sourceId: 'privacy-fixture',
            membershipIds: [alice.id],
          }),
        );
        await due();
        const aliceFlight = await work.claim(workspaceId, alice.id);
        await work.saveOutput(workspaceId, aliceFlight, aliceOutput);
        if (grant === 'team')
          await governance.setEnrollment(workspaceId, alice.userId, teamId, bob.id, { enrolled: false });
        else await files.share(workspaceId, alice.userId, fileId, { kind: 'individual', id: bob.id }, null);
        assert.equal((await tx(transaction => readSavedRecommendations(transaction, alice.id))).status, 'pending');
        assert.equal(
          (
            await f.db.platform.query(
              `SELECT * FROM ${f.table('tf_recommendation_snapshots')} WHERE membership_id=$1`,
              [alice.id],
            )
          ).rowCount,
          0,
          'the owner loses unsafe project-derived output even though they still read the original file',
        );
        assert.equal(await work.output(workspaceId, bobClaim), undefined);
        assert.equal(await work.output(workspaceId, aliceFlight), undefined);
        assert.equal(await work.publish(workspaceId, aliceFlight, aliceOutput), 'superseded');
        assert.equal(await work.publish(workspaceId, bobClaim, bobOutput), 'superseded');
        assert.equal(
          (await tx(transaction => readSavedRecommendations(transaction, f.workspace.membershipId))).status,
          'ready',
        );
        await due();
        const claim = await work.claim(workspaceId, alice.id);
        await work.publish(workspaceId, claim, aliceOutput);
        await files.trash(workspaceId, alice.userId, fileId, true);
        assert.equal(
          (
            await f.db.platform.query(
              `SELECT * FROM ${f.table('tf_recommendation_snapshots')} WHERE membership_id=$1`,
              [alice.id],
            )
          ).rowCount,
          0,
        );
        await files.deleteForever(workspaceId, alice.userId, fileId);
        assert.equal((await f.db.platform.query(`SELECT * FROM ${f.table('tf_recommendation_results')}`)).rowCount, 0);
        assert.equal(await work.publish(workspaceId, claim, aliceOutput), 'superseded');
      } finally {
        await f.close();
      }
    },
  );
