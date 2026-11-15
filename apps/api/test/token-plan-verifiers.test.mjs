import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.ANTHROPIC_API_KEY ??= 'test-key';
const { PlanSessionError } = await import('@tulipfarm/agents/plan-sessions');
const { claudeVerifier, copilotVerifier } = await import('../src/token-plans.ts');

test('a Claude plan offers the models Claude Code lists and checks the sign-in on the cheapest one', async () => {
  const checked = [];
  const verify = claudeVerifier(
    async (token, model) => void checked.push([token, model]),
    async () => [
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
      { id: 'claude-fable-5-2', name: 'Claude Fable' },
      { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
    ],
  );
  assert.deepEqual(await verify('sk-ant-oat01-token'), {
    models: [
      { slug: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
      { slug: 'claude-fable-5-2', label: 'Claude Fable 5.2' },
      { slug: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
    ],
  });
  assert.deepEqual(checked, [['sk-ant-oat01-token', 'claude-haiku-5-5']]);
});

test("a Copilot plan past GitHub's API limit offers the catalog's models as a fallback", async () => {
  const verify = copilotVerifier(
    async () => {
      throw new PlanSessionError(429, 'plan_usage_limit', 'API rate limit exceeded', 60);
    },
    async () => new Response(JSON.stringify({ login: 'octocat' })),
  );
  const checked = await verify('ghu_token');
  assert.equal(checked.fallback, true);
  assert.equal(checked.account, 'octocat');
  assert.ok(checked.models.length > 0);
});
