import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import {
  sweepTableQueryTranslations,
  tableQueryTranslationCompatibility,
} from '@tulipfarm/agents/table-query-translator';
import { createTableSearchSweep } from '../src/table-cleanup.ts';

test('table search sweep pages ready workspaces, skips unmigrated ones and reports other failures', async () => {
  const ids = Array.from({ length: 12 }, () => randomUUID()).sort();
  const [old, broken] = ids;
  const pages = [],
    swept = [];
  const discover = async after => {
    pages.push(after);
    return after === null ? ids.slice(0, 10) : ids.slice(10);
  };
  const sweep = createTableSearchSweep(
    {
      transaction: async (workspaceId, compatibility, operation) => {
        assert.equal(compatibility, tableQueryTranslationCompatibility);
        assert.equal(operation, sweepTableQueryTranslations);
        if (workspaceId === old) throw new StorageUnavailableError('incompatible_version');
        if (workspaceId === broken) throw new Error('database unavailable');
        swept.push(workspaceId);
      },
    },
    discover,
  );

  await assert.rejects(sweep(), /table-search-sweep-retry/);
  assert.deepEqual(swept, ids.slice(2, 10));
  await sweep();
  assert.deepEqual(swept, ids.slice(2));
  await assert.rejects(sweep(), /table-search-sweep-retry/);
  assert.deepEqual(pages, [null, ids[9], null]);
});

test('an unmigrated workspace alone does not fail the sweep', async () => {
  const sweep = createTableSearchSweep(
    {
      transaction: async () => {
        throw new StorageUnavailableError('incompatible_version');
      },
    },
    async () => [randomUUID()],
  );
  await sweep();
});
