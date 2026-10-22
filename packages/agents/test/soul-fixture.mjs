import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { initializeSoul, soulStorageConfig } from '@tulipfarm/workspaces/soul';
import { prepareSoulRevision } from '@tulipfarm/workspaces/soul-revisions';
import { createAgentAuthoring } from '../src/authoring.ts';

export async function policyVersion(owner, table, agentId) {
  return (await owner.query(`SELECT policy_version FROM ${table('tf_agents')} WHERE id = $1`, [agentId])).rows[0]
    .policy_version;
}

export function agentFixtureAuthoring({ runtime, owner, table, soul, seed, initial }) {
  const commands = createAgentAuthoring(runtime);
  const worker = commands.withWriter(input =>
    prepareSoulRevision(
      soul,
      seed,
      input.parent ? { commit: input.expectedParentCommit, bucket: soul.bucket, ...input.parent } : initial,
      {
        kind: 'agent',
        commandId: input.commandId,
        expectedParentCommit: input.expectedParentCommit,
        createdAt: input.createdAt,
        definition: input.definition,
      },
    ),
  );
  return async (workspaceId, actor, agentId, owningTeamId, definition) => {
    const head = (await owner.query(`SELECT revision FROM ${table('tf_soul_head')} WHERE id = 1`)).rows[0].revision;
    const saved = (await owner.query(`SELECT saved_revision FROM ${table('tf_agents')} WHERE id = $1`, [agentId]))
      .rows[0];
    const command = await commands.save(workspaceId, actor, agentId, {
      requestId: randomUUID(),
      expectedSoulRevision: head,
      expectedSavedRevision: saved?.saved_revision ?? null,
      owningTeamId,
      definition,
    });
    const accepted = await worker.prepare(workspaceId, command.commandId);
    assert.equal(accepted.status, 'accepted');
    const row = (
      await owner.query(
        `SELECT definition_revision FROM ${table('tf_agent_saved_revisions')} WHERE agent_id = $1 AND soul_revision = $2`,
        [agentId, accepted.savedRevision],
      )
    ).rows[0];
    return { agentId: accepted.agentId, revision: row.definition_revision, savedRevision: accepted.savedRevision };
  };
}

export async function createSoulAgentFixture({ runtime, owner, table, workspaceId, createdBy }) {
  const soul = soulStorageConfig();
  assert.equal(soul.bucket, 'tulipfarm-cloud-soul-local');
  async function close() {
    try {
      let continuation;
      do {
        const objects = await soul.client.send(
          new ListObjectsV2Command({
            Bucket: soul.bucket,
            Prefix: `workspaces/${workspaceId}/`,
            ContinuationToken: continuation,
          }),
        );
        if (objects.Contents?.length)
          await soul.client.send(
            new DeleteObjectsCommand({
              Bucket: soul.bucket,
              Delete: { Objects: objects.Contents.map(object => ({ Key: object.Key })) },
            }),
          );
        continuation = objects.IsTruncated ? objects.NextContinuationToken : undefined;
      } while (continuation);
    } finally {
      soul.client.destroy();
    }
  }
  try {
    const seed = { workspaceId, createdBy, createdAt: new Date().toISOString() };
    const initial = await initializeSoul(soul, seed);
    await owner.query(`UPDATE ${table('tf_soul_head')} SET revision = $1 WHERE id = 1`, [initial.commit]);
    return { save: agentFixtureAuthoring({ runtime, owner, table, soul, seed, initial }), close, seed, initial };
  } catch (error) {
    await close();
    throw error;
  }
}
