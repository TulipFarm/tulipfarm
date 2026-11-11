import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createConversationExecutor } from '../../src/runtime.ts';
import { conversationFixture } from '../fixture.mjs';

test('directory reuse stays in the same chat and rechecks roster visibility', { timeout: 60000 }, async () => {
  const f = await conversationFixture();
  try {
    const w = f.workspace;
    const teamId = randomUUID();
    await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'Operations')`, [teamId]);
    const directory = {
      scope: 'workspace',
      workspaceMemberCount: 1,
      workspaceTeamCount: 1,
      memberCount: 1,
      members: [{ name: 'Sam', email: 'sam@example.com' }],
      teamCount: 1,
      teams: [
        {
          teamId,
          name: 'Operations',
          people: [{ name: 'Sam', role: 'manager' }],
          peopleCount: 1,
          peopleTruncated: false,
        },
      ],
      pendingInvitations: [{ email: 'next@example.com' }],
      pendingInvitationCount: 1,
      truncated: false,
    };
    const chatId = randomUUID();
    const otherChatId = randomUUID();
    for (const id of [chatId, otherChatId])
      await f.store.create(w.id, w.userId, { chatId: id, commandId: randomUUID() });
    const run = async (id, reply) => {
      const sent = await f.store.send(w.id, w.userId, id, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'List workspace teams.' }],
      });
      return createConversationExecutor(f.runtime, reply).process({
        workspaceId: w.id,
        conversationId: id,
        turnId: sent.turnId,
        generation: 0,
      });
    };
    assert.equal(
      await run(chatId, async ({ executeTool }) => {
        await executeTool('members.find', false, async () => ({ result: directory, sources: [] }), [], {
          tool: 'members.find',
        });
        return { text: 'Operations.', sources: [] };
      }),
      'completed',
    );
    assert.equal(
      await run(otherChatId, async ({ readWorkspaceDirectory }) => {
        assert.equal(await readWorkspaceDirectory(), undefined);
        return { text: 'No earlier lookup in this chat.', sources: [] };
      }),
      'completed',
    );
    assert.equal(
      await run(otherChatId, async ({ executeTool }) => {
        await executeTool(
          'members.find',
          false,
          async () => ({ result: { ...directory, scope: 'filtered' }, sources: [] }),
          [],
          { tool: 'members.find' },
        );
        return { text: 'Operations.', sources: [] };
      }),
      'completed',
    );
    assert.equal(
      await run(otherChatId, async ({ readWorkspaceDirectory }) => {
        assert.equal(await readWorkspaceDirectory(), undefined, 'explicitly filtered output is not a full receipt');
        return { text: 'A new lookup is needed.', sources: [] };
      }),
      'completed',
    );
    assert.equal(
      await run(otherChatId, async ({ executeTool }) => {
        await executeTool('members.find', false, async () => ({ result: directory, sources: [] }), [], {
          tool: 'members.find',
          query: 'Operations',
        });
        return { text: 'Operations.', sources: [] };
      }),
      'completed',
    );
    assert.equal(
      await run(otherChatId, async ({ readWorkspaceDirectory }) => {
        assert.equal(await readWorkspaceDirectory(), undefined, 'a filtered result is not the whole directory');
        return { text: 'A new lookup is needed.', sources: [] };
      }),
      'completed',
    );
    assert.equal(
      await run(chatId, async ({ readWorkspaceDirectory }) => {
        assert.deepEqual(await readWorkspaceDirectory(), directory);
        return { text: 'Operations.', sources: [] };
      }),
      'completed',
    );
    assert.equal(
      await run(chatId, async ({ executeTool }) => {
        await executeTool(
          'members.find',
          false,
          async () => ({ result: { ...directory, scope: 'filtered', teamCount: 0, teams: [] }, sources: [] }),
          [],
          { tool: 'members.find', query: 'No matches' },
        );
        return { text: 'No matching teams.', sources: [] };
      }),
      'completed',
    );
    assert.equal(
      await run(chatId, async ({ readWorkspaceDirectory }) => {
        assert.deepEqual(await readWorkspaceDirectory(), directory, 'a newer partial read does not replace a full one');
        return { text: 'Operations.', sources: [] };
      }),
      'completed',
    );
    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET role='member' WHERE id=$1`, [w.membershipId]);
    assert.equal(
      await run(chatId, async ({ readWorkspaceDirectory }) => {
        const retained = await readWorkspaceDirectory();
        assert.deepEqual(retained.teams, [{ teamId, name: 'Operations', people: 'not-visible' }]);
        assert.equal(retained.pendingInvitations, 'not-visible');
        assert.equal(retained.pendingInvitationCount, undefined);
        assert.ok(!JSON.stringify(retained).includes('next@example.com'));
        return { text: 'The team roster is not visible.', sources: [] };
      }),
      'completed',
    );
  } finally {
    await f.close();
  }
});
