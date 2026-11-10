import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { agentBuilderFixture } from './agent-builder.fixture.mjs';
import { startBuiltApp } from './built-app.fixture.mjs';

async function environment(t, fromDirectory = false) {
  const server = await startBuiltApp();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10000);
  const fixture = agentBuilderFixture();
  fixture.tables.length = 0;
  fixture.team.tableScope = [];
  for (const label of ['Customers', 'Orders', 'Customers']) {
    const id = randomUUID();
    fixture.tables.push({
      id,
      revision: 'a'.repeat(40),
      definition: {
        formatVersion: 2,
        id,
        label,
        owningTeamId: label === 'Customers' && fixture.tables.length ? randomUUID() : fixture.team.id,
        fields: [],
        uniqueKeys: [],
      },
      appliedAt: null,
      recordCount: '0',
    });
    fixture.team.tableScope.push({ assetId: id, permissions: ['table.row.read'] });
  }
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/v1/**', route =>
    route.fulfill(fixture.respond(route.request().method(), route.request().url(), route.request().postDataJSON())),
  );
  await page.goto(`${server.origin}/${fixture.workspace.slug}/agents${fromDirectory ? '' : '/new'}`);
  const openBuilder = () => page.getByRole('link', { name: 'Configure manually', exact: true }).first().click();
  if (fromDirectory) return { page, fixture, openBuilder, errors };
  const form = page.getByRole('form', { name: 'Agent setup', exact: true });
  try {
    await form.getByLabel('Agent name', { exact: true }).waitFor({ timeout: 30000 });
    await form.getByRole('checkbox', { name: 'Customers', exact: true }).first().waitFor({ timeout: 30000 });
  } catch (error) {
    console.error(
      await page.locator('body').ariaSnapshot(),
      errors,
      fixture.requests.map(request => request.path),
    );
    throw error;
  }
  const step = name =>
    page
      .getByRole('tab', { name: new RegExp(name) })
      .first()
      .click();
  return { page, fixture, form, step, errors, openBuilder };
}

test(
  'one table can be created from the directory in six interactions without running it',
  { timeout: 60000 },
  async t => {
    const { page, fixture, openBuilder, errors } = await environment(t, true);
    const form = page.getByRole('form', { name: 'Agent setup', exact: true });
    await page.getByRole('link', { name: 'Configure manually', exact: true }).first().waitFor({ timeout: 30000 });
    let interactions = 0;
    const started = performance.now();
    const act = async operation => {
      await operation();
      interactions++;
    };
    await act(openBuilder);
    await form.getByLabel('Agent name', { exact: true }).waitFor();
    await act(() => form.getByLabel('Agent name', { exact: true }).fill('Customer reader'));
    await act(() => form.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Read the Customers table.'));
    assert.equal(
      await page
        .getByRole('complementary', { name: 'Agent view' })
        .getByText('No actions selected', { exact: true })
        .count(),
      1,
      'instructions alone never infer tools',
    );
    await act(() => form.getByRole('checkbox', { name: 'Customers', exact: true }).first().check());
    const tableCard = form.getByRole('region', { name: 'Business tables', exact: true });
    await tableCard.getByRole('region', { name: 'Suggested actions: read tables' }).waitFor();
    assert.equal(await tableCard.getByRole('group', { name: 'Business tables', exact: true }).count(), 1);
    const summary = page.getByRole('complementary', { name: 'Agent view' });
    await summary.getByText('Customers: read rows', { exact: true }).waitFor();
    await act(() => form.getByRole('button', { name: 'Continue', exact: true }).click());
    await form.getByRole('heading', { name: 'Review your agent', exact: true }).waitFor();
    assert.equal(await summary.count(), 0, 'Review replaces the Summary panel');
    for (const name of ['Skills', 'Triggers']) {
      const tab = page.getByRole('tab', { name: new RegExp(name) });
      assert.equal(await tab.locator('svg').count(), 0, `${name} was not marked visited`);
    }
    await act(() => form.getByRole('button', { name: 'Create and activate', exact: true }).click());
    await page.waitForURL(/\/agents\/[a-f0-9-]+#run-agent-now$/);
    const run = page.getByRole('region', { name: 'Run agent now', exact: true });
    await run.getByRole('textbox').waitFor();
    await page.waitForFunction(() => document.querySelector('#run-agent-now textarea') === document.activeElement);
    const waiting = performance.now() - started;
    assert.equal(interactions, 6, 'includes opening New agent from the Agents page');
    assert.ok(waiting <= 10000, `${waiting.toFixed(0)}ms waiting`);
    const setup = [...fixture.setups.values()][0].setup;
    assert.deepEqual(setup.definition.tools, [
      'tables.list',
      'schema.inspect',
      'rows.list',
      'rows.get',
      'rows.summarize',
    ]);
    assert.deepEqual(setup.scope, [{ assetId: fixture.tables[0].id, permissions: ['table.row.read'] }]);
    assert.deepEqual(setup.enrollment, [fixture.team.id]);
    assert.equal([...fixture.publications.values()][0].receipt.status, 'active');
    assert.equal(
      fixture.requests.some(request => /\/commands$|\/authoring\//.test(request.path)),
      false,
      'no task or model call',
    );
    assert.deepEqual(errors, []);
    console.log(`Agent creation: ${interactions} interactions, ${(waiting / 1000).toFixed(2)}s waiting.`);
  },
);

test(
  'table choices add immediately, keep hidden selections, and respect removed suggestions',
  { timeout: 60000 },
  async t => {
    const { page, form, step, fixture } = await environment(t);
    await form.getByLabel('Agent name', { exact: true }).fill('Customer reader');
    await form.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Read customers.');
    const customers = form.getByRole('checkbox', { name: 'Customers', exact: true });
    assert.equal(await customers.count(), 2);
    const choices = form.getByRole('group', { name: 'Business tables', exact: true });
    assert.match(await choices.innerText(), /People Ops/);
    assert.match(await choices.innerText(), /Team name unavailable/);
    for (const table of fixture.tables)
      assert.doesNotMatch(await choices.innerText(), new RegExp(table.id.slice(0, 8)));
    await customers.first().check();
    await form.getByRole('button', { name: 'Remove suggested table actions', exact: true }).click();
    assert.equal(
      await page
        .getByRole('status')
        .filter({ hasText: 'Suggested actions removed.' })
        .evaluate(node => node === document.activeElement),
      true,
    );
    await form.getByRole('searchbox', { name: 'Search business tables', exact: true }).fill('Orders');
    await form.getByRole('checkbox', { name: 'Orders', exact: true }).check();
    assert.equal(await form.getByRole('region', { name: 'Suggested actions: read tables' }).count(), 0);
    await step('Access');
    assert.equal(await form.getByRole('button', { name: 'Add table access', exact: true }).count(), 0);
    assert.equal(await form.getByRole('checkbox', { name: 'Customers', exact: true }).first().isChecked(), true);
    assert.equal(await form.getByRole('checkbox', { name: 'Orders', exact: true }).isChecked(), true);
    await form.getByRole('button', { name: 'Continue', exact: true }).click();
    await form.getByRole('heading', { name: 'Review your agent', exact: true }).waitFor();
    await form.getByRole('button', { name: 'Create and activate', exact: true }).click();
    await form.getByRole('alert').filter({ hasText: 'This agent has table access' }).first().waitFor();
    await form.getByRole('button', { name: 'Go to Access', exact: true }).waitFor();
    assert.equal(fixture.publications.size, 0);
    await form.getByRole('button', { name: 'More actions', exact: true }).click();
    const tables = form.getByRole('region', { name: 'Tables actions', exact: true });
    await tables.getByRole('button').first().click();
    await tables.getByRole('button', { name: 'Tables: read only', exact: true }).click();
    await form.getByRole('button', { name: 'Continue', exact: true }).click();
    await form.getByRole('button', { name: 'Save draft', exact: true }).click();
    await form
      .getByText('Draft saved. Slack channels and workflow triggers are not started.', { exact: true })
      .waitFor();
    const setup = [...fixture.setups.values()][0].setup;
    assert.deepEqual(
      setup.scope.map(entry => entry.assetId).sort(),
      [fixture.tables[0].id, fixture.tables[1].id].sort(),
    );
  },
);

test('app presets replace only their own group and individual choices remain editable', { timeout: 60000 }, async t => {
  const { form, step } = await environment(t);
  await step('Access');
  await form.getByRole('button', { name: 'More actions', exact: true }).click();
  const knowledge = form.getByRole('region', { name: 'Knowledge and web actions', exact: true });
  const tables = form.getByRole('region', { name: 'Tables actions', exact: true });
  await knowledge.getByRole('button').first().click();
  await knowledge.getByRole('button', { name: 'Knowledge and web: read only', exact: true }).click();
  await tables.getByRole('button').first().click();
  await tables.getByRole('button', { name: 'Read and change rows', exact: true }).click();
  assert.equal(await tables.getByRole('checkbox', { name: 'Create rows', exact: true }).isChecked(), true);
  await tables.getByRole('button', { name: 'Tables: read only', exact: true }).click();
  assert.equal(await tables.getByRole('checkbox', { name: 'Create rows', exact: true }).isChecked(), false);
  assert.equal(await tables.getByRole('checkbox', { name: 'Find rows', exact: true }).isChecked(), true);
  await tables.getByRole('checkbox', { name: 'Find rows', exact: true }).uncheck();
  assert.equal(await tables.getByRole('checkbox', { name: 'Find rows', exact: true }).isChecked(), false);
  assert.equal(await knowledge.getByRole('checkbox').first().isChecked(), true, 'other app selections survive');
});

test('removing suggested actions keeps a row reader that was picked manually', { timeout: 60000 }, async t => {
  const { page, form, step } = await environment(t);
  await form.getByRole('checkbox', { name: 'Customers', exact: true }).first().check();
  await step('Access');
  await form.getByRole('button', { name: 'More actions', exact: true }).click();
  const tables = form.getByRole('region', { name: 'Tables actions', exact: true });
  await tables.getByRole('button').first().click();
  const row = tables.getByRole('checkbox', { name: 'Read a row', exact: true });
  await row.uncheck();
  await row.check();
  await form.getByRole('button', { name: 'Remove suggested table actions', exact: true }).click();
  const chosen = form.getByRole('list', { name: 'Chosen actions' });
  assert.equal(await chosen.getByRole('listitem').count(), 1);
  await chosen.getByRole('button', { name: 'Remove Read a row', exact: true }).waitFor();
  await form.getByRole('checkbox', { name: 'Orders', exact: true }).check();
  assert.equal(await chosen.getByRole('listitem').count(), 1, 'another table never restores removed actions');
  assert.equal(await page.getByRole('region', { name: 'Suggested actions: read tables' }).count(), 0);
});

test(
  'presets keep all current choices when the combined selection would exceed twenty actions',
  { timeout: 60000 },
  async t => {
    const { form, step } = await environment(t);
    await step('Access');
    await form.getByRole('button', { name: 'More actions', exact: true }).click();
    for (const app of ['Tables', 'Knowledge and web', 'GitHub']) {
      const group = form.getByRole('region', { name: `${app} actions`, exact: true });
      await group.getByRole('button').first().click();
      await group.getByRole('button', { name: `${app}: read only`, exact: true }).click();
    }
    const chosen = form.getByRole('list', { name: 'Chosen actions' });
    const before = await chosen.innerText();
    const slack = form.getByRole('region', { name: 'Slack actions', exact: true });
    await slack.getByRole('button').first().click();
    await slack
      .getByRole('button', { name: 'Slack: all actions, including actions that change data', exact: true })
      .click();
    await form.getByRole('alert').getByText('Choose no more than 20 actions.', { exact: true }).waitFor();
    assert.equal(await chosen.innerText(), before);
    assert.ok((await chosen.getByRole('listitem').count()) <= 20);
  },
);
