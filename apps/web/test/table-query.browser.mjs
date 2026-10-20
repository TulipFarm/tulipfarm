import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

test(
  'table readers reuse pages and relationships; accepted writes invalidate after editor unmount',
  { timeout: 90_000 },
  async () => {
    const server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      cacheDir: 'node_modules/.vite-table-query-browser',
      optimizeDeps: {
        include: [
          'react',
          'react-dom/client',
          '@tanstack/react-query',
          'zod',
          'better-auth/react',
          'better-auth/client/plugins',
        ],
      },
      server: { port: 0 },
      plugins: [
        {
          name: 'table-query-test',
          configureServer(server) {
            server.middlewares.use('/table-query-test', async (_request, response) => {
              response.setHeader('Content-Type', 'text/html');
              response.end(await server.transformIndexHtml('/table-query-test', '<html><body></body></html>'));
            });
          },
        },
      ],
    });
    await server.listen();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`${server.resolvedUrls.local[0]}table-query-test`);
      const result = await page.evaluate(async () => {
        const {
          React,
          createRoot,
          SessionQueryProvider,
          WorkspaceQueryProvider,
          useTableList,
          useTableRows,
          useTableRelationship,
          useRecordMutation,
          useTableProposalCommand,
          useFeatureContext,
          useTableChanges,
          tableApi,
          proposalApi,
        } = await import('/test/table-query-fixture.tsx');
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const wait = async predicate => {
          for (let i = 0; i < 400 && !predicate(); i++) await sleep(10);
          if (!predicate()) throw new Error(`Timed out: ${document.body.textContent}`);
        };
        const id = '11111111-1111-4111-8111-111111111111';
        const recordId = '22222222-2222-4222-8222-222222222222';
        const fieldId = '33333333-3333-4333-8333-333333333333';
        const revision = 'a'.repeat(40);
        const table = {
          id,
          revision,
          definition: {
            formatVersion: 2,
            id,
            owningTeamId: id,
            label: 'Customers',
            fields: [{ id: fieldId, label: 'Name', kind: 'text', required: true, maxLength: 100 }],
            uniqueKeys: [],
          },
        };
        let value = 'Original',
          releaseWrite,
          releaseProposal,
          denied = false;
        const calls = { list: 0, detail: 0, first: 0, second: 0, writes: 0 };
        window.fetch = async (url, init) => {
          const path = new URL(url);
          if (init?.method === 'PUT') {
            await new Promise(resolve => {
              releaseProposal = resolve;
            });
            value = 'Proposal changed';
            return Response.json({
              id,
              digest: 'a'.repeat(64),
              status: 'completed',
              decision: 'approve',
              cancelled: false,
              expired: false,
              plans: [{ tableId: id, receipt: { status: 'completed', executionId: id, revision } }],
            });
          }
          if (init?.method === 'POST') {
            calls.writes++;
            await new Promise(resolve => {
              releaseWrite = resolve;
            });
            value = 'Changed';
            return Response.json({
              kind: 'available',
              id: recordId,
              token: recordId,
              values: { [fieldId]: { kind: 'text', value } },
            });
          }
          if (path.pathname.endsWith('/tables')) {
            calls.list++;
            return Response.json({ tables: [{ ...table, appliedAt: null, recordCount: '1' }], nextCursor: null });
          }
          if (path.pathname.endsWith('/rows/page')) {
            if (path.searchParams.has('after')) calls.second++;
            else calls.first++;
            return Response.json({
              records: [{ id: recordId, token: recordId, values: { [fieldId]: { kind: 'text', value } } }],
              total: path.searchParams.has('after') ? null : '1',
              nextCursor: null,
            });
          }
          calls.detail++;
          if (denied) return Response.json({ error: 'table-not-found' }, { status: 404 });
          return Response.json({
            id,
            saved: null,
            applied: { revision, definition: table.definition, appliedAt: null },
            rowPermissions: { create: true, update: true, delete: true },
          });
        };
        const api = tableApi('workspace');
        const scope = { kind: 'workspace', userId: 'alice', workspaceId: 'workspace', membershipId: 'member' };
        const identity = { userId: 'alice', sessionId: 'session' };
        const admitted = () => true,
          subscribe = () => () => {};
        const root = createRoot(document.body.appendChild(document.createElement('div')));
        let submit, submitProposal, runtime, change;
        function Records({ after }) {
          const read = useTableRows(api, table, {}, after);
          return React.createElement('output', null, JSON.stringify(read.state));
        }
        function List() {
          runtime = useFeatureContext().runtime;
          change = useTableChanges();
          const read = useTableList(api);
          return React.createElement('output', null, JSON.stringify(read.state));
        }
        function Relationship() {
          const read = useTableRelationship(api, id);
          return React.createElement('output', null, JSON.stringify(read.state));
        }
        function Editor() {
          submit = useRecordMutation(api, () => {}).submit;
          return null;
        }
        const proposal = proposalApi('workspace', id, id);
        function ProposalEditor() {
          submitProposal = useTableProposalCommand(proposal, { chatId: id, proposalId: id }).submit;
          return null;
        }
        const render = (after, editor = true) =>
          root.render(
            React.createElement(
              SessionQueryProvider,
              { identity },
              React.createElement(
                WorkspaceQueryProvider,
                { scope, admitted, subscribe },
                React.createElement(List),
                React.createElement(List),
                React.createElement(Records, { after }),
                React.createElement(Relationship),
                editor && React.createElement(Editor),
                editor && React.createElement(ProposalEditor),
              ),
            ),
          );
        const start = performance.now();
        render(undefined);
        await wait(
          () =>
            document.querySelectorAll('output').length === 4 &&
            [...document.querySelectorAll('output')].every(node => node.textContent.includes('ready')),
        );
        const coldMs = performance.now() - start;
        const cold = { ...calls };
        window.dispatchEvent(new Event('focus'));
        await sleep(50);
        const focus = { ...calls };
        render(recordId);
        await wait(() => calls.second === 1);
        await sleep(20);
        const revisitStart = performance.now();
        render(undefined);
        await sleep(30);
        const revisit = { ...calls },
          revisitMs = performance.now() - revisitStart;
        const pending = submit({
          kind: 'update',
          requestId: id,
          tableId: id,
          revision,
          recordId,
          expectedToken: recordId,
          values: { [fieldId]: { kind: 'text', value: 'Changed' } },
        });
        await wait(() => !!releaseWrite);
        render(undefined, false);
        await sleep(20);
        releaseWrite();
        await pending;
        await wait(() => document.body.textContent.includes('Changed'));
        const afterWrite = { ...calls };
        render(recordId, false);
        await wait(() => calls.second === 2);
        const afterRevisit = { ...calls };
        denied = true;
        await change.definition(id);
        await wait(() => !document.body.textContent.includes('Changed'));
        const retainedRecords = runtime.client
          .getQueryCache()
          .getAll()
          .filter(query => query.queryKey.includes('detail'))
          .some(query => query.state.data !== undefined);
        const listSurvives = document.body.textContent.includes('Customers');
        denied = false;
        await change.definition(id);
        await wait(() => document.body.textContent.includes('Changed'));
        render(undefined);
        await sleep(20);
        const proposalPending = submitProposal({ commandId: id, digest: 'a'.repeat(64), decision: 'approve' });
        await wait(() => !!releaseProposal);
        render(undefined, false);
        await sleep(20);
        releaseProposal();
        await proposalPending;
        await wait(() => document.body.textContent.includes('Proposal changed'));
        const proposalRefreshedAfterUnmount = document.body.textContent.includes('Proposal changed');
        root.unmount();
        return {
          cold,
          focus,
          revisit,
          afterWrite,
          afterRevisit,
          coldMs,
          revisitMs,
          retainedRecords,
          listSurvives,
          proposalRefreshedAfterUnmount,
        };
      });
      assert.deepEqual(result.cold, { list: 1, detail: 1, first: 1, second: 0, writes: 0 });
      assert.deepEqual(result.focus, result.cold);
      assert.deepEqual(result.revisit, { list: 1, detail: 1, first: 1, second: 1, writes: 0 });
      assert.deepEqual(result.afterWrite, { list: 2, detail: 2, first: 2, second: 1, writes: 1 });
      assert.deepEqual(result.afterRevisit, { list: 2, detail: 2, first: 2, second: 2, writes: 1 });
      assert.equal(result.retainedRecords, false, 'Definition denial removes all retained row pages');
      assert.equal(result.listSurvives, true, 'A missing table does not revoke workspace lists');
      assert.equal(
        result.proposalRefreshedAfterUnmount,
        true,
        'A command receipt updates tables even without a mounted proposal reader',
      );
      console.log('Table query request/timing proof:', JSON.stringify(result));
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
