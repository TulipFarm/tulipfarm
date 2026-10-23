import assert from 'node:assert/strict';
import { test } from 'node:test';
import { githubDeliveryRetentionHours, pruneGitHubEventDeliveries } from '../src/event-retention.ts';

test('the retention setting defaults to six hours and accepts whole hours from 1 to 720', () => {
  assert.equal(githubDeliveryRetentionHours(undefined), 6);
  assert.equal(githubDeliveryRetentionHours(' '), 6);
  assert.equal(githubDeliveryRetentionHours('1'), 1);
  assert.equal(githubDeliveryRetentionHours(' 48 '), 48);
  assert.equal(githubDeliveryRetentionHours('720'), 720);
  for (const value of ['0', '721', '1.5', '-2', '6h', 'abc', '1e2'])
    assert.throws(() => githubDeliveryRetentionHours(value), /GITHUB_WEBHOOK_DELIVERY_RETENTION_HOURS/);
});

test('cleanup deletes in bounded batches until a batch comes back short', async () => {
  const fake = removed => {
    const calls = [];
    return {
      calls,
      query: async (text, values) => {
        calls.push({ text, values });
        return { rows: [{ removed: removed.shift() ?? 0 }] };
      },
    };
  };
  const draining = fake([500, 500, 12, 500]);
  assert.equal(await pruneGitHubEventDeliveries(draining, { retentionHours: 6 }), 1012);
  assert.equal(draining.calls.length, 3);
  assert.match(draining.calls[0].text, /app\.prune_github_event_deliveries/);
  assert.deepEqual(draining.calls[0].values, [6, 500]);

  const backlog = fake([500, 500, 500]);
  assert.equal(await pruneGitHubEventDeliveries(backlog, { retentionHours: 24, maxBatches: 2 }), 1000);
  assert.equal(backlog.calls.length, 2);
  assert.deepEqual(backlog.calls[1].values, [24, 500]);

  await assert.rejects(pruneGitHubEventDeliveries(fake([]), { retentionHours: 0 }));
  await assert.rejects(pruneGitHubEventDeliveries(fake([]), { retentionHours: 6, maxBatches: 0 }));
});
