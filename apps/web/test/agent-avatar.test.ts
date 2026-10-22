import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentAvatar } from '../src/lib/agent-avatar.ts';

test('keeps each agent avatar stable', () => {
  assert.deepEqual(agentAvatar('agent_123'), agentAvatar('agent_123'));
  assert.match(
    agentAvatar('agent_123', 'https://avatars.example.test/').src,
    /^https:\/\/avatars\.example\.test\/avatar\/[a-z-]+\/[a-z]+\.svg$/,
  );
});

test('without an avatar origin agents keep their initial-letter avatar', () => {
  assert.equal(agentAvatar('agent_123', undefined).src, '');
});

test('spreads agents across objects and colors', () => {
  const avatars = Array.from({ length: 200 }, (_, i) => agentAvatar(`agent_${i}`));
  assert.ok(new Set(avatars.map(a => a.object)).size > 60);
  assert.equal(new Set(avatars.map(a => a.color)).size, 8);
});
