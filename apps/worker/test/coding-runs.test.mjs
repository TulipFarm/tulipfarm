import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { TokenPlanError } from '@tulipfarm/integrations/token-plans';
import { codingRunServices } from '../src/coding-runs.ts';

function services(candidates, tokens) {
  const used = [];
  const asked = [];
  return {
    used,
    asked,
    value: codingRunServices(
      {},
      {
        subscriptions: {
          eligible: async (_workspaceId, provider, membershipId, use, preferred) => (
            asked.push([provider, membershipId, use, preferred]),
            candidates
          ),
          markUsed: async (_workspaceId, connectionId) => void used.push(connectionId),
        },
        credentials: () => ({
          accessToken: async (_workspaceId, connectionId) => {
            const token =
              tokens[candidates.find(candidate => candidate.connectionId === connectionId).ownerMembershipId];
            if (token instanceof Error) throw token;
            return token;
          },
          requireReconnect: async () => undefined,
        }),
        github: async () => null,
      },
    ),
  };
}

test('a coding run uses the first eligible plan that gives a token, in the resolver order', async () => {
  const [own, shared] = [randomUUID(), randomUUID()];
  const candidates = [
    { connectionId: 'own', ownerMembershipId: own, models: [], disabled: [] },
    { connectionId: 'shared', ownerMembershipId: shared, models: [], disabled: [] },
  ];
  const member = randomUUID();
  const { value, used, asked } = services(candidates, {
    [own]: new TokenPlanError('claude', 'reconnect-required'),
    [shared]: 'token',
  });
  assert.deepEqual(await value.plan(randomUUID(), member, 'claude', 'own'), {
    connectionId: 'shared',
    ownerMembershipId: shared,
    token: 'token',
  });
  assert.deepEqual(used, ['shared']);
  assert.deepEqual(asked, [['claude', member, 'coding', 'own']]);
  assert.equal(await value.hasPlan(randomUUID(), member, 'claude'), true);
});

test('a coding run has no plan while no plan gives a token', async () => {
  const owner = randomUUID();
  const candidate = { connectionId: 'c', ownerMembershipId: owner, models: [], disabled: [] };
  const signedOut = services([candidate], { [owner]: new TokenPlanError('copilot', 'reconnect-required') });
  assert.equal(await signedOut.value.plan(randomUUID(), randomUUID(), 'copilot'), null);
  assert.deepEqual(signedOut.used, []);
});
