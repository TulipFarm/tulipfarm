import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied, requireWorkflowSource } from '@tulipfarm/access';
import { createGoogleWorkspaceService } from '@tulipfarm/google-workspace';
import { createGoogleOperations } from '@tulipfarm/google-workspace/operations';
import { createTableService } from '@tulipfarm/tables/service';
import { activeGeneration } from '@tulipfarm/tables/store';
import { taskFields } from '@tulipfarm/tables/tasks-table';
import { createWorkflows } from '@tulipfarm/workflows';
import { gmailReadScopes } from '@tulipfarm/workflows/gmail-trigger';
import { serializeAgentDocument } from '@tulipfarm/workspaces/agent-document';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { googleFixture } from '../../google-workspace/test/fixture.mjs';
import { createAgentExecutor } from '../src/executor.ts';
import { createRowAssignments } from '../src/row-assignments.ts';
import { createTaskClarifications } from '../src/task-clarifications.ts';

const encodeBase64Url = value => Buffer.from(value, 'utf8').toString('base64url');

async function saveAgentRevision(f, executor, actor, teamId, scope, definition, existingAgentId) {
  const agentId = existingAgentId ?? randomUUID();
  const soulRevision = createHash('sha1').update(`${agentId}:${randomUUID()}`).digest('hex');
  const definitionRevision = createHash('sha256').update(JSON.stringify(definition)).digest('hex');
  const commandId = randomUUID();
  if (!existingAgentId) {
    await f.db.platform.query(`INSERT INTO ${f.table('tf_agents')} (id,enabled,display_name) VALUES ($1,true,$2)`, [
      agentId,
      definition.name,
    ]);
  }
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_agent_definitions')} (agent_id,revision,definition) VALUES ($1,$2,$3::jsonb) ON CONFLICT DO NOTHING`,
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
  if (!existingAgentId) {
    await f.db.platform.query(`INSERT INTO ${f.table('tf_agent_teams')} (agent_id,team_id) VALUES ($1,$2)`, [
      agentId,
      teamId,
    ]);
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_agent_person_grants')} (agent_id,membership_id,permission) VALUES ($1,$2,'manage'),($1,$2,'invoke')`,
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
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_agent_assignment_limits')} (agent_id,concurrent) VALUES ($1,2)`,
      [agentId],
    );
  }
  return { agentId, revision: definitionRevision };
}

function createFixtureGmailAccess(f) {
  async function resolve(tx, actor, integrationId) {
    const row = (
      await tx.client.query(
        `SELECT id, membership_id, account_id, email, generation, scopes, ownership
         FROM "${tx.schema}"."tf_google_integrations"
         WHERE id = $1 AND status = 'connected' AND account_id IS NOT NULL AND email IS NOT NULL`,
        [integrationId],
      )
    ).rows[0];
    if (!row) throw new AccessDenied();
    const readScope = gmailReadScopes.find(scope => row.scopes.includes(scope));
    if (!readScope) throw new AccessDenied();
    const isOwner = row.membership_id === actor.membershipId;
    if (row.ownership === 'personal') {
      if (!isOwner) throw new AccessDenied();
    } else if (!isOwner) {
      const granted = (
        await tx.client.query(
          `SELECT 1 FROM "${tx.schema}"."tf_google_grants" g
           WHERE g.integration_id = $1 AND g.role IN ('use', 'manage')
             AND (
               g.grantee = 'workspace'
               OR g.membership_id = $2
               OR EXISTS (SELECT 1 FROM "${tx.schema}"."tf_member_teams" mt WHERE mt.team_id = g.team_id AND mt.membership_id = $2)
             )
           LIMIT 1`,
          [row.id, actor.membershipId],
        )
      ).rowCount;
      if (granted !== 1) throw new AccessDenied();
    }
    return {
      accountId: row.account_id,
      accountEmail: row.email,
      generation: row.generation,
      readScope,
    };
  }
  return {
    async verifyAccess(tx, actor, integrationId) {
      const resolved = await resolve(tx, actor, integrationId);
      return { accountEmail: resolved.accountEmail };
    },
    async withCredential(workspaceId, actor, integrationId, operation) {
      const resolved = await f.runtime.transaction(workspaceId, commonCompatibility, tx =>
        resolve(tx, actor, integrationId),
      );
      return f.service.withReadCredential(
        {
          workspaceId,
          actor: { kind: 'human', membershipId: actor.membershipId, userId: actor.userId },
          integrationId,
          accountId: resolved.accountId,
          generation: resolved.generation,
          requiredScopes: [resolved.readScope],
        },
        ({ accessToken, signal }) => operation({ accessToken, accountEmail: resolved.accountEmail, signal }),
      );
    },
  };
}

