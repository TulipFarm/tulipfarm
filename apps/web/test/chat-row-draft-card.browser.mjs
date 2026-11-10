import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { createWorkspaceFixture, serveWorkspaceShellEvent, workspaceShellReads } from './workspace.fixture.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { membership, credits } from './chat-query.fixture.mjs';

const chatId = '12121212-1212-4212-8212-121212121212';
const tableId = '44444444-4444-4444-8444-444444444444';
const noteField = '55555555-5555-4555-8555-555555555555';
const keyField = '54545454-5454-4454-8454-545454545454';
const statusField = '56565656-5656-4656-8656-565656565656';
const openOption = '57575757-5757-4757-8757-575757575757';
const recordId = '58585858-5858-4858-8858-585858585858';
const createDraft = '14141414-1414-4414-8414-141414141414';
const updateDraft = '15151515-1515-4515-8515-151515151515';
const deleteDraft = '16161616-1616-4616-8616-161616161616';
const batchDraft = '18181818-1818-4818-8818-181818181818';
const updateBatchDraft = '20202020-2020-4020-8020-202020202020';
const archivedDraft = '21212121-2121-4121-8121-212121212121';
const unavailableDraft = '22222222-2222-4222-8222-222222222222';
const revision = 'a'.repeat(40),
  token = '59595959-5959-4959-8959-595959595959';
const rowTable = {
  name: 'Support tickets',
  labelFieldIds: [keyField],
  fields: [
    { id: keyField, label: 'Key', kind: 'text' },
    { id: noteField, label: 'Note', kind: 'text' },
    { id: statusField, label: 'Status', kind: 'single-select', options: [{ id: openOption, label: 'Open' }] },
  ],
};
const tool = (id, name) => ({
  id,
  tool: name,
  status: 'completed',
  activity: null,
  presentation: { label: 'Changing a row', brand: null },
  web: null,
  rowDraftId: id,
});
const view = (id, input, extra = {}, reason) => ({
  id,
  digest: 'd'.repeat(64),
  status: 'pending',
  outcome: null,
  agentChange: null,
  proposal: { kind: 'row', input, ...(reason && { reason }) },
  rowTable,
  rowCurrent: null,
  ...extra,
});

