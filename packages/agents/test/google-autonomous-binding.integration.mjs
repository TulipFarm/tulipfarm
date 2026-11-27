import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createGoogleWorkspaceService } from '@tulipfarm/google-workspace';
import { createGoogleOperations } from '@tulipfarm/google-workspace/operations';
import { googleFixture } from '../../google-workspace/test/fixture.mjs';
import { createAgentExecutor } from '../src/executor.ts';

async function saveDefinition(f, executor, actor, teamId, scope, definition) {
  const agentId = randomUUID();
  const soulRevision = createHash('sha1').update(agentId).digest('hex');
  const definitionRevision = createHash('sha256').update(JSON.stringify(definition)).digest('hex');
  const commandId = randomUUID();
  await f.db.platform.query(`INSERT INTO ${f.table('tf_agents')} (id,enabled,display_name) VALUES ($1,true,$2)`, [
    agentId,
    definition.name,
  ]);
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_agent_definitions')} (agent_id,revision,definition) VALUES ($1,$2,$3::jsonb)`,
    [agentId, definitionRevision, JSON.stringify(definition)],
  );
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_agent_commands')} (id,agent_id,membership_id,user_id,request_id,input) VALUES ($1,$2,$3,$4,$5,'{}')`,
    [commandId, agentId, actor.membershipId, actor.userId, randomUUID()],
  );
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_soul_revisions')} (revision,agent_command_id,bundle_key,bundle_sha256) VALUES ($1,$2,'k','s')`,
    [soulRevision, commandId],
  );
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_agent_saved_revisions')} (agent_id,soul_revision,definition_revision,projection) VALUES ($1,$2,$3,'{}')`,
    [agentId, soulRevision, definitionRevision],
  );
  await f.db.platform.query(`UPDATE ${f.table('tf_agents')} SET saved_revision=$2 WHERE id=$1`, [
    agentId,
    soulRevision,
  ]);
  await f.db.platform.query(`INSERT INTO ${f.table('tf_agent_teams')} (agent_id,team_id) VALUES ($1,$2)`, [
    agentId,
    teamId,
  ]);
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_agent_person_grants')} (agent_id,membership_id,permission) VALUES ($1,$2,'manage')`,
    [agentId, actor.membershipId],
  );
  await executor.configure(f.workspace.id, actor, {
    agentId,
    version: 0,
    enabled: true,
    teamIds: [teamId],
    limits: scope,
  });
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_agent_grants')} (agent_id,team_id,permission) VALUES ($1,$2,'invoke')`,
    [agentId, teamId],
  );
  return { agentId, revision: definitionRevision };
}

