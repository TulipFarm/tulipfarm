import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { planCompatibility } from '@tulipfarm/agents/plans';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { createPlanComposition } from '../src/plan-composition.ts';

test('plan recovery treats a workspace without the plan migrations as having nothing to recover', async () => {
  let failure = null;
  const runtime = {
    transaction: async (_workspaceId, compatibility) => {
      if (failure) throw failure;
      assert.equal(compatibility.minimum, planCompatibility.minimum);
      throw new StorageUnavailableError('incompatible_version');
    },
  };
  const woken = [];
  const { activities } = createPlanComposition({
    runtime,
    discover: async () => [],
    wakePlan: async (_workspaceId, planId) => void woken.push(planId),
    wakeTask: async () => {},
  });
  assert.equal(await activities.recoverAgentPlanPage(randomUUID(), randomUUID()), null);
  assert.deepEqual(woken, []);

  failure = new StorageUnavailableError('wait_timeout');
  await assert.rejects(activities.recoverAgentPlanPage(randomUUID(), randomUUID()), /plan-recovery-unavailable/);
});
