import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied, lockAuthorization, requireCurrentActor } from '@tulipfarm/access';
import { fixture } from '../../integrations/test/fixture.mjs';
import { createSoulAgentFixture } from './soul-fixture.mjs';
import { agentCompatibility } from '../src/store.ts';

test(
  'current agent authority requires a Soul-backed live agent even for persisted legacy runs',
  { timeout: 60000 },
  async () => {
    const f = await fixture();
    let soul;
    try {
      soul = await createSoulAgentFixture({ ...f, createdBy: f.creator.userId });
      const agentId = randomUUID();
      const definition = { name: 'Authority proof', instructions: 'Read only', tools: ['rows.list'] };
      const saved = await soul.save(f.workspaceId, f.creator, agentId, f.teamId, definition);
      const legacyId = randomUUID();
      const legacyRevision = 'c'.repeat(64);
      await f.owner.query(`INSERT INTO ${f.table('tf_agents')} (id) VALUES ($1)`, [legacyId]);
      await f.owner.query(
        `INSERT INTO ${f.table('tf_agent_definitions')} (agent_id,revision,definition) VALUES ($1,$2,$3)`,
        [legacyId, legacyRevision, definition],
      );
      const runs = [];
      for (const [id, revision] of [
        [agentId, saved.revision],
        [legacyId, legacyRevision],
      ]) {
        const activationId = randomUUID();
        const scheduleId = randomUUID();
        const runId = randomUUID();
        await f.owner.query(`UPDATE ${f.table('tf_agents')} SET enabled=true WHERE id=$1`, [id]);
        await f.owner.query(`INSERT INTO ${f.table('tf_agent_limits')} (agent_id,scope) VALUES ($1,'[]')`, [id]);
        await f.owner.query(
          `INSERT INTO ${f.table('tf_agent_activations')} (id,agent_id,definition_revision,scope) VALUES ($1,$2,$3,'[]')`,
          [activationId, id, revision],
        );
        await f.owner.query(
          `INSERT INTO ${f.table('tf_agent_schedules')} (id,activation_id,scope,sponsor_membership_id) VALUES ($1,$2,'[]',$3)`,
          [scheduleId, activationId, f.creator.membershipId],
        );
        await f.owner.query(
          `INSERT INTO ${f.table('tf_agent_runs')} (id,agent_id,activation_id,definition_revision,kind,schedule_id,scope,sponsor_membership_id) VALUES ($1,$2,$3,$4,'scheduled',$5,'[]',$6)`,
          [runId, id, activationId, revision, scheduleId, f.creator.membershipId],
        );
        runs.push(runId);
      }
      const authorize = runId =>
        f.runtime.transaction(f.workspaceId, agentCompatibility, async transaction => {
          await lockAuthorization(transaction);
          await requireCurrentActor(transaction, { kind: 'agent', runId });
          return 'authorized';
        });
      assert.equal(await authorize(runs[0]), 'authorized');
      await assert.rejects(authorize(runs[1]), AccessDenied);
      await f.owner.query(`UPDATE ${f.table('tf_agents')} SET saved_revision=NULL WHERE id=$1`, [agentId]);
      await assert.rejects(authorize(runs[0]), AccessDenied);
      await f.owner.query(`UPDATE ${f.table('tf_agents')} SET saved_revision=$2 WHERE id=$1`, [
        agentId,
        saved.savedRevision,
      ]);
      assert.equal(await authorize(runs[0]), 'authorized');
      await f.owner.query(`UPDATE ${f.table('tf_agents')} SET deleted_at=now() WHERE id=$1`, [agentId]);
      await assert.rejects(authorize(runs[0]), AccessDenied);
    } finally {
      try {
        await f.close();
      } finally {
        await soul?.close();
      }
    }
  },
);