test(
  'shared Google onboarding agent end-to-end: accounts, grants, allowlisted writes, direct writes, Gmail reply trigger, freebusy, multi-founder escalation, and calendar booking',
  { timeout: 180_000 },
  async () => {
    const f = await googleFixture();
    try {
      const founder1 = f.admin;
      const founder1Principal = { userId: founder1.userId, sessionId: randomUUID() };
      const founder2 = f.member;
      const founder2Principal = f.principal;
      const outsider = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
      await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        outsider.membershipId,
        outsider.userId,
      ]);

      f.behavior({ account: 'sub-founder1', email: 'founder1@example.com' });
      const founder1Personal = await f.connect(founder1Principal, undefined, { ownership: 'personal' });

      f.behavior({ account: 'sub-hello-shared', email: 'hello@example.com' });
      const sharedHello = await f.connect(founder1Principal, undefined, {
        ownership: 'shared',
        label: 'Team Hello',
        newAccount: true,
      });

      f.behavior({ account: 'sub-founder2', email: 'founder2@example.com' });
      const founder2Personal = await f.connect(founder2Principal, undefined, { ownership: 'personal' });

      await f.service.setGrants(f.workspace.id, founder1.userId, sharedHello.integrationId, {
        expectedGrantsVersion: 1,
        grants: [
          { kind: 'member', membershipId: founder1.membershipId, role: 'manage' },
          { kind: 'member', membershipId: founder2.membershipId, role: 'use' },
        ],
      });

      const founder1Accounts = await f.service.list(f.workspace.id, founder1.userId);
      assert.deepEqual(
        founder1Accounts.map(a => ({ email: a.email, ownership: a.ownership, canManage: a.canManage })),
        [
          { email: 'founder1@example.com', ownership: 'personal', canManage: true },
          { email: 'hello@example.com', ownership: 'shared', canManage: true },
        ],
        'founder 1 sees personal and shared Google accounts with manage rights',
      );
      const founder2Accounts = await f.service.list(f.workspace.id, founder2.userId);
      assert.deepEqual(
        founder2Accounts.map(a => ({
          email: a.email,
          ownership: a.ownership,
          canUse: a.canUse,
          canManage: a.canManage,
        })),
        [
          { email: 'founder2@example.com', ownership: 'personal', canUse: true, canManage: true },
          { email: 'hello@example.com', ownership: 'shared', canUse: true, canManage: false },
        ],
        'founder 2 sees own personal account and granted shared account',
      );
      const outsiderAccounts = await f.service.list(f.workspace.id, outsider.userId);
      assert.equal(outsiderAccounts.length, 0, 'outsider does not see founder personal or shared Google accounts');

      const membersTableId = (
        await f.db.platform.query(
          `SELECT table_id FROM ${f.table('tf_system_tables')} WHERE kind = 'workspace-members'`,
        )
      ).rows[0].table_id;
      await f.db.platform.query(
        `UPDATE ${f.table('tf_table_identities')} ti
         SET live = true
         FROM ${f.table('tf_workspace_member_accounts')} a
         WHERE ti.table_id = $1 AND ti.row_id = a.member_id AND a.membership_id = ANY($2::uuid[])`,
        [membersTableId, [founder1.membershipId, founder2.membershipId]],
      );
      const verifiedLinks = (
        await f.db.platform.query(
          `SELECT membership_id, external_id, handle FROM ${f.table('tf_member_verified_links')} WHERE provider = 'google' ORDER BY handle`,
        )
      ).rows;
      const verifiedEmails = verifiedLinks.map(r => r.handle);
      assert.ok(verifiedEmails.includes('founder1@example.com'), 'founder 1 personal account is in verified links');
      assert.ok(verifiedEmails.includes('founder2@example.com'), 'founder 2 personal account is in verified links');
      assert.ok(!verifiedEmails.includes('hello@example.com'), 'shared account is excluded from member verified links');
      assert.ok(founder1Personal.integrationId && founder2Personal.integrationId);

      const teamId = randomUUID();
      await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'Founders')`, [teamId]);
      for (const person of [founder1, founder2]) {
        await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
          person.membershipId,
          teamId,
        ]);
      }

      const providerCalls = [];
      let sentCount = 0;
      const googleFactory = runtime =>
        createGoogleOperations({
          runtime,
          integrations: createGoogleWorkspaceService({ ...f.serviceOptions, runtime }),
          fetcher: async (url, init) => {
            const target = String(url);
            const body = init?.body ? JSON.parse(String(init.body)) : undefined;
            providerCalls.push({ url: target, method: init?.method ?? 'GET', body });
            if (target.includes('/gmail/v1/users/me/messages/send')) {
              sentCount += 1;
              return Response.json({
                id: `sent-msg-${sentCount}`,
                threadId: body?.threadId ?? `thread-onboarding-${sentCount}`,
              });
            }
            if (target.includes('/calendar/v3/freeBusy')) {
              return Response.json({
                kind: 'calendar#freeBusy',
                timeMin: body.timeMin,
                timeMax: body.timeMax,
                calendars: {
                  'founder1@example.com': {
                    busy: [{ start: '2026-12-03T15:00:00Z', end: '2026-12-03T16:00:00Z' }],
                  },
                  'founder2@example.com': {
                    busy: [{ start: '2026-12-03T13:00:00Z', end: '2026-12-03T14:00:00Z' }],
                  },
                },
              });
            }
            if (target.includes('/calendar/v3/calendars/primary/events')) {
              return Response.json({
                id: 'cal-event-1',
                status: 'confirmed',
                summary: body.summary,
                start: body.start,
                end: body.end,
                attendees: body.attendees,
              });
            }
            throw new Error(`Unexpected Google provider call: ${target}`);
          },
        });
      const executor = createAgentExecutor({ runtime: f.runtime, google: googleFactory });

      const scope = [{ assetId: sharedHello.integrationId, permissions: ['integration.read', 'integration.use'] }];
      const onboardingDefinitionV1 = {
        name: 'Customer Onboarding Agent',
        instructions: 'Welcome new signups, answer questions, and coordinate onboarding calls with founders.',
        tools: ['google.read', 'google.propose', 'google.status', 'google.execute'],
        defaults: {
          googleConnection: {
            integrationId: sharedHello.integrationId,
            ownership: 'shared',
            autonomousWrites: {
              allowedOperations: ['gmail.messages.send', 'calendar.events.create'],
              allowedRecipients: ['verify@example.com'],
            },
          },
        },
        escalationPolicy: {
          rules: 'Ask founders for a suitable timeslot before booking a call.',
          minConfidence: 0.7,
          targetMembershipIds: [founder1.membershipId, founder2.membershipId],
        },
      };

      const serialized = serializeAgentDocument({
        formatVersion: 1,
        id: randomUUID(),
        ...onboardingDefinitionV1,
      });
      assert.ok(serialized.includes(sharedHello.integrationId), 'agent document serializes googleConnection cleanly');

      const savedV1 = await saveAgentRevision(f, executor, founder1, teamId, scope, onboardingDefinitionV1);
      const activationV1 = await executor.activate(f.workspace.id, founder1, {
        agentId: savedV1.agentId,
        revision: savedV1.revision,
        scope,
      });

      const gmailMessages = new Map([
        [
          'msg-own-welcome',
          {
            id: 'msg-own-welcome',
            threadId: 'thread-onboarding-1',
            internalDate: '1763000001000',
            snippet: 'Welcome to Acme onboarding!',
            labelIds: ['SENT'],
            payload: {
              mimeType: 'text/plain',
              headers: [
                { name: 'From', value: 'Team Hello <hello@example.com>' },
                { name: 'To', value: 'customer@acme.example' },
                { name: 'Subject', value: 'Welcome' },
              ],
              body: { data: encodeBase64Url('Welcome! Let us know when you would like to chat.') },
            },
          },
        ],
        [
          'msg-customer-reply',
          {
            id: 'msg-customer-reply',
            threadId: 'thread-onboarding-1',
            internalDate: '1763000020000',
            snippet: 'Yes, I would love to chat this week!',
            labelIds: ['INBOX'],
            payload: {
              mimeType: 'text/plain',
              headers: [
                { name: 'From', value: 'Customer <customer@acme.example>' },
                { name: 'To', value: 'Team Hello <hello@example.com>' },
                { name: 'Subject', value: 'Re: Welcome' },
                { name: 'In-Reply-To', value: '<welcome-1>' },
              ],
              body: { data: encodeBase64Url('Yes, I would love to chat this week!') },
            },
          },
        ],
      ]);

      const gmailFetch = async input => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/users/me/messages?')) {
          return Response.json({
            messages: [
              { id: 'msg-customer-reply', threadId: 'thread-onboarding-1' },
              { id: 'msg-own-welcome', threadId: 'thread-onboarding-1' },
            ],
          });
        }
        const id = url.split('/users/me/messages/')[1]?.split('?')[0];
        return Response.json(gmailMessages.get(id));
      };

      const wokenWorkflows = [];
      const workflows = createWorkflows(f.runtime, {
        keyring: f.serviceOptions.keyring,
        agentSteps: true,
        gmailAccess: createFixtureGmailAccess(f),
        gmailFetch,
        wake: async work => {
          wokenWorkflows.push(work);
        },
      });

      const workflowId = randomUUID();
      const workflowRevision = randomUUID();
      await workflows.save(f.workspace.id, founder1.userId, workflowId, {
        revision: workflowRevision,
        expectedRevision: null,
        definition: {
          version: 1,
          name: 'Customer Onboarding Intake',
          triggers: [
            { id: 'signup', kind: 'webhook' },
            {
              id: 'reply',
              kind: 'gmail',
              integrationId: sharedHello.integrationId,
              repliesOnly: true,
              excludeOwnSent: true,
            },
          ],
          steps: [
            {
              id: 'capture',
              kind: 'transform',
              fields: {
                trigger: { kind: 'trigger', path: ['kind'] },
                payload: { kind: 'input', path: [] },
              },
            },
          ],
        },
      });
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_workflow_grants')} (workflow_id,membership_id,permission) VALUES ($1,$2,'read'),($1,$3,'read') ON CONFLICT DO NOTHING`,
        [workflowId, founder2.membershipId, outsider.membershipId],
      );
      const sponsoredWorkflow = await workflows.sponsorship(f.workspace.id, founder1.userId, workflowId, {
        sponsorMembershipId: founder1.membershipId,
        historyAudience: [founder1.membershipId, founder2.membershipId],
      });
      const activeWorkflow = await workflows.activate(f.workspace.id, founder1.userId, workflowId, {
        commandId: randomUUID(),
        expectedGeneration: sponsoredWorkflow.generation,
        revision: workflowRevision,
        enabled: true,
      });

      await f.runtime.transaction(f.workspace.id, commonCompatibility, async tx => {
        await requireWorkflowSource(tx, founder1, {
          kind: 'workflow-definition',
          workflowId,
          revision: workflowRevision,
        });
        await requireWorkflowSource(tx, founder2, {
          kind: 'workflow-definition',
          workflowId,
          revision: workflowRevision,
        });
        await assert.rejects(
          requireWorkflowSource(tx, outsider, {
            kind: 'workflow-definition',
            workflowId,
            revision: workflowRevision,
          }),
          AccessDenied,
          'outsider without shared Google grant cannot satisfy workflow source dependency for Gmail trigger',
        );
      });

      const webhookIssued = await workflows.webhookKey(
        f.workspace.id,
        founder1.userId,
        workflowId,
        { commandId: randomUUID(), expectedGeneration: activeWorkflow.generation, mode: 'bearer' },
        'signup',
      );
      const signupRequestId = randomUUID();
      const webhookOutcome = await workflows.webhook(
        f.workspace.id,
        workflowId,
        {
          headers: { authorization: `Bearer ${webhookIssued.key}` },
          rawBody: Buffer.from(
            JSON.stringify({ requestId: signupRequestId, input: { customerEmail: 'customer@acme.example' } }),
          ),
          body: { requestId: signupRequestId, input: { customerEmail: 'customer@acme.example' } },
        },
        'signup',
      );
      assert.ok(webhookOutcome.runId, 'signup webhook admits a workflow run');

      const runV1 = await executor.startDelegated(f.workspace.id, founder1, {
        activationId: activationV1.activationId,
        scope,
      });

      const blockedSendId = randomUUID();
      await executor.queueCall(f.workspace.id, founder1, {
        runId: runV1.runId,
        callId: blockedSendId,
        sequence: 0,
        call: {
          tool: 'google.propose',
          operation: {
            kind: 'gmail.messages.send',
            message: { to: ['customer@acme.example'], subject: 'Welcome', body: 'Hello from Team Hello!' },
          },
        },
      });
      assert.equal(
        await executor.execute({ workspaceId: f.workspace.id, runId: runV1.runId, callId: blockedSendId }),
        'failed',
        'verification-only allowlist blocks direct email to customer',
      );
      const blockedResult = await executor.readResult(
        { workspaceId: f.workspace.id, runId: runV1.runId, callId: blockedSendId },
        founder1,
      );
      assert.equal(blockedResult.status, 'failed');
      assert.equal(blockedResult.result.error, 'operation-policy-denied');
      assert.equal(providerCalls.length, 0, 'blocked send never reaches Google API');

      const runV1Verify = await executor.startDelegated(f.workspace.id, founder1, {
        activationId: activationV1.activationId,
        scope,
      });
      const verifySendId = randomUUID();
      await executor.queueCall(f.workspace.id, founder1, {
        runId: runV1Verify.runId,
        callId: verifySendId,
        sequence: 0,
        call: {
          tool: 'google.propose',
          operation: {
            kind: 'gmail.messages.send',
            message: {
              to: ['verify@example.com'],
              subject: 'Draft welcome for customer@acme.example',
              body: 'Please verify this welcome note.',
            },
          },
        },
      });
      assert.equal(
        await executor.execute({ workspaceId: f.workspace.id, runId: runV1Verify.runId, callId: verifySendId }),
        'completed',
      );
      const verifyResult = await executor.readResult(
        { workspaceId: f.workspace.id, runId: runV1Verify.runId, callId: verifySendId },
        founder1,
      );
      assert.equal(verifyResult.result.data.autonomous, true);
      assert.equal(verifyResult.result.data.receipt.status, 'succeeded');
      assert.equal(providerCalls.length, 1, 'allowlisted verification email executes autonomously');

      const onboardingDefinitionV2 = {
        ...onboardingDefinitionV1,
        defaults: {
          googleConnection: {
            integrationId: sharedHello.integrationId,
            ownership: 'shared',
            autonomousWrites: {
              allowedOperations: ['gmail.messages.send', 'calendar.events.create'],
            },
          },
        },
      };
      const savedV2 = await saveAgentRevision(
        f,
        executor,
        founder1,
        teamId,
        scope,
        onboardingDefinitionV2,
        savedV1.agentId,
      );
      const activationV2 = await executor.activate(f.workspace.id, founder1, {
        agentId: savedV2.agentId,
        revision: savedV2.revision,
        scope,
      });

      const runV2 = await executor.startDelegated(f.workspace.id, founder1, {
        activationId: activationV2.activationId,
        scope,
      });
      const directSendId = randomUUID();
      await executor.queueCall(f.workspace.id, founder1, {
        runId: runV2.runId,
        callId: directSendId,
        sequence: 0,
        call: {
          tool: 'google.propose',
          operation: {
            kind: 'gmail.messages.send',
            message: { to: ['customer@acme.example'], subject: 'Welcome', body: 'Welcome to Acme!' },
          },
        },
      });
      assert.equal(
        await executor.execute({ workspaceId: f.workspace.id, runId: runV2.runId, callId: directSendId }),
        'completed',
      );
      const directResult = await executor.readResult(
        { workspaceId: f.workspace.id, runId: runV2.runId, callId: directSendId },
        founder1,
      );
      assert.equal(directResult.result.data.autonomous, true);
      assert.equal(directResult.result.data.receipt.status, 'succeeded');
      assert.equal(providerCalls.length, 2, 'customer direct welcome email executes autonomously');

      const firstPoll = await workflows.pollGmailTriggers(f.workspace.id);
      assert.equal(
        firstPoll.admitted.length,
        1,
        'Gmail poll suppresses own sent mail and fires once for customer reply',
      );

      const gmailRuns = (
        await f.db.platform.query(
          `SELECT id, input FROM ${f.table('tf_workflow_runs')} WHERE workflow_id = $1 AND id <> $2`,
          [workflowId, webhookOutcome.runId],
        )
      ).rows;
      assert.equal(gmailRuns.length, 1);
      assert.equal(gmailRuns[0].input.threadId, 'thread-onboarding-1');
      assert.equal(gmailRuns[0].input.messageId, 'msg-customer-reply');
      assert.equal(gmailRuns[0].input.bodyText, 'Yes, I would love to chat this week!');
      assert.equal(gmailRuns[0].input.inReplyTo, '<welcome-1>');

      const secondPoll = await workflows.pollGmailTriggers(f.workspace.id);
      assert.equal(secondPoll.admitted.length, 0, 'repeated Gmail poll creates zero duplicate runs');

      const freeBusyCallId = randomUUID();
      await executor.queueCall(f.workspace.id, founder1, {
        runId: runV2.runId,
        callId: freeBusyCallId,
        sequence: 1,
        call: {
          tool: 'google.read',
          operation: {
            kind: 'calendar.freebusy.query',
            timeMin: '2026-12-03T12:00:00Z',
            timeMax: '2026-12-03T18:00:00Z',
            timeZone: 'UTC',
            items: [{ id: 'founder1@example.com' }, { id: 'founder2@example.com' }],
          },
        },
      });
      assert.equal(
        await executor.execute({ workspaceId: f.workspace.id, runId: runV2.runId, callId: freeBusyCallId }),
        'completed',
      );
      const freeBusyResult = await executor.readResult(
        { workspaceId: f.workspace.id, runId: runV2.runId, callId: freeBusyCallId },
        founder1,
      );
      assert.equal(freeBusyResult.status, 'completed');
      const freeBusyCalendars = freeBusyResult.result.data.data.calendars;
      assert.equal(freeBusyCalendars['founder1@example.com'].busy[0].start, '2026-12-03T15:00:00Z');
      assert.equal(freeBusyCalendars['founder2@example.com'].busy[0].start, '2026-12-03T13:00:00Z');

      const tables = createTableService(f.runtime, { readableFiles: async () => new Set() }, commonCompatibility);
      const [{ id: tasksTableId }] = (
        await f.db.platform.query(
          `SELECT core_definition->>'id' AS id FROM ${f.table('tf_system_tables')} WHERE kind = 'tasks'`,
        )
      ).rows;
      const { revision: tasksTableRevision } = await f.runtime.transaction(f.workspace.id, commonCompatibility, tx =>
        activeGeneration(tx, tasksTableId),
      );
      const taskRow = await tables.mutate(f.workspace.id, founder1.userId, {
        tableId: tasksTableId,
        revision: tasksTableRevision,
        kind: 'create',
        recordId: randomUUID(),
        values: {
          [taskFields.title]: { kind: 'text', value: 'Schedule onboarding call for customer@acme.example' },
          [taskFields.assignee]: { kind: 'actor', actor: { type: 'agent', id: savedV2.agentId } },
        },
      });

      const wokenTasks = [];
      let createdTaskId = null;
      const assignments = createRowAssignments({
        runtime: f.runtime,
        start: async (_workspace, userId, input) => {
          const id = randomUUID();
          createdTaskId = id;
          await f.db.platform.query(
            `INSERT INTO ${f.table('tf_agent_tasks')}(id,owner_user_id,owner_membership_id,agent_id,activation_id,definition_revision,skills,scope,limits,flow_id)
              VALUES($1,$2,$3,$4,$5,$6,'[]','[]',$7,gen_random_uuid())`,
            [
              id,
              userId,
              founder1.membershipId,
              savedV2.agentId,
              activationV2.activationId,
              savedV2.revision,
              JSON.stringify(input.limits ?? {}),
            ],
          );
          return { id };
        },
        pause: async () => {},
        wake: async (_workspace, taskId) => wokenTasks.push(taskId),
      });

      await assignments.step(f.workspace.id);
      assert.ok(createdTaskId);

      const escalationReply = [
        'OUTCOME: waiting',
        'REASON: Need a founder to choose an onboarding timeslot',
        'CLARIFICATION: {"title":"Pick onboarding slot","summary":"customer@acme.example wants to chat this week. Founder 2 is free Thursday 3pm UTC.","fields":[{"id":"slot","label":"Preferred slot","kind":"text","required":true}]}',
      ].join('\n');
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_agent_task_messages')}(task_id,sequence,generation,role,text,sources) VALUES($1,1,0,'agent',$2,'[]')`,
        [createdTaskId, escalationReply],
      );
      await f.db.platform.query(`UPDATE ${f.table('tf_agent_tasks')} SET status='completed' WHERE id=$1`, [
        createdTaskId,
      ]);
      await assignments.step(f.workspace.id);

      const inboxBefore = (
        await f.db.platform.query(
          `SELECT membership_id, kind, resolved_at FROM ${f.table('tf_inbox_items')} WHERE row_id = $1`,
          [taskRow.id],
        )
      ).rows;
      const waitingMembers = new Set(
        inboxBefore.filter(r => r.resolved_at === null && r.kind === 'waiting').map(r => r.membership_id),
      );
      assert.equal(waitingMembers.has(founder1.membershipId), true, 'founder 1 receives waiting inbox item');
      assert.equal(waitingMembers.has(founder2.membershipId), true, 'founder 2 receives waiting inbox item');
      assert.equal(waitingMembers.has(outsider.membershipId), false, 'outsider receives no inbox item');

      const [{ id: clarificationId }] = (
        await f.db.platform.query(
          `SELECT id FROM ${f.table('tf_row_clarifications')} WHERE row_id = $1 AND status = 'open'`,
          [taskRow.id],
        )
      ).rows;
      const clarifications = createTaskClarifications({ runtime: f.runtime });
      await assert.rejects(
        clarifications.answer(
          f.workspace.id,
          outsider,
          clarificationId,
          { answers: { slot: 'Unauthorized answer' } },
          'web',
        ),
        AccessDenied,
        'outsider cannot answer founder escalation',
      );

      await clarifications.answer(
        f.workspace.id,
        founder2,
        clarificationId,
        { answers: { slot: 'Book Thursday 3pm UTC with me' } },
        'web',
      );

      const inboxAfter = (
        await f.db.platform.query(
          `SELECT membership_id, resolved_at FROM ${f.table('tf_inbox_items')} WHERE row_id = $1`,
          [taskRow.id],
        )
      ).rows;
      assert.ok(
        inboxAfter.every(r => r.resolved_at !== null),
        'sibling inbox items for both founders resolve after founder 2 answers',
      );

      await assignments.step(f.workspace.id);
      assert.ok(wokenTasks.includes(createdTaskId), 'task resumes after non-sponsor founder answers');

      const runV2Booking = await executor.startDelegated(f.workspace.id, founder2, {
        activationId: activationV2.activationId,
        scope,
      });
      const replySendId = randomUUID();
      await executor.queueCall(f.workspace.id, founder2, {
        runId: runV2Booking.runId,
        callId: replySendId,
        sequence: 0,
        call: {
          tool: 'google.propose',
          operation: {
            kind: 'gmail.messages.send',
            message: {
              to: ['customer@acme.example'],
              subject: 'Re: Welcome',
              threadId: 'thread-onboarding-1',
              body: 'Booked Thursday 3pm UTC with Founder 2. Calendar invite attached!',
            },
          },
        },
      });
      assert.equal(
        await executor.execute({ workspaceId: f.workspace.id, runId: runV2Booking.runId, callId: replySendId }),
        'completed',
      );
      const replyResult = await executor.readResult(
        { workspaceId: f.workspace.id, runId: runV2Booking.runId, callId: replySendId },
        founder2,
      );
      assert.equal(replyResult.result.data.autonomous, true);
      assert.equal(replyResult.result.data.receipt.status, 'succeeded');
      assert.equal(replyResult.result.data.receipt.result.data.threadId, 'thread-onboarding-1');

      const bookCallId = randomUUID();
      await executor.queueCall(f.workspace.id, founder2, {
        runId: runV2Booking.runId,
        callId: bookCallId,
        sequence: 1,
        call: {
          tool: 'google.propose',
          operation: {
            kind: 'calendar.events.create',
            calendarId: 'primary',
            event: {
              summary: 'Onboarding call with Customer',
              start: { dateTime: '2026-12-03T15:00:00Z' },
              end: { dateTime: '2026-12-03T15:30:00Z' },
              attendees: [{ email: 'customer@acme.example' }, { email: 'founder2@example.com' }],
            },
          },
        },
      });
      assert.equal(
        await executor.execute({ workspaceId: f.workspace.id, runId: runV2Booking.runId, callId: bookCallId }),
        'completed',
      );
      const bookResult = await executor.readResult(
        { workspaceId: f.workspace.id, runId: runV2Booking.runId, callId: bookCallId },
        founder2,
      );
      assert.equal(bookResult.result.data.autonomous, true);
      assert.equal(bookResult.result.data.receipt.status, 'succeeded');
      assert.equal(bookResult.result.data.receipt.result.data.id, 'cal-event-1');
    } finally {
      await f.close();
    }
  },
);
