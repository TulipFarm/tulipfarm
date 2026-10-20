import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentDefinitionSchema } from '../src/contracts.ts';
import { chatSkills } from '../src/chat-skills.ts';
import { listSkills, readSkill } from '../src/skills.ts';
import { runtimeReminder, toolSystemPrompt } from '../src/prompts.ts';

test('Planning is offered to the default chat, not to saved agents or specialists', () => {
  assert.equal(
    listSkills('chat').skills.some(skill => skill.id === 'planning'),
    true,
  );
  assert.equal(
    listSkills().skills.some(skill => skill.id === 'planning'),
    false,
  );
  assert.equal(readSkill('planning'), undefined);
  assert.ok(readSkill('planning', undefined, undefined, 'chat'));
  assert.throws(() =>
    agentDefinitionSchema.parse({
      name: 'Saved agent',
      instructions: 'Do the work.',
      tools: [],
      skills: [{ id: 'planning', revision: 'latest' }],
    }),
  );
  assert.match(runtimeReminder({ kind: 'tools' }), /"id":"planning"/);
});

test('explicit Planning accepts current and legacy built-in revisions without querying workspace skills', async () => {
  const tx = {
    client: {
      query: () => {
        throw new Error('Built-ins need no workspace skill lookup');
      },
    },
  };
  for (const revision of ['latest', '1']) {
    const skill = await chatSkills.resolve(tx, {}, { skillId: 'planning', revision });
    assert.equal(skill.skillId, 'planning');
    assert.equal(skill.revision, revision);
    assert.equal(skill.origin, 'built-in');
    assert.match(skill.instructions, /Research before writing executable tasks/);
    assert.match(skill.instructions, /Verify the original request/);
  }
  assert.equal(await chatSkills.resolve(tx, {}, { skillId: 'planning', revision: 'unreviewed' }), null);
  assert.equal(
    await chatSkills.resolve(tx, {}, { skillId: '00000000-0000-4000-8000-000000000001', revision: 'latest' }),
    null,
  );
  assert.match(toolSystemPrompt, /load skills\.read\(planning\)/);
  assert.doesNotMatch(toolSystemPrompt, /Leave them unassigned|before you start the work/);
});
