import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentAuthoring } from '../../../packages/agents/dist/authoring.js';
import { initializeSoul, soulStorageConfig } from '../../../packages/workspaces/dist/soul.js';
import { prepareSoulRevision, readVerifiedProjection } from '../../../packages/workspaces/dist/soul-revisions.js';
import { createConversationActivities } from '../../worker/dist/conversation-activities.js';
import { registerAuthoringDrafts } from '../../api/dist/authoring-drafts.js';
import { registerSkills } from '../../api/dist/skills.js';
import { registerModelCatalog } from '../../api/dist/model-catalog.js';
import { resolveModelBundle } from '../../../packages/config/dist/index.js';
import { useModelCatalog } from '../../worker/test/model-catalog-fixture.mjs';

export async function taskAuthoring({ runtime, db, w, table, teamId, definition }) {
  let agentId;
  const soul = soulStorageConfig(),
    seed = { workspaceId: w.id, createdBy: w.userId, createdAt: new Date().toISOString() };
  const initial = await initializeSoul(soul, seed);
  await db.platform.query(`UPDATE ${table('tf_soul_head')} SET revision=$1 WHERE id=1`, [initial.commit]);
  const writer = createAgentAuthoring(runtime).withWriter(input =>
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
  const activities = createConversationActivities(runtime);
  let calls, step;
  process.env.ANTHROPIC_API_KEY = 'synthetic-authoring-only';
  useModelCatalog();
  return {
    initial: initial.commit,
    activities: {
      ...activities,
      prepareAgentDefinition: (workspaceId, commandId) => writer.prepare(workspaceId, commandId),
    },
    close: () => soul.client.destroy(),
    readProjection: (workspaceId, projection) => readVerifiedProjection(soul, workspaceId, projection),
    async revise(user, nextDefinition) {
      const head = (await db.platform.query(`SELECT revision FROM ${table('tf_soul_head')} WHERE id=1`)).rows[0]
        .revision;
      const saved = (await db.platform.query(`SELECT saved_revision FROM ${table('tf_agents')} WHERE id=$1`, [agentId]))
        .rows[0].saved_revision;
      const command = await createAgentAuthoring(runtime).save(w.id, user, agentId, {
        requestId: randomUUID(),
        expectedSoulRevision: head,
        expectedSavedRevision: saved,
        owningTeamId: teamId,
        definition: nextDefinition,
      });
      assert.equal((await writer.prepare(w.id, command.commandId)).status, 'accepted');
      return (
        await db.platform.query(
          `SELECT definition_revision FROM ${table('tf_agent_saved_revisions')} WHERE agent_id=$1 AND soul_revision=(SELECT saved_revision FROM ${table('tf_agents')} WHERE id=$1)`,
          [agentId],
        )
      ).rows[0].definition_revision;
    },
    decision: () =>
      step < calls.length
        ? { kind: 'tool', call: calls[step++] }
        : { kind: 'answer', text: 'Review the draft before saving. Nothing is activated.' },
    register(routes, auth, bundle, commonVersion) {
      registerAuthoringDrafts(routes, { runtime, auth, modelFamilyEligibility: () => true });
      registerSkills(routes, { runtime, auth });
      registerModelCatalog(routes, {
        runtime,
        auth,
        compatibility: { minimum: commonVersion, maximum: commonVersion },
        modelFamilyEligibility: input => input.modelFamilyId === 'claude-opus',
        modelFamilyResolution: input =>
          resolveModelBundle({
            bundle,
            familyId: input.modelFamilyId,
            allowedProviders: ['anthropic'],
            allowedLocations: ['test'],
          }),
      });
    },
    async run(page, origin, chats, temporal, taskQueue) {
      const chatId = randomUUID(),
        skillId = randomUUID();
      await chats.create(w.id, w.userId, { chatId, commandId: randomUUID() });
      async function draft(next, kind) {
        calls = [{ tool: 'agents.context' }, next];
        step = 0;
        await page.goto(`${origin}/journey/chat/${chatId}`);
        await page
          .getByRole('textbox', { name: 'Message', exact: true })
          .fill(`Please draft the ${kind} for contact cleanup.`);
        const sent = page.waitForResponse(
          response => response.request().method() === 'PUT' && response.url().includes('/messages/'),
        );
        await page.getByRole('button', { name: 'Send message', exact: true }).click();
        const response = await sent;
        assert.equal(response.status(), 200);
        const turn = await response.json();
        assert.equal(
          await temporal.client.workflow.execute('conversationReply', {
            workflowId: `conversation-reply-v1-${w.id}-${turn.turnId}-0`,
            taskQueue,
            args: [{ workspaceId: w.id, conversationId: chatId, turnId: turn.turnId, generation: 0 }],
          }),
          'completed',
        );
        const stored = (
          await db.platform.query(
            `SELECT sources, proposal->>'targetId' AS "targetId" FROM ${table('tf_chat_authoring_drafts')} WHERE conversation_id=$1 AND proposal->>'kind'=$2`,
            [chatId, kind],
          )
        ).rows;
        assert.equal(stored.length, 1);
        if (kind === 'agent') agentId = stored[0].targetId;
        const retained = stored[0].sources;
        assert.ok(
          retained.some(
            source => source.kind === 'creation-team' && source.teamId === teamId && source.authority === 'agent',
          ),
        );
        await page.reload();
        const card = page.getByRole('region', { name: `Review ${kind} draft` }).last();
        await card.getByText('Draft', { exact: true }).waitFor();
        await card.getByRole('heading', { name: next.input.definition.name, exact: true }).waitFor();
        await card.getByText(next.input.definition.instructions, { exact: true }).waitFor();
        if (kind === 'agent') {
          assert.deepEqual(
            await card
              .getByRole('list', { name: 'Actions this agent may take' })
              .getByRole('listitem')
              .allTextContents(),
            ['Find rows', 'Read a row', 'Update rows'],
          );
          await card
            .getByRole('list', { name: 'Pinned skills' })
            .getByText('Built-in skill: agent-authoring', { exact: true })
            .waitFor();
          await card.getByText('Creates a new agent', { exact: true }).waitFor();
          await card.getByRole('button', { name: 'Technical details' }).click();
          const technical = card.getByLabel('Technical details', { exact: true });
          await technical.getByText(teamId, { exact: true }).waitFor();
          await technical.getByText('claude-opus', { exact: true }).waitFor();
          await technical.getByText('rows.list, rows.get, rows.update', { exact: true }).waitFor();
          await technical
            .getByText(definition.skills.map(skill => `${skill.id} · Revision ${skill.revision}`).join(', '), {
              exact: true,
            })
            .waitFor();
          assert.equal(
            (
              await db.platform.query(
                `SELECT count(*)::integer AS n FROM ${table('tf_agent_commands')} WHERE agent_id=$1`,
                [agentId],
              )
            ).rows[0].n,
            0,
          );
        } else {
          assert.equal(
            (
              await db.platform.query(
                `SELECT count(*)::integer AS n FROM ${table('tf_workspace_skills')} WHERE id=$1`,
                [skillId],
              )
            ).rows[0].n,
            0,
          );
        }
        const savedResponse = page.waitForResponse(
          response => response.request().method() === 'PUT' && response.url().endsWith('/decision'),
        );
        await card.getByRole('button', { name: `Save ${kind}` }).click();
        assert.equal((await savedResponse).status(), 200);
        return card;
      }
      const skillCard = await draft(
        {
          tool: 'skills.draft',
          skillId,
          input: {
            expectedVersion: 0,
            definition: {
              name: 'Contact cleanup procedure',
              description: 'Clean contact records and resolve ambiguous names.',
              instructions: 'Read contacts, clarify ambiguous casing, and request approval before exact updates.',
            },
          },
        },
        'skill',
      );
      await skillCard.getByText('Clean contact records and resolve ambiguous names.', { exact: true }).waitFor();
      await skillCard
        .getByText('Skill saved. Agents use it only after a skill manager reviews this revision.', { exact: true })
        .waitFor();
      const skill = (
        await db.platform.query(
          `SELECT saved_revision,active_revision FROM ${table('tf_workspace_skills')} WHERE id=$1`,
          [skillId],
        )
      ).rows[0];
      assert.equal(skill.active_revision, null);
      await page.goto(`${origin}/journey/skills/${skillId}`);
      assert.equal(
        await page.getByLabel('Procedure', { exact: true }).inputValue(),
        'Read contacts, clarify ambiguous casing, and request approval before exact updates.',
      );
      await page.getByRole('button', { name: 'Exact revision identifiers', exact: true }).click();
      await page.getByLabel('Saved draft revision').getByText(skill.saved_revision, { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Review and enable', exact: true }).click();
      await page.getByText('The saved procedure is reviewed and enabled.').waitFor();
      definition.skills = [
        { id: 'agent-authoring', revision: '1' },
        { id: skillId, revision: skill.saved_revision },
      ];
      definition.responseRule = 'tag';
      const card = await draft(
        {
          tool: 'agents.draft',
          agent: 'new',
          input: { expectedSoulRevision: initial.commit, owningTeamId: teamId, definition },
        },
        'agent',
      );
      const command = (
        await db.platform.query(`SELECT id FROM ${table('tf_agent_commands')} WHERE agent_id=$1`, [agentId])
      ).rows[0];
      for (let n = 0; ; n++) {
        const state = (
          await db.platform.query(`SELECT status FROM ${table('tf_agent_commands')} WHERE id=$1`, [command.id])
        ).rows[0].status;
        if (state === 'accepted') break;
        assert.notEqual(state, 'failed');
        if (n > 200) throw new Error('Temporal authoring publication timeout');
        await delay(50);
      }
      await card.getByRole('button', { name: 'Check draft status' }).click();
      await card
        .getByText('Agent saved. It stays off until an agent manager activates this revision.', { exact: true })
        .waitFor();
      assert.equal(
        (await db.platform.query(`SELECT count(*)::integer AS n FROM ${table('tf_agent_activations')}`)).rows[0].n,
        0,
      );
      const saved = (
        await db.platform.query(`SELECT projection FROM ${table('tf_agent_saved_revisions')} WHERE agent_id=$1`, [
          agentId,
        ])
      ).rows[0];
      assert.deepEqual((await readVerifiedProjection(soul, w.id, saved.projection)).skills, definition.skills);
      console.log(
        'PASS continuous browser chat skill draft, human save, admin review, agent draft, human save and real Soul publication with exact pins.',
      );
      return agentId;
    },
  };
}
