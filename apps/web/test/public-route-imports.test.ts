import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { filesSearchSchema, viewerSearchSchema } from '../src/features/files/search.ts';
import {
  fileTypeSchema,
  libraryOwnerFilterSchema,
  librarySectionSchema,
  librarySortSchema,
} from '@tulipfarm/files/library-search-contracts';
import * as fileContracts from '@tulipfarm/files/contracts';
import { accountCallbackResultSchema, accountProtocolSchema } from '@tulipfarm/atlassian/callback-contracts';
import * as accountContracts from '@tulipfarm/atlassian/account-contracts';
import { workflowPageSearch } from '../src/features/workflows/page-search.ts';
import { agentTabValues } from '../src/features/agents/tab-values.ts';
import { agentTabs, agentTabValues as setupTabValues } from '../src/features/agents/setup.ts';

test('URL contracts retain shared values, validation, fallbacks and viewer cursor omission', () => {
  assert.equal(agentTabValues, setupTabValues);
  assert.deepEqual(
    agentTabValues,
    agentTabs.map(tab => tab.value),
  );
  assert.deepEqual(workflowPageSearch.parse({ view: 'runs', workflow: 'bad', run: 'bad' }), {
    view: 'runs',
    workflow: undefined,
    run: undefined,
  });
  assert.equal(fileTypeSchema, fileContracts.fileTypeSchema);
  assert.equal(libraryOwnerFilterSchema, fileContracts.libraryOwnerFilterSchema);
  assert.equal(librarySectionSchema, fileContracts.librarySectionSchema);
  assert.equal(librarySortSchema, fileContracts.librarySortSchema);
  const search = {
    section: 'google',
    q: 'invoice',
    scope: 'all',
    type: 'pdf',
    owner: 'others',
    modified: 'custom',
    from: '2026-10-01',
    to: '2026-10-11',
    sort: 'modified',
    order: 'desc',
    after: 'cursor',
  };
  assert.deepEqual(filesSearchSchema.parse(search), search);
  const { after: _after, ...viewer } = search;
  assert.deepEqual(viewerSearchSchema.parse(search), viewer);
  const invalid = filesSearchSchema.parse({
    section: 'unknown',
    folder: 'bad',
    q: 'x'.repeat(256),
    type: 'video',
    owner: 'bad',
    from: '2026-02-30',
    after: 'x'.repeat(4097),
  });
  assert.ok(Object.values(invalid).every(value => value === undefined));
  assert.equal(accountCallbackResultSchema, accountContracts.accountCallbackResultSchema);
  assert.equal(accountProtocolSchema, accountContracts.accountProtocolSchema);
  for (const outcome of ['connected', 'denied', 'error', 'sign-in-required']) {
    for (const protocol of accountProtocolSchema.options)
      assert.deepEqual(accountCallbackResultSchema.parse({ outcome, protocol, ignored: true }), { outcome, protocol });
  }
  assert.equal(accountCallbackResultSchema.safeParse({ outcome: 'connected', workspaceId: 'bad' }).success, false);
  assert.equal(accountCallbackResultSchema.safeParse({ outcome: 'unknown' }).success, false);
});

test('public route contracts do not initialize editors, query engines, model pricing, or Google actions', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      const result = next(specifier, context);
      if (/@rsql\\/|file-mentions|editor-extensions|google-api|model-(?:continuity|pricing|families)|(?:operation|lifecycle|account)-contracts|provider-sources|features\\/agents\\/setup|features\\/files\\/api|packages\\/files\\/(?:src|dist)\\/contracts/.test(specifier + ' ' + result.url)) {
        throw new Error('Feature runtime reached a public route contract: ' + specifier);
      }
      return result;
    } });
    const [drafts, tables, models, google, files, workflows, atlassian, agents] = await Promise.all([
      import('./src/features/chat/draft-files.ts'),
      import('./src/features/tables/table-search.ts'),
      import('@tulipfarm/config/model-catalog'),
      import('@tulipfarm/google-workspace/callback-contracts'),
      import('./src/features/files/search.ts'),
      import('./src/features/workflows/page-search.ts'),
      import('@tulipfarm/atlassian/callback-contracts'),
      import('./src/features/agents/tab-values.ts'),
    ]);
    console.log(JSON.stringify({
      cleanup: typeof drafts.clearDraftFiles,
      query: tables.tableListSearchSchema.parse({ q: 5 }),
      models: models.modelCatalogSchema.parse({ families: [] }),
      callback: google.googleCallbackResultSchema.parse({ outcome: 'consent-denied' }),
      files: files.filesSearchSchema.parse({ section: 'google' }),
      workflow: workflows.workflowPageSearch.parse({ view: 'settings' }),
      account: atlassian.accountCallbackResultSchema.parse({ outcome: 'denied' }),
      tab: agents.agentTabValues[0],
    }));
  `,
    ],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    cleanup: 'function',
    query: { q: '5' },
    models: { families: [], imageModels: [] },
    callback: { outcome: 'consent-denied' },
    files: { section: 'google' },
    workflow: { view: 'settings' },
    account: { outcome: 'denied' },
    tab: 'overview',
  });
});