test('row review drafts show the exact change and act only on the member decision', { timeout: 120000 }, async () => {
  const { workspace, session } = createWorkspaceFixture({ slug: 'row-reviews', name: 'Operations' });
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const browser = await chromium.launch({
    args: process.env.ROW_DRAFT_CDP_PORT ? [`--remote-debugging-port=${process.env.ROW_DRAFT_CDP_PORT}`] : [],
  });
  const shots = process.env.ROW_DRAFT_SCREENSHOTS;
  try {
    for (const mobile of [false, true]) {
      const drafts = {
        [createDraft]: view(createDraft, {
          tool: 'rows.create',
          tableId,
          expectedAppliedRevision: revision,
          values: {
            [noteField]: { kind: 'text', value: 'Refund order 1042' },
            [statusField]: { kind: 'single-select', optionId: openOption },
          },
        }),
        [updateDraft]: view(
          updateDraft,
          {
            tool: 'rows.update',
            tableId,
            expectedAppliedRevision: revision,
            recordId,
            expectedToken: token,
            values: { [noteField]: { kind: 'text', value: 'Escalated' } },
          },
          { rowCurrent: { [noteField]: { kind: 'text', value: 'Waiting' } } },
        ),
        [deleteDraft]: view(
          deleteDraft,
          { tool: 'rows.delete', tableId, expectedAppliedRevision: revision, recordId, expectedToken: token },
          { status: 'stale', rowCurrent: { [noteField]: { kind: 'text', value: 'Waiting' } } },
        ),
        [batchDraft]: view(
          batchDraft,
          {
            tool: 'rows.create.batch',
            tableId,
            expectedAppliedRevision: revision,
            rows: Array.from({ length: 6 }, (_, index) => ({
              values: { [noteField]: { kind: 'text', value: `Order ${index + 1}` } },
            })),
          },
          {},
          'too-many-rows',
        ),
        [updateBatchDraft]: view(
          updateBatchDraft,
          {
            tool: 'rows.update.batch',
            tableId,
            expectedAppliedRevision: revision,
            rows: Array.from({ length: 6 }, (_, index) => ({
              recordId: `60606060-6060-4060-8060-60606060606${index}`,
              expectedToken: token,
              values: { [noteField]: { kind: 'text', value: `Resolved ${index + 1}` } },
            })),
          },
          {
            rowCurrents: Object.fromEntries(
              Array.from({ length: 6 }, (_, index) => [
                `60606060-6060-4060-8060-60606060606${index}`,
                {
                  [keyField]: { kind: 'text', value: `T-${index + 1}` },
                  [noteField]: { kind: 'text', value: `Waiting ${index + 1}` },
                },
              ]),
            ),
          },
          'too-many-rows',
        ),
      };
      drafts[batchDraft].proposal.written = {
        count: 2,
        rows: ['A', 'B'].map((name, index) => ({
          recordId: `5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5${index}`,
          values: { [noteField]: { kind: 'text', value: `Order ${name}` } },
        })),
      };
      drafts[updateBatchDraft].proposal.before = drafts[updateBatchDraft].rowCurrents;
      drafts[updateBatchDraft].proposal.written = { count: 1, rows: [] };
      drafts[archivedDraft] = view(
        archivedDraft,
        drafts[batchDraft].proposal.input,
        { status: 'stale', rowTable: { ...rowTable, name: 'Archived tickets', archived: true } },
        'too-many-rows',
      );
      drafts[unavailableDraft] = view(
        unavailableDraft,
        {
          ...drafts[batchDraft].proposal.input,
          rows: [
            { values: { [noteField]: { kind: 'text', value: 'Order 1' } } },
            {
              values: {
                [keyField]: { kind: 'text', value: 'T-2' },
                [noteField]: { kind: 'text', value: 'Order 2' },
              },
            },
          ],
        },
        { status: 'stale', rowTable: null },
        'too-many-rows',
      );
      drafts[unavailableDraft].proposal.written = {
        count: 1,
        rows: [{ recordId, values: { [keyField]: { kind: 'text', value: 'T-0' } } }],
      };
      const decisions = [];
      const context = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
        hasTouch: mobile,
        isMobile: mobile,
        colorScheme: mobile ? 'dark' : 'light',
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const chat = {
        id: chatId,
        title: 'Row drafts',
        titleRevision: 1,
        titleManual: false,
        archived: false,
        activityAt: '2026-10-11T10:00:00.000000Z',
        createdAt: '2026-10-11T10:00:00.000000Z',
        projectId: null,
      };
      const history = [
        {
          id: '13131313-1313-4313-8313-131313131313',
          sequence: 1,
          author: 'human',
          createdAt: '2026-10-11T10:00:01.000Z',
          parts: [{ kind: 'text', text: 'Summarize https://example.com/page.' }],
          turn: { id: '88888888-8888-4888-8888-888888888888', status: 'completed', generation: 0 },
          tools: [
            tool(archivedDraft, 'rows.create.batch'),
            tool(unavailableDraft, 'rows.create.batch'),
            tool(createDraft, 'rows.create'),
            tool(updateDraft, 'rows.update'),
            tool(deleteDraft, 'rows.delete'),
            tool(batchDraft, 'rows.create.batch'),
            tool(updateBatchDraft, 'rows.update.batch'),
          ],
          calendarResults: [],
        },
        {
          id: '17171717-1717-4717-8717-171717171717',
          sequence: 2,
          author: 'assistant',
          createdAt: '2026-10-11T10:00:02.000Z',
          parts: [{ kind: 'text', text: 'Review the row changes.' }],
          turn: null,
          tools: [],
          calendarResults: [],
        },
        {
          id: '19191919-1919-4919-8919-191919191919',
          sequence: 3,
          author: 'human',
          createdAt: '2026-10-11T10:00:03.000Z',
          parts: [{ kind: 'text', text: 'Just add them one at a time.' }],
          turn: { id: '89898989-8989-4989-8989-898989898989', status: 'completed', generation: 0 },
          tools: [
            {
              ...tool('1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a', 'rows.create'),
              rowDraftId: undefined,
              waitingRowDraft: { id: batchDraft, table: 'Support tickets' },
            },
          ],
          calendarResults: [],
        },
      ];
      await page.route('**/v1/**', async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const method = request.method();
        if (await serveWorkspaceShellEvent(route, workspace)) return;
        const shell = workspaceShellReads(workspace.id).find(([url]) => url === path);
        if (shell) return route.fulfill({ json: shell[1] });
        if (path === '/v1/auth/get-session') return route.fulfill({ json: session });
        if (path === '/v1/user/visit') return route.fulfill({ json: { firstSession: false } });
        if (path === '/v1/workspaces') return route.fulfill({ json: [workspace] });
        if (path === `/v1/workspaces/${workspace.slug}`) return route.fulfill({ json: workspace });
        if (path.endsWith('/governance/me')) return route.fulfill({ json: membership });
        if (path.endsWith('/credits')) return route.fulfill({ json: credits });
        if (path.endsWith('/model-catalog')) return route.fulfill({ json: chatCatalog });
        if (path.endsWith('/google-workspace/availability')) return route.fulfill({ json: { configured: false } });
        if (path.endsWith('/google-workspace')) return route.fulfill({ json: { status: 'disconnected' } });
        if (path.endsWith('/projects')) return route.fulfill({ json: [] });
        if (path.endsWith('/google-workspace/operations/proposals'))
          return route.fulfill({ json: { proposals: [], nextCursor: null } });
        if (path.endsWith('/workspace-mcp/capabilities'))
          return route.fulfill({ status: 404, json: { error: 'not-found' } });
        if (path.endsWith('/candidates')) return route.fulfill({ json: [] });
        if (path.endsWith('/conversations') && method === 'GET')
          return route.fulfill({ json: { chats: [chat], nextCursor: null } });
        const conversation = /\/conversations\/([\w-]+)(\/.*)?$/.exec(path);
        if (conversation) {
          const [, , rest = ''] = conversation;
          const draft = /^\/drafts\/([\w-]+)(\/decision)?$/.exec(rest);
          if (method === 'GET' && draft && !draft[2] && drafts[draft[1]])
            return route.fulfill({ json: drafts[draft[1]] });
          if (method === 'PUT' && draft?.[2] && drafts[draft[1]]) {
            const body = request.postDataJSON();
            decisions.push({ id: draft[1], decision: body.decision, digest: body.digest });
            const current = drafts[draft[1]];
            const outcome =
              body.decision === 'dismiss'
                ? { kind: 'dismissed' }
                : {
                    kind: 'row',
                    operation: current.proposal.input.tool.slice(5).replace('.batch', ''),
                    recordId: current.proposal.input.recordId ?? draft[1],
                  };
            drafts[draft[1]] = { ...current, outcome, status: body.decision === 'dismiss' ? 'dismissed' : 'saved' };
            return route.fulfill({ json: outcome });
          }
          if (method === 'GET' && rest === '/messages')
            return route.fulfill({ json: { messages: history, nextBefore: null, hasGitHubProposals: false } });
          if (method === 'GET' && !rest) return route.fulfill({ json: chat });
          if (method === 'GET') return route.fulfill({ json: [] });
        }
        if (path === '/v1/feature-flags') return route.fulfill({ json: {} });
        if (path.endsWith('/integrations')) return route.fulfill({ json: { integrations: [] } });
        if (path.endsWith('/github/accounts')) return route.fulfill({ json: { configured: true, accounts: [] } });
        if (path.endsWith(`/github/chats/${chatId}/selection`))
          return route.fulfill({ json: { accountId: null, generation: null, version: 0 } });
        if (path.endsWith(`/github/chats/${chatId}/batches`)) return route.fulfill({ json: { batches: [] } });
        if (path.endsWith('/system-package-installations'))
          return route.fulfill({ json: { installations: [], nextCursor: null } });
        if (path.endsWith('/governance')) return route.fulfill({ status: 404, json: { error: 'not-found' } });
        throw new Error(`Unexpected API request ${method} ${path}`);
      });
      try {
        await page.goto(`${server.resolvedUrls.local[0]}${workspace.slug}/chat/${chatId}`, { timeout: 60000 });
        const cards = page.locator('[id^="row-draft-"]');
        await cards.nth(4).waitFor({ state: 'attached', timeout: 60000 });
        const created = cards.filter({ hasText: 'Add a row in Support tickets' });
        const updated = cards.filter({ hasText: 'Update a row in Support tickets' });
        const deleted = cards.filter({ hasText: 'Delete a row in Support tickets' });
        const batch = cards.filter({ hasText: 'Add 6 rows in Support tickets' });
        const updates = cards.filter({ hasText: 'Update 6 rows in Support tickets' });
        const archived = page.locator(`#row-draft-${archivedDraft}`);
        const unavailable = page.locator(`#row-draft-${unavailableDraft}`);
        await archived.scrollIntoViewIfNeeded();
        await archived.getByText('Add 6 rows in Archived tickets', { exact: true }).waitFor();
        await archived.getByText('Out of date', { exact: true }).waitFor();
        await archived.getByText('Note: Order 6', { exact: true }).waitFor();
        await archived
          .getByRole('status')
          .filter({ hasText: 'Archived tickets was archived after this draft' })
          .waitFor();
        assert.equal(await archived.getByRole('button', { name: /Approve/ }).count(), 0);
        const capture = async (card, name) => {
          if (!shots) return;
          await card.scrollIntoViewIfNeeded();
          const path = `${shots}/${name}-${mobile ? 'mobile-dark' : 'desktop-light'}.png`;
          if (process.env.ROW_DRAFT_CDP_PORT)
            await promisify(execFile)('agent-browser', ['--cdp', process.env.ROW_DRAFT_CDP_PORT, 'screenshot', path]);
          else await card.screenshot({ path });
        };
        await capture(archived, 'archived-row-draft');
        await unavailable.scrollIntoViewIfNeeded();
        await unavailable.getByText('Add 2 rows in a table you cannot see', { exact: true }).waitFor();
        await unavailable.getByText('Out of date', { exact: true }).waitFor();
        await unavailable.getByText('Field 1: Order 1', { exact: true }).waitFor();
        await unavailable.getByText('Field 2: T-2 · Field 1: Order 2', { exact: true }).waitFor();
        await unavailable.getByText('Field 2: T-0', { exact: true }).waitFor();
        assert.equal(await unavailable.getByRole('button', { name: /Approve/ }).count(), 0);
        const summary = await unavailable.innerText();
        assert.doesNotMatch(summary, new RegExp([tableId, noteField, keyField].join('|')));
        await capture(unavailable, 'unavailable-row-draft');
        await updates.scrollIntoViewIfNeeded();
        await updates.getByText('Updates 6 existing rows together', { exact: true }).waitFor();
        await updates.getByText('Note: Resolved 6', { exact: true }).waitFor();
        await updates.getByText('Before Waiting 6', { exact: true }).waitFor();
        await updates.getByText('T-1', { exact: true }).waitFor();
        await updates.getByText('T-6', { exact: true }).waitFor();
        assert.equal(await updates.getByText('Row 1', { exact: true }).count(), 0);
        await updates
          .getByText(
            '1 row was already changed in this reply. Those changes stay. This card holds only the other 6 rows, which need your approval.',
            { exact: true },
          )
          .waitFor();
        assert.equal(await updates.getByRole('list', { name: 'Rows to update' }).getByRole('listitem').count(), 6);
        if (shots)
          await updates.screenshot({
            path: `${shots}/batch-update-pending-${mobile ? 'mobile-dark' : 'desktop-light'}.png`,
          });
        await created.scrollIntoViewIfNeeded();
        await created.getByText('Needs approval', { exact: true }).waitFor();
        await created.getByText('Refund order 1042', { exact: true }).waitFor();
        await created.getByText('Open', { exact: true }).waitFor();
        await created.getByText('Status', { exact: true }).waitFor();
        assert.equal(
          await created.getByText(noteField, { exact: true }).isVisible(),
          false,
          'field IDs stay inside technical details',
        );
        await created
          .getByText(
            'This chat used content from outside your tables, such as web pages, knowledge, files or connected apps, so the change waits for your approval. Approving makes this exact change with your table access.',
            { exact: true },
          )
          .waitFor();
        await updated.scrollIntoViewIfNeeded();
        await updated.getByText('Escalated', { exact: true }).waitFor();
        await updated.getByText('Currently Waiting', { exact: true }).waitFor();
        await deleted.scrollIntoViewIfNeeded();
        await deleted.getByText('Out of date', { exact: true }).waitFor();
        await deleted
          .getByText(
            'The table or row changed after this draft. Nothing was changed. Ask chat for a fresh draft and review it again.',
            { exact: true },
          )
          .waitFor();
        assert.equal(
          await deleted.getByRole('button', { name: 'Approve deletion' }).count(),
          0,
          'a stale draft cannot be approved',
        );
        await batch.scrollIntoViewIfNeeded();
        await batch.getByText('Adds 6 new rows together', { exact: true }).waitFor();
        await batch.getByText('Row 6', { exact: true }).waitFor();
        await batch.getByText('Note: Order 6', { exact: true }).waitFor();
        await batch
          .getByText(
            'Chat changes up to 5 rows on its own. Larger changes wait for your approval. Approving makes this exact change with your table access.',
            { exact: true },
          )
          .waitFor();
        await batch
          .getByText(
            '2 rows were already changed in this reply. Those changes stay. This card holds only the other 6 rows, which need your approval.',
            { exact: true },
          )
          .waitFor();
        await batch.getByRole('list', { name: 'Already added' }).getByText('Note: Order B', { exact: true }).waitFor();
        assert.equal(await batch.getByRole('list', { name: 'Rows to add' }).getByText('Note: Order B').count(), 0);
        if (shots)
          await batch.screenshot({
            path: `${shots}/batch-card-pending-${mobile ? 'mobile-dark' : 'desktop-light'}.png`,
          });

        // A later reply that was held behind the card says so and takes the member to it.
        const waiting = page.getByRole('region', { name: 'Row change waiting for approval' });
        await waiting
          .getByText(
            'Nothing new was added. A row change to Support tickets is waiting for your approval on an earlier card in this chat. Approve or dismiss it first.',
            { exact: true },
          )
          .waitFor();
        await waiting.getByRole('button', { name: 'Go to waiting card' }).click();
        await page.waitForFunction(id => document.activeElement?.id === `row-draft-${id}`, batchDraft);
        if (shots)
          await page.screenshot({
            path: `${shots}/row-draft-waiting-${mobile ? 'mobile-dark' : 'desktop-light'}.png`,
            fullPage: true,
          });
        assert.deepEqual(decisions, [], 'nothing is decided before the member acts');

        await batch.getByRole('button', { name: 'Approve 6 rows' }).click();
        await batch.getByText('6 rows added.', { exact: true }).waitFor();

        await created.getByRole('button', { name: 'Approve change' }).click();
        await created.getByText('Row added.', { exact: true }).waitFor();
        await created.getByText('Applied', { exact: true }).waitFor();
        await updated.getByRole('button', { name: 'Dismiss' }).click();
        await updated.getByText('Draft dismissed. No row was changed.', { exact: true }).waitFor();
        await updates.getByRole('button', { name: 'Approve 6 rows' }).click();
        await updates.getByText('6 rows updated.', { exact: true }).waitFor();
        assert.deepEqual(decisions, [
          { id: batchDraft, decision: 'save', digest: 'd'.repeat(64) },
          { id: createDraft, decision: 'save', digest: 'd'.repeat(64) },
          { id: updateDraft, decision: 'dismiss', digest: 'd'.repeat(64) },
          { id: updateBatchDraft, decision: 'save', digest: 'd'.repeat(64) },
        ]);
        if (shots)
          await page.screenshot({
            path: `${shots}/row-draft-cards-${mobile ? 'mobile-dark' : 'desktop-light'}.png`,
            fullPage: true,
          });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.deepEqual(errors, []);
      } catch (error) {
        if (shots) await page.screenshot({ path: `${shots}/failure.png`, fullPage: true });
        assert.deepEqual(errors, [], 'no browser errors');
        throw error;
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
});