test('verifyGoogleDefaults enforces manage grant for autonomousWrites and google.propose executes autonomous writes with allowlist guardrails', async () => {
  const f = await googleFixture();
  try {
    // Make Founder 1 (f.member) and Member 2 (bob) workspace admins so activation tests verifyGoogleDefaults directly.
    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET role = 'admin' WHERE id = $1`, [
      f.member.membershipId,
    ]);
    const bob = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
    await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
      bob.membershipId,
      bob.userId,
    ]);

    f.behavior({ account: 'team-shared-sub', email: 'team@example.com' });
    const shared = await f.connect(f.principal, undefined, { ownership: 'shared', label: 'Team Inbox' });
    await f.service.setGrants(f.workspace.id, f.member.userId, shared.integrationId, {
      expectedGrantsVersion: 1,
      grants: [
        { kind: 'member', membershipId: f.member.membershipId, role: 'manage' },
        { kind: 'member', membershipId: bob.membershipId, role: 'use' },
      ],
    });

    const providerCalls = [];
    const googleFactory = runtime =>
      createGoogleOperations({
        runtime,
        integrations: createGoogleWorkspaceService({ ...f.serviceOptions, runtime }),
        fetcher: async (url, init) => {
          providerCalls.push({ url: String(url), method: init?.method ?? 'GET' });
          if (String(url).includes('/gmail/v1/users/me/messages/send')) {
            return Response.json({ id: 'auto-msg-1', threadId: 'auto-thread-1' });
          }
          throw new Error(`unexpected provider call: ${url}`);
        },
      });
    const executor = createAgentExecutor({ runtime: f.runtime, google: googleFactory });

    const teamId = randomUUID();
    await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'Founders')`, [teamId]);
    for (const person of [f.member, bob]) {
      await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
        person.membershipId,
        teamId,
      ]);
    }
    const scope = [{ assetId: shared.integrationId, permissions: ['integration.read', 'integration.use'] }];

    const autonomousDefinition = {
      name: 'Inbox Auto Responder',
      instructions: 'Reply to verification emails via the bound shared inbox.',
      tools: ['google.read', 'google.propose', 'google.status', 'google.execute'],
      defaults: {
        googleConnection: {
          integrationId: shared.integrationId,
          ownership: 'shared',
          autonomousWrites: {
            allowedOperations: ['gmail.messages.send'],
            allowedRecipients: ['verify@example.com'],
          },
        },
      },
    };

    // Member 2 holds only 'use' grant on the shared account -> cannot activate with autonomousWrites.
    const bobAttempt = await saveDefinition(f, executor, bob, teamId, scope, autonomousDefinition);
    await assert.rejects(
      executor.activate(f.workspace.id, bob, { agentId: bobAttempt.agentId, revision: bobAttempt.revision, scope }),
      AccessDenied,
    );

    // Member 2 CAN activate an agent bound to the shared account without autonomousWrites.
    const bobReadOnly = await saveDefinition(f, executor, bob, teamId, scope, {
      ...autonomousDefinition,
      defaults: {
        googleConnection: {
          integrationId: shared.integrationId,
          ownership: 'shared',
        },
      },
    });
    const bobActivated = await executor.activate(f.workspace.id, bob, {
      agentId: bobReadOnly.agentId,
      revision: bobReadOnly.revision,
      scope,
    });
    assert.ok(bobActivated.activationId);

    // Founder 1 holds 'manage' grant -> CAN activate with autonomousWrites.
    const managerSaved = await saveDefinition(f, executor, f.member, teamId, scope, autonomousDefinition);
    const managerActivated = await executor.activate(f.workspace.id, f.member, {
      agentId: managerSaved.agentId,
      revision: managerSaved.revision,
      scope,
    });

    // Run as Member 2 ('use' grantee) using the manager-activated autonomous agent.
    const run = await executor.startDelegated(f.workspace.id, bob, {
      activationId: managerActivated.activationId,
      scope,
    });

    // 1. Allowlisted recipient without explicit integrationId -> executes autonomously on bound shared account.
    const allowedCallId = randomUUID();
    await executor.queueCall(f.workspace.id, bob, {
      runId: run.runId,
      callId: allowedCallId,
      sequence: 0,
      call: {
        tool: 'google.propose',
        operation: {
          kind: 'gmail.messages.send',
          message: { to: ['verify@example.com'], subject: 'Verify', body: 'Confirmed' },
        },
      },
    });
    assert.equal(
      await executor.execute({ workspaceId: f.workspace.id, runId: run.runId, callId: allowedCallId }),
      'completed',
    );
    const allowedStored = await executor.readResult(
      { workspaceId: f.workspace.id, runId: run.runId, callId: allowedCallId },
      bob,
    );
    assert.equal(allowedStored.status, 'completed');
    assert.equal(allowedStored.result.data.autonomous, true);
    assert.equal(allowedStored.result.data.receipt.status, 'succeeded');
    assert.equal(allowedStored.result.data.receipt.result.data.id, 'auto-msg-1');
    assert.equal(providerCalls.length, 1);

    // 2. Disallowed operation kind -> falls back to normal proposal (not executed autonomously).
    const fallbackCallId = randomUUID();
    await executor.queueCall(f.workspace.id, bob, {
      runId: run.runId,
      callId: fallbackCallId,
      sequence: 1,
      call: {
        tool: 'google.propose',
        operation: {
          kind: 'calendar.events.create',
          calendarId: 'primary',
          event: {
            summary: 'Requires approval',
            start: { dateTime: '2026-05-01T15:00:00Z' },
            end: { dateTime: '2026-05-01T15:30:00Z' },
          },
        },
      },
    });
    assert.equal(
      await executor.execute({ workspaceId: f.workspace.id, runId: run.runId, callId: fallbackCallId }),
      'completed',
    );
    const fallbackStored = await executor.readResult(
      { workspaceId: f.workspace.id, runId: run.runId, callId: fallbackCallId },
      bob,
    );
    assert.equal(fallbackStored.status, 'completed');
    assert.equal(fallbackStored.result.data.autonomous, undefined);
    assert.ok(fallbackStored.result.data.id);
    assert.equal(providerCalls.length, 1);

    // 3. Non-allowlisted recipient -> blocked with operation-policy-denied, provider NOT called.
    const blockedCallId = randomUUID();
    await executor.queueCall(f.workspace.id, bob, {
      runId: run.runId,
      callId: blockedCallId,
      sequence: 2,
      call: {
        tool: 'google.propose',
        operation: {
          kind: 'gmail.messages.send',
          message: { to: ['customer@other.com'], subject: 'External', body: 'Blocked' },
        },
      },
    });
    assert.equal(
      await executor.execute({ workspaceId: f.workspace.id, runId: run.runId, callId: blockedCallId }),
      'failed',
    );
    const blockedStored = await executor.readResult(
      { workspaceId: f.workspace.id, runId: run.runId, callId: blockedCallId },
      bob,
    );
    assert.equal(blockedStored.status, 'failed');
    assert.equal(blockedStored.result.error, 'operation-policy-denied');
    assert.match(blockedStored.result.message, /customer@other\.com/);
    assert.equal(providerCalls.length, 1);
  } finally {
    await f.close();
  }
});
