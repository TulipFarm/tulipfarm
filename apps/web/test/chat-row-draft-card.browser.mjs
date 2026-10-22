import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { createWorkspaceFixture, serveWorkspaceShellEvent, workspaceShellReads } from './workspace.fixture.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { membership, credits } from './chat-query.fixture.mjs';

const chatId = '12121212-1212-4212-8212-121212121212';
const tableId = '44444444-4444-4444-8444-444444444444';
const noteField = '55555555-5555-4555-8555-555555555555';
const statusField = '56565656-5656-4656-8656-565656565656';
const openOption = '57575757-5757-4757-8757-575757575757';
const recordId = '58585858-5858-4858-8858-585858585858';
const createDraft = '14141414-1414-4414-8414-141414141414';
const updateDraft = '15151515-1515-4515-8515-151515151515';
const deleteDraft = '16161616-1616-4616-8616-161616161616';
const revision = 'a'.repeat(40),
  token = '59595959-5959-4959-8959-595959595959';
const rowTable = {
  name: 'Support tickets',
  fields: [
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
const view = (id, input, extra = {}) => ({
  id,
  digest: 'd'.repeat(64),
  status: 'pending',
  outcome: null,
  agentChange: null,
  proposal: { kind: 'row', input },
  rowTable,
  rowCurrent: null,
  ...extra,
});

test('row review drafts show the exact change and act only on the member decision', { timeout: 120000 }, async () => {
  const { workspace, session } = createWorkspaceFixture();
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const browser = await chromium.launch();
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
          tools: [tool(createDraft, 'rows.create'), tool(updateDraft, 'rows.update'), tool(deleteDraft, 'rows.delete')],
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
                    operation: current.proposal.input.tool.slice(5),
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
        throw new Error(`Unexpected API request ${method} ${path}`);
      });
      try {
        await page.goto(`${server.resolvedUrls.local[0]}${workspace.slug}/chat/${chatId}`);
        const cards = page.getByRole('region', { name: 'Review row change' });
        await cards.nth(2).waitFor();
        const created = cards.filter({ hasText: 'Add a row in Support tickets' });
        const updated = cards.filter({ hasText: 'Update a row in Support tickets' });
        const deleted = cards.filter({ hasText: 'Delete a row in Support tickets' });
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
        await updated.getByText('Escalated', { exact: true }).waitFor();
        await updated.getByText('Currently Waiting', { exact: true }).waitFor();
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
        assert.deepEqual(decisions, [], 'nothing is decided before the member acts');

        await created.getByRole('button', { name: 'Approve change' }).click();
        await created.getByText('Row added.', { exact: true }).waitFor();
        await created.getByText('Applied', { exact: true }).waitFor();
        await updated.getByRole('button', { name: 'Dismiss' }).click();
        await updated.getByText('Draft dismissed. No row was changed.', { exact: true }).waitFor();
        assert.deepEqual(decisions, [
          { id: createDraft, decision: 'save', digest: 'd'.repeat(64) },
          { id: updateDraft, decision: 'dismiss', digest: 'd'.repeat(64) },
        ]);
        if (shots)
          await page.screenshot({
            path: `${shots}/row-draft-cards-${mobile ? 'mobile-dark' : 'desktop-light'}.png`,
            fullPage: true,
          });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
});
