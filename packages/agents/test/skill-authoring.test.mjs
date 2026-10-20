import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { readSkill } from '../dist/skills.js';
import { chatCallSchema, createChatTools } from '../dist/tools.js';

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
