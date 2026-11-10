import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { readSkill } from '../dist/skills.js';
import { chatCallSchema, createChatTools } from '../dist/tools.js';
import { inferWithTools } from '../src/inference.ts';
import { nativeRoutes, nativeReply, use, offeredTools, isCompletionRequest, selectReply } from './native-fixture.mjs';

for (const model of ['grok-4.3', 'Kimi-K2.6'])
  test(`${model} drafts a plain procedure in one turn after reading the authoring guide`, async t => {
    let step = 0;
    const executed = [];
    const definition = {
      name: 'Weekly summary',
      description: 'Summarize weekly work when asked.',
      instructions: 'List completed work, open questions, and next actions.',
    };
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const body = JSON.parse(init.body);
      if (isCompletionRequest(body))
        return Response.json(
          selectReply('azure', { status: 'waiting', reason: 'The exact package needs human approval.' }),
        );
      if (step > 0) assert.ok(offeredTools('azure', body).some(tool => tool.name === 'skills_draft'));
      return Response.json(
        nativeReply(
          'azure',
          [
            { calls: [use('skills.read', { skillId: 'workspace-skill-authoring' })] },
            { calls: [use('skills.workspace')] },
            { calls: [use('skills.draft', { skillId: 'new', input: { expectedVersion: 0, definition } })] },
            { text: 'Review the proposed weekly summary skill before installing it.' },
          ][step++],
        ),
      );
    });
    const result = await inferWithTools(
      { ...nativeRoutes.azure, model },
      [
        {
          role: 'user',
          text: 'Create a weekly summary skill that lists completed work, open questions, and next actions.',
        },
      ],
      async call => {
        executed.push(call.tool);
        if (call.tool === 'skills.read') return readSkill(call.skillId);
        if (call.tool === 'skills.workspace') return { workspace: [], nextCursor: null };
        assert.equal(call.tool, 'skills.draft');
        assert.deepEqual(call.input.definition, definition);
        return { importId: '00000000-0000-4000-8000-000000000001', status: 'pending-review', receipts: [] };
      },
    );
    assert.deepEqual(executed, ['skills.read', 'skills.workspace', 'skills.draft']);
    assert.match(result.text, /drafted the skill/);
    assert.equal(step, 4);
  });

for (const model of ['grok-4.3', 'Kimi-K2.6'])
  for (const status of ['pending-review', 'ready'])
    test(`${model} keeps its final reply consistent with a ${status} skill card`, async t => {
      for (let run = 0; run < 3; run++) {
        let step = 0;
        const definition = {
          name: 'Weekly summary',
          description: 'Summarize weekly work.',
          instructions: 'List completed work and next actions.',
        };
        t.mock.method(globalThis, 'fetch', async (_url, init) => {
          const body = JSON.parse(init.body);
          if (isCompletionRequest(body))
            return Response.json(selectReply('azure', { status: 'completed', reason: 'The model stopped.' }));
          return Response.json(
            nativeReply(
              'azure',
              [
                { calls: [use('skills.read', { skillId: 'workspace-skill-authoring' })] },
                { calls: [use('skills.draft', { skillId: 'new', input: { expectedVersion: 0, definition } })] },
                { text: 'I could not open a review card for this skill.' },
              ][step++] ?? { text: 'No review card was created.' },
            ),
          );
        });
        const result = await inferWithTools(
          { ...nativeRoutes.azure, model },
          [{ role: 'user', text: 'Create a weekly summary skill that lists completed work and next actions.' }],
          async call => {
            if (call.tool === 'skills.read') return readSkill(call.skillId);
            assert.equal(call.tool, 'skills.draft');
            return { importId: '00000000-0000-4000-8000-000000000001', status, receipts: [] };
          },
        );
        assert.equal(
          result.text,
          status === 'ready'
            ? "I've drafted the skill, and it's ready for your review. Check the card, then select **Install and enable**."
            : "I've drafted the skill. When its safety review finishes, select **Install and enable** on the card.",
        );
        assert.equal(step, 3, 'A saved review must not cause another drafting or correction loop.');
        t.mock.restoreAll();
      }
    });

test('the chat creator can load pinned writing and example guides on demand', async () => {
  const creator = readSkill('workspace-skill-authoring');
  assert.equal(creator.revision, 'latest');
  assert.equal(creator.resources.length, 2);
  assert.equal(creator.resource, undefined);
  const tools = createChatTools({
    transaction() {
      throw new Error('Bundled guides must not access workspace data');
    },
  });

  for (const reference of creator.resources) {
    const call = chatCallSchema.parse({ tool: 'skills.read', skillId: creator.id, resource: reference.path });
    const guide = await tools.invoke(
      {
        workspaceId: '00000000-0000-4000-8000-000000000001',
        actor: { kind: 'human', membershipId: '00000000-0000-4000-8000-000000000002', userId: 'fixture' },
        callId: '00000000-0000-4000-8000-000000000003',
      },
      call,
    );
    assert.equal(createHash('sha256').update(guide.resource.text).digest('hex'), reference.digest);
  }
  assert.match(creator.instructions, /Run tests only when asked/);
  assert.match(creator.instructions, /Never treat chat text as approval/);
  assert.equal(
    chatCallSchema.safeParse({ tool: 'skills.approve', importId: '00000000-0000-4000-8000-000000000001' }).success,
    false,
  );
});

test('workspace reads with a malformed or absent revision give a safe correction without querying storage', async () => {
  const tools = createChatTools({
    transaction() {
      throw new Error('Invalid pins must not query storage');
    },
  });
  for (const revision of [undefined, 'latest', '1', 'not-a-revision']) {
    const result = await tools.invoke(
      {
        workspaceId: '00000000-0000-4000-8000-000000000001',
        actor: { kind: 'human', membershipId: '00000000-0000-4000-8000-000000000002', userId: 'fixture' },
        callId: '00000000-0000-4000-8000-000000000003',
      },
      chatCallSchema.parse({
        tool: 'skills.read',
        skillId: '00000000-0000-4000-8000-000000000004',
        ...(revision ? { revision } : {}),
      }),
    );
    assert.equal(result.error, 'skill-revision-required');
    assert.match(result.instruction, /skills.workspace/);
    assert.match(result.instruction, /64/);
  }
});
