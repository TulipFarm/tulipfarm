import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { normalizeQueryRequest } from '@tulipfarm/tables/query';
import { chatCatalog } from './chat-catalog.fixture.mjs';

test('row panels restore keyboard focus through refreshes and missing controls', { timeout: 90_000 }, async () => {
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const browser = await chromium.launch({
    headless: true,
    args: process.env.TABLE_FOCUS_CDP_PORT ? [`--remote-debugging-port=${process.env.TABLE_FOCUS_CDP_PORT}`] : [],
  });
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  page.setDefaultTimeout(10_000);
  try {
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const workspace = {
      id: randomUUID(),
      slug: 'acme',
      name: 'Acme',
      status: 'ready',
      createdAt: '2026-10-02T00:00:00Z',
      soulCommit: 'a'.repeat(40),
    };
    const tableId = randomUUID(),
      fieldId = randomUUID(),
      teamId = randomUUID(),
      memberId = randomUUID();
    const revision = 'a'.repeat(40);
    const definition = {
      formatVersion: 2,
      id: tableId,
      owningTeamId: teamId,
      label: 'Customers',
      fields: [{ id: fieldId, label: 'Name', kind: 'text', required: true, maxLength: 100 }],
      uniqueKeys: [],
    };
    const records = new Map();
    let update = true;
    await page.route('**/v1/**', async route => {
      const request = route.request(),
        path = new URL(request.url()).pathname;
      let json;
      if (path === '/v1/auth/get-session')
        json = {
          session: { id: 'session-ada', userId: 'ada' },
          user: { id: 'ada', name: 'Ada', email: 'ada@example.com' },
        };
      else if (path === '/v1/workspaces') json = [workspace];
      else if (path === '/v1/workspaces/acme') json = workspace;
      else if (path.endsWith('/model-catalog')) json = chatCatalog;
      else if (path.endsWith('/governance/me'))
        json = {
          membershipId: memberId,
          role: 'member',
          teams: [{ id: teamId, name: 'Support', description: '', membershipIds: [memberId] }],
          capabilities: { manageGovernance: false, canLeave: true },
        };
      else if (path.endsWith(`/tables/${tableId}`))
        json = {
          id: tableId,
          saved: null,
          applied: { revision, definition, appliedAt: workspace.createdAt },
          rowPermissions: { create: true, update, delete: true },
        };
      else if (path.endsWith('/query')) {
        const { query, rsql } = normalizeQueryRequest(definition, request.postDataJSON().request);
        const rows = [...records.values()].filter(
          row => !query.search || row.values[fieldId]?.value.includes(query.search),
        );
        json = {
          mode: 'rows',
          query,
          rsql,
          references: {},
          records: rows,
          total: String(rows.length),
          nextCursor: null,
        };
      } else if (path.endsWith('/rows') && request.method() === 'POST') {
        const input = request.postDataJSON();
        const row = {
          id: input.recordId,
          token: randomUUID(),
          values: { ...records.get(input.recordId)?.values, ...input.values },
        };
        records.set(row.id, row);
        json = { kind: 'available', ...row };
      } else return route.fulfill({ status: 404, json: { error: 'unavailable' } });
      await route.fulfill({ json });
    });
    const changed = () =>
      page.evaluate(
        ({ workspaceId, memberId, tableId }) => {
          const channel = new BroadcastChannel('tulipfarm:query:v1');
          channel.postMessage({
            version: 1,
            id: crypto.randomUUID(),
            sessionId: 'session-ada',
            scope: { kind: 'workspace', userId: 'ada', workspaceId, membershipId: memberId },
            kind: 'change',
            keys: [['tables', 'detail', tableId]],
          });
          channel.close();
        },
        { workspaceId: workspace.id, memberId, tableId },
      );
    const add = page.getByRole('button', { name: 'Add row', exact: true });
    const panel = page.getByRole('dialog');
    const edit = id => page.locator(`[data-row-control="edit"][data-row-id="${id}"]`);
    const actions = id => page.locator(`[data-row-control="actions"][data-row-id="${id}"]`);
    const focus = async control => {
      await page.waitForFunction(element => document.activeElement === element, await control.elementHandle());
      assert.equal(await control.evaluate(element => element === document.activeElement), true);
    };
    const close = async method => {
      if (method === 'Escape') await page.keyboard.press('Escape');
      else await panel.getByRole('button', { name: 'Close', exact: true }).click();
      await panel.waitFor({ state: 'detached' });
    };
    const seed = name => {
      const row = { id: randomUUID(), token: randomUUID(), values: { [fieldId]: { kind: 'text', value: name } } };
      records.set(row.id, row);
      return row.id;
    };
    for (const width of [1280, 375]) {
      records.clear();
      update = true;
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${server.resolvedUrls.local[0]}acme/tables/${tableId}`);
      for (const method of ['Escape', 'Close']) {
        await add.click();
        await panel.waitFor();
        await close(method);
        await focus(add);
      }
      await add.press('Enter');
      await panel.getByLabel('Name', { exact: true }).fill('First customer');
      await panel.getByRole('button', { name: 'Save new row', exact: true }).click();
      await panel.waitFor({ state: 'detached' });
      const first = [...records.keys()][0];
      await focus(edit(first));
      for (const method of ['Escape', 'Close']) {
        await edit(first).press('Enter');
        await panel.getByLabel('Name', { exact: true }).waitFor();
        assert.equal(await panel.getByLabel('Name', { exact: true }).inputValue(), 'First customer');
        await close(method);
        await focus(edit(first));
        if (process.env.TABLE_FOCUS_CDP_PORT && method === 'Escape')
          execFileSync(
            'agent-browser',
            [
              '--session',
              'table-focus',
              '--cdp',
              process.env.TABLE_FOCUS_CDP_PORT,
              'screenshot',
              `/tmp/table-panel-focus-after-${width}.png`,
            ],
            { stdio: 'pipe', timeout: 15000 },
          );
      }
      await edit(first).press('Enter');
      await panel.getByLabel('Name', { exact: true }).fill('Renamed customer');
      await panel.getByRole('button', { name: 'Save row', exact: true }).click();
      await panel.waitFor({ state: 'detached' });
      await focus(edit(first));
      for (const method of ['Escape', 'Close']) {
        await actions(first).click();
        await page.getByRole('menuitem', { name: 'Edit row', exact: true }).click();
        await panel.waitFor();
        await close(method);
        await focus(actions(first));
      }
      await actions(first).click();
      await page.getByRole('menuitem', { name: 'Edit row', exact: true }).click();
      await panel.getByLabel('Name', { exact: true }).fill('Saved from actions');
      await panel.getByRole('button', { name: 'Save row', exact: true }).click();
      await panel.waitFor({ state: 'detached' });
      await focus(actions(first));
      await actions(first).click();
      await page.getByRole('menuitem').first().waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('menu').waitFor({ state: 'detached' });
      await focus(actions(first));
      for (const name of ['Columns', 'More table options']) {
        const button = page.getByRole('button', { name, exact: true });
        await button.click();
        await page.getByRole('menuitem').or(page.getByRole('menuitemcheckbox')).first().waitFor();
        await page.keyboard.press('Escape');
        await page.getByRole('menu').waitFor({ state: 'detached' });
        await focus(button);
      }
      const second = seed('Second customer');
      await changed();
      await edit(second).waitFor();
      await actions(first).click();
      await page.getByRole('menuitem', { name: 'Edit row', exact: true }).click();
      update = false;
      await changed();
      await close('Escape');
      await focus(actions(first));
      update = true;
      await changed();
      await edit(first).waitFor();
      await actions(first).click();
      await page.getByRole('menuitem', { name: 'Edit row', exact: true }).click();
      await page.locator(`[data-row-control="actions"][data-row-id="${first}"]`).evaluate(element => element.remove());
      await close('Escape');
      await focus(edit(first));
      await edit(first).click();
      records.delete(first);
      await close('Escape');
      await focus(edit(second));
      await edit(second).click();
      records.clear();
      await close('Escape');
      await focus(page.getByRole('region', { name: 'Customers', exact: true }));
      await page.goto(`${server.resolvedUrls.local[0]}acme/tables/${tableId}?q=Matching`);
      await add.click();
      await panel.getByLabel('Name', { exact: true }).fill('Hidden by search');
      await panel.getByRole('button', { name: 'Save new row', exact: true }).click();
      await panel.waitFor({ state: 'detached' });
      await focus(add);
    }
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error(await page.locator('body').innerText());
    console.error('Focused element:', await page.evaluate(() => document.activeElement.outerHTML.slice(0, 500)));
    throw error;
  } finally {
    await browser.close();
    await server.close();
  }
});
