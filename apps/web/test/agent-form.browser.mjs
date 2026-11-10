import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { agentBuilderFixture } from './agent-builder.fixture.mjs';
import { assertUncovered } from './browser-controls.mjs';
import {
  startBuiltApp,
  builderBrowserOptions,
  captureBuilderScreenshot,
  captureBrowserFailure,
} from './built-app.fixture.mjs';

async function environment(t, { width = 1440, height = 1000, floating = false, workspaceName, canAssign = true } = {}) {
  const server = await startBuiltApp();
  t.after(() => server.close());
  const browser = await chromium.launch(builderBrowserOptions());
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width, height },
    hasTouch: width < 1280,
    reducedMotion: 'reduce',
  });
  page.setDefaultTimeout(10000);
  const errors = [],
    fixture = agentBuilderFixture();
  if (floating) {
    fixture.workspace.name = 'Example workspace';
    fixture.workspace.slug = 'example-workspace';
  }
  if (workspaceName) fixture.workspace.name = workspaceName;
  fixture.team.canAssign = canAssign;
  page.on('pageerror', error => errors.push(error.message));
  if (floating)
    page.on('console', message => {
      if (message.type() === 'error' && !/^Failed to load resource:.*404/.test(message.text()))
        errors.push(message.text());
    });
  const budId = randomUUID();
  await page.route('**/v1/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (floating && path.endsWith('/bud'))
      return route.fulfill({
        json: {
          conversationId: budId,
          onboarding: 'completed',
          bubblesEnabled: true,
          snoozedUntil: null,
          nudge: null,
          preferences: [],
        },
      });
    if (floating && path.endsWith(`/conversations/${budId}/messages`))
      return route.fulfill({ json: { messages: [], nextBefore: null } });
    if (floating && path.endsWith(`/conversations/${budId}`))
      return route.fulfill({
        json: {
          id: budId,
          title: 'Bud',
          titleRevision: 1,
          archived: false,
          activityAt: '2026-10-12T10:00:00Z',
          createdAt: '2026-10-12T10:00:00Z',
        },
      });
    return route.fulfill(fixture.respond(request.method(), request.url(), request.postDataJSON()));
  });
  await page.goto(`${server.origin}/${fixture.workspace.slug}/agents/new`);
  const form = page.getByRole('form', { name: 'Agent setup', exact: true });
  const step = name =>
    page
      .getByRole('tab', { name: new RegExp(name) })
      .first()
      .click();
  try {
    await form.getByLabel('Agent name', { exact: true }).waitFor({ timeout: 30000 });
  } catch (error) {
    await captureBrowserFailure(page, 'agent-form-loading');
    console.error(await page.locator('body').innerText(), errors);
    throw error;
  }
  return { page, fixture, errors, form, step };
}

test('table access selects a granting team and shows an editable access source', { timeout: 60000 }, async t => {
  const { page, fixture, form, step, errors } = await environment(t, { workspaceName: 'Customer operations' });
  await form.getByLabel('Agent name', { exact: true }).fill('Customer reader');
  await form.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Count the customer rows.');
  await step('Access');
  await form.getByRole('checkbox', { name: 'Customers', exact: true }).check();
  await form.getByText('Uses access from People Ops.', { exact: true }).waitFor();
  await form.getByRole('button', { name: 'Change teams used for access', exact: true }).click();
  const enrollment = form.getByRole('group', { name: 'Teams whose permissions the agent may use', exact: true });
  assert.equal(await enrollment.getByRole('checkbox', { name: 'People Ops', exact: true }).isChecked(), true);
  await captureBuilderScreenshot(page, 'table-access-team-desktop');
  await step('Review');
  await form.getByRole('button', { name: 'Save draft', exact: true }).click();
  await form.getByText('Draft saved. Slack channels and workflow triggers are not started.', { exact: true }).waitFor();
  assert.deepEqual([...fixture.setups.values()][0].setup.enrollment, [fixture.team.id]);
  assert.deepEqual([...fixture.setups.values()][0].setup.scope, fixture.team.tableScope);
  await form.getByRole('button', { name: 'Continue editing', exact: true }).click();
  await step('Access');
  const teamChoices = form.getByRole('button', { name: 'Change teams used for access', exact: true });
  if ((await teamChoices.getAttribute('aria-expanded')) !== 'true') await teamChoices.click();
  await enrollment.getByRole('checkbox', { name: 'People Ops', exact: true }).uncheck();
  await form
    .getByText('No team access selected. Choose a team that can read the selected tables.', { exact: true })
    .waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await captureBuilderScreenshot(page, 'table-access-team-mobile');
  assert.deepEqual(errors, []);
});

test('table access blocks a plain member with the manager needed before activation', { timeout: 60000 }, async t => {
  const { page, fixture, form, step, errors } = await environment(t, {
    workspaceName: 'Customer operations',
    canAssign: false,
  });
  await form.getByLabel('Agent name', { exact: true }).fill('Customer reader');
  await form.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Count the customer rows.');
  await step('Access');
  await form.getByRole('checkbox', { name: 'Customers', exact: true }).check();
  await form
    .getByRole('alert')
    .getByText('You need a manager of People Ops to give this agent access.', { exact: true })
    .waitFor();
  await captureBuilderScreenshot(page, 'table-access-manager-required-desktop');
  await step('Review');
  const activate = form.getByRole('button', { name: 'Create and activate', exact: true });
  assert.equal(await activate.getAttribute('aria-disabled'), 'true');
  await activate.dispatchEvent('click');
  assert.equal(fixture.setups.size, 0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await captureBuilderScreenshot(page, 'table-access-manager-required-mobile');
  assert.deepEqual(errors, []);
});

for (const width of [375, 390, 414, 768, 1440])
  test(`floating controls leave every builder action accessible at ${width}px`, { timeout: 90000 }, async t => {
    const { page, fixture, form, errors } = await environment(t, {
      width,
      height: width === 1440 ? 900 : 812,
      floating: true,
    });
    const scroller = page.locator('[data-viewport-content]');
    const bottom = () => scroller.evaluate(node => (node.scrollTop = node.scrollHeight));
    const choose = async name => {
      if (width < 640) {
        await page.getByRole('combobox', { name: 'Setup section', exact: true }).click();
        await page.getByRole('option', { name: new RegExp(name) }).click();
      } else
        await page
          .getByRole('tab', { name: new RegExp(name) })
          .first()
          .click();
    };
    await form.getByLabel('Agent name', { exact: true }).fill('Handbook helper');
    await form.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Find reviewed policies.');
    await bottom();
    const save = form.getByRole('button', { name: 'Save draft', exact: true });
    const next = form.getByRole('button', { name: 'Continue', exact: true });
    await assertUncovered(save);
    await assertUncovered(next);
    if (width === 375) {
      await form.getByRole('textbox', { name: 'Instructions', exact: true }).focus();
      for (let count = 0; count < 30 && !(await next.evaluate(node => node === document.activeElement)); count++)
        await page.keyboard.press('Tab');
      assert.equal(await next.evaluate(node => node === document.activeElement), true, 'Tab reaches Continue');
      await assertUncovered(next);
      await page.getByRole('button', { name: 'Open Bud', exact: true }).click();
      const popup = page.getByRole('dialog', { name: 'Bud quick chat', exact: true });
      await popup.waitFor();
      await popup.getByRole('button', { name: 'Minimize chat', exact: true }).focus();
      for (let count = 0; count < 12; count++) {
        await page.keyboard.press('Tab');
        await page.waitForFunction(
          () =>
            document.querySelector('[role="dialog"][data-slot="popover-content"]')?.contains(document.activeElement) ||
            document.activeElement?.getAttribute('aria-label') === 'Minimize Bud',
        );
      }
      await page.keyboard.press('Escape');
      await popup.waitFor({ state: 'hidden' });
      assert.equal(
        await page
          .getByRole('button', { name: 'Open Bud', exact: true })
          .evaluate(node => node === document.activeElement),
        true,
        'closing quick chat restores focus',
      );
      await assertUncovered(next);
    }
    if (width < 1280) await next.tap();
    else await next.click();
    await form.getByText('What it can do', { exact: true }).waitFor();
    for (const [step, action] of [
      ['Skills', 'Continue'],
      ['Access', 'Continue'],
      ['Triggers', 'Review agent'],
      ['Review', 'Create and activate'],
    ]) {
      await choose(step);
      await bottom();
      await assertUncovered(save);
      await assertUncovered(form.getByRole('button', { name: action, exact: true }));
    }
    await captureBuilderScreenshot(page, `agent-builder-actions-${width}`);
    const activate = form.getByRole('button', { name: 'Create and activate', exact: true });
    if (width < 1280) await activate.tap();
    else await activate.click();
    await page.getByRole('region', { name: 'Run agent now', exact: true }).waitFor();
    assert.equal(fixture.publications.size, 1);
    assert.equal([...fixture.publications.values()][0].body.decision, 'activate');
    assert.deepEqual(errors, []);
  });

test('the shared shell also keeps settings actions clear on a phone', { timeout: 60000 }, async t => {
  const { page, fixture, errors } = await environment(t, { width: 375, height: 812, floating: true });
  let name = fixture.workspace.name;
  let revision = 0;
  await page.route(/\/v1\/workspaces\/[^/]+\/settings(\/name)?$/, route => {
    const request = route.request();
    if (request.method() === 'PUT') {
      const body = request.postDataJSON();
      name = body.name;
      fixture.workspace.name = name;
      return route.fulfill({ json: { requestId: body.requestId, name, revision: ++revision } });
    }
    return route.fulfill({
      json: {
        workspaceId: fixture.workspace.id,
        slug: fixture.workspace.slug,
        name,
        revision,
        canManage: true,
      },
    });
  });
  await page.goto(`${new URL(page.url()).origin}/${fixture.workspace.slug}/settings`);
  const workspaceName = page.getByRole('textbox', { name: 'Workspace name', exact: true });
  await workspaceName.waitFor({ timeout: 30000 });
  await workspaceName.fill('Renamed workspace');
  const save = page.getByRole('button', { name: 'Save name', exact: true });
  await save.scrollIntoViewIfNeeded();
  await assertUncovered(save);
  await captureBuilderScreenshot(page, 'settings-actions-375');
  await save.tap();
  await page.getByText('Workspace name saved.', { exact: true }).waitFor();
  assert.equal(name, 'Renamed workspace');
  assert.deepEqual(errors, []);
});

test(
  'builder preserves exact choices, reviews imported skills, saves once, and resumes without activating',
  { timeout: 120000 },
  async t => {
    const { page, fixture, errors, form, step } = await environment(t);
    try {
      const name = form.getByLabel('Agent name', { exact: true }),
        instructions = form.getByRole('textbox', { name: 'Instructions', exact: true });
      await step('Review');
      await form.getByRole('button', { name: 'Save draft', exact: true }).click();
      await page.waitForFunction(() => document.activeElement?.id === 'agent-name');
      assert.equal(await name.getAttribute('aria-invalid'), 'true');
      assert.equal(fixture.setups.size, 0);
      assert.equal(await name.getAttribute('maxlength'), '120');
      assert.equal(await instructions.getAttribute('maxlength'), '32000');
      await name.fill('People Ops helper');
      await instructions.fill('Help teammates find handbook policies. Ask when information is missing.');
      await form.getByRole('combobox', { name: 'Team placement', exact: true }).click();
      await page.getByRole('option', { name: 'People Ops', exact: true }).click();
      const agentView = page.getByRole('complementary', { name: 'Agent view' });
      await agentView.getByRole('heading', { name: 'People Ops helper' }).waitFor();
      await step('Access');
      await form.getByText('No actions chosen.', { exact: false }).waitFor();
      await form.getByRole('button', { name: 'More actions', exact: true }).click();
      await form.getByRole('button', { name: /Tables.*available/ }).click();
      await form.getByRole('checkbox', { name: 'Find rows', exact: true }).check();
      await form.getByRole('checkbox', { name: 'Read a row', exact: true }).check();
      await form.getByRole('searchbox', { name: 'Find actions' }).fill('Find rows');
      await form.getByRole('checkbox', { name: 'Find rows', exact: true }).uncheck();
      await form.getByRole('searchbox', { name: 'Find actions' }).fill('');
      assert.equal(
        await form.getByRole('checkbox', { name: 'Read a row', exact: true }).isChecked(),
        true,
        'filtering never drops hidden selections',
      );
      await form.getByRole('button', { name: 'Hide more actions', exact: true }).click();
      await form.getByRole('searchbox', { name: 'Find actions' }).waitFor({ state: 'hidden' });
      const chosen = form.getByRole('list', { name: 'Chosen actions' });
      await chosen.getByRole('button', { name: 'Remove Read a row', exact: true }).waitFor();
      assert.equal(await chosen.getByRole('listitem').count(), 1, 'only chosen actions stay in view');
      await step('Skills');
      await form.getByRole('button', { name: 'More skills', exact: true }).click();
      await form.getByRole('checkbox', { name: 'Employee handbook answers', exact: true }).check();
      await form.getByRole('button', { name: 'Import skill', exact: true }).click();
      const importer = page.getByRole('dialog', { name: 'Import skills for this agent' });
      await importer.getByLabel('Source URL').fill('https://github.com/example/business-skills');
      await importer.getByRole('button', { name: 'Find skills', exact: true }).click();
      await importer.getByRole('checkbox').first().check();
      await importer.getByRole('button', { name: 'Review selected skills', exact: true }).click();
      await importer.getByRole('checkbox', { name: 'I have read the high-risk warnings' }).check();
      await importer.getByRole('button', { name: 'Install and enable', exact: true }).click();
      await importer.getByRole('button', { name: 'Add installed skills to agent', exact: true }).click();
      await importer.waitFor({ state: 'hidden' });
      assert.equal(fixture.imports.installed.length, 1);
      await step('Triggers');
      await form.getByRole('combobox', { name: 'Add a channel', exact: true }).click();
      await page.getByRole('option', { name: 'ask-people-ops', exact: true }).click();
      await form.getByRole('combobox', { name: 'Add a channel', exact: true }).click();
      await page.getByRole('option', { name: 'new-starters', exact: true }).click();
      await form
        .getByText('No triggers. People can still use this agent in chat and Slack.', { exact: true })
        .waitFor();
      await step('Basics');
      await form.getByRole('heading', { name: 'Identity', exact: true }).scrollIntoViewIfNeeded();
      await captureBuilderScreenshot(page, 'agent-builder-desktop');
      await step('Review');
      fixture.loseNextPublication();
      await form.getByRole('button', { name: 'Save draft', exact: true }).click();
      await form.getByRole('button', { name: 'Retry same operation', exact: true }).click();
      await form
        .getByText('Draft saved. Slack channels and workflow triggers are not started.', { exact: true })
        .waitFor();
      const saves = fixture.requests.filter(request => request.path.endsWith('/setup'));
      assert.equal(saves.length, 2);
      assert.deepEqual(saves[0].body, saves[1].body, 'uncertain publication reuses exact review and identity');
      assert.equal(fixture.publications.size, 1);
      const setup = [...fixture.setups.values()][0].setup;
      assert.equal(setup.owningTeamId, fixture.team.id);
      assert.deepEqual(setup.definition.tools, ['rows.get']);
      assert.equal(setup.definition.skills.length, 2);
      assert.equal(setup.slackChannels.length, 2);
      assert.deepEqual(setup.triggers, []);
      assert.deepEqual(setup.policy, { grants: [], personGrants: [] }, 'placement never silently shares');
      assert.equal(saves[0].body.consent.sponsor, false, 'saving needs no sponsor approval');
      // Triggers come from chat; the builder reviews and sponsors those already on the draft.
      const trigger = {
        id: randomUUID(),
        trigger: { kind: 'cron', expression: '0 9 * * 1', timezone: 'Asia/Kolkata' },
      };
      const prompt = 'Prepare the weekly People Ops update.';
      Object.assign([...fixture.setups.values()][0].setup, { triggers: [trigger], prompt });
      await page.reload();
      await form.getByRole('button', { name: 'Continue editing', exact: true }).click();
      await step('Triggers');
      assert.equal(await form.getByText('Check needed', { exact: true }).count(), 2);
      for (const recheck of await form.getByRole('button', { name: 'Recheck', exact: true }).all())
        await recheck.click();
      await form.getByRole('region', { name: 'Trigger 1' }).waitFor();
      await form.getByText(prompt, { exact: true }).first().waitFor();
      await form.getByRole('checkbox', { name: /^I sponsor / }).check();
      await step('Review');
      await form.getByRole('region', { name: 'Reviewed triggers' }).getByText(prompt, { exact: true }).waitFor();
      await form.getByRole('button', { name: 'Create and activate', exact: true }).click();
      await page.getByRole('region', { name: 'Run agent now', exact: true }).waitFor();
      assert.equal(fixture.publications.size, 2);
      const activation = [...fixture.publications.values()].find(item => item.body.decision === 'activate');
      assert.equal(activation.body.consent.sponsor, true);
      assert.deepEqual([...fixture.setups.values()][0].setup.triggers, [trigger]);
      assert.equal([...fixture.setups.values()][0].setup.prompt, prompt);
      assert.deepEqual(errors, []);
    } catch (error) {
      await captureBrowserFailure(page, 'agent-builder-form');
      throw error;
    }
  },
);

test('blocked activation keeps the reviewed draft and retries the same setup', { timeout: 60000 }, async t => {
  const { page, form, fixture, step } = await environment(t);
  await form.getByLabel('Agent name', { exact: true }).fill('People Ops helper');
  await form.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Cite the handbook.');
  fixture.blockActivation();
  await step('Review');
  await form.getByRole('button', { name: 'Create and activate', exact: true }).click();
  await form
    .getByText('Agent saved, but not active yet. No new triggers or Slack channels were started.', { exact: true })
    .waitFor();
  await form.getByText('The Slack app can’t post in this channel yet. Retry setup later.', { exact: true }).waitFor();
  assert.equal(
    await form.getByText('The earlier active setup was not replaced.', { exact: false }).count(),
    0,
    'a new agent has no earlier active setup',
  );
  assert.equal(await page.getByRole('heading', { name: 'Agent created and activated.', exact: true }).count(), 0);
  assert.equal(fixture.publications.size, 1);
  await form.getByRole('button', { name: 'Retry setup', exact: true }).click();
  await page.getByRole('region', { name: 'Run agent now', exact: true }).waitFor();
  assert.equal(fixture.publications.size, 1);
  assert.equal(fixture.requests.filter(request => request.path.endsWith('/retry')).length, 1);
});

test(
  'Luna requires apply, stale replies cannot overwrite, tool-free chat survives responsive moves',
  { timeout: 120000 },
  async t => {
    const { page, form, fixture, errors, step } = await environment(t);
    try {
      const instructions = form.getByRole('textbox', { name: 'Instructions', exact: true });
      await form.getByLabel('Agent name', { exact: true }).fill('People Ops helper');
      await instructions.fill('Help with People Ops.');
      await form.getByRole('button', { name: 'Improve instructions', exact: true }).click();
      await form.getByRole('button', { name: 'Apply suggestion', exact: true }).waitFor();
      assert.equal(await instructions.inputValue(), 'Help with People Ops.');
      await instructions.fill('Changed instructions.');
      assert.equal(await form.getByRole('button', { name: 'Apply suggestion', exact: true }).isDisabled(), true);
      await form.getByRole('button', { name: 'Discard suggestion', exact: true }).click();
      await form.getByRole('button', { name: 'Improve instructions', exact: true }).click();
      await form.getByRole('button', { name: 'Apply suggestion', exact: true }).click();
      assert.match(await instructions.inputValue(), /Cite the source/);
      await page.getByRole('tab', { name: 'Test chat', exact: true }).click();
      await page.getByRole('textbox', { name: 'Sample message', exact: true }).fill('How do I request time off?');
      await page.getByRole('button', { name: 'Send test', exact: true }).click();
      await page
        .getByRole('list', { name: 'Test conversation' })
        .getByText(/Which policy/)
        .waitFor();
      const question = fixture.requests.find(request => request.path.endsWith('/authoring/test-chat')).body;
      assert.deepEqual(question.definition.tools, []);
      const grid = await page.getByRole('complementary', { name: 'Agent view' }).evaluate(node => {
        const [configuration, agentView] = node.parentElement.children;
        return [configuration.getBoundingClientRect().width, agentView.getBoundingClientRect().width];
      });
      assert.ok(Math.abs(grid[0] / (grid[0] + grid[1]) - 0.6) < 0.005);
      for (const width of [320, 375, 414, 768, 1280, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: width === 375 || width === 1280 ? 'dark' : 'light' });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
          `no overflow at ${width}`,
        );
        if (width < 1280) {
          if (width === 375) {
            await page.getByRole('button', { name: 'View agent', exact: true }).scrollIntoViewIfNeeded();
            await captureBuilderScreenshot(page, 'agent-builder-mobile-dark');
          }
          await page.getByRole('button', { name: 'View agent', exact: true }).click();
          const sheet = page.getByRole('dialog', { name: 'Agent view', exact: true });
          await sheet
            .getByRole('list', { name: 'Test conversation' })
            .getByText(/Which policy/)
            .waitFor();
          if (width === 375) await captureBuilderScreenshot(page, 'agent-builder-mobile-test-chat');
          await page.keyboard.press('Escape');
        } else
          await page
            .getByRole('list', { name: 'Test conversation' })
            .getByText(/Which policy/)
            .waitFor();
        assert.equal(
          await instructions.inputValue(),
          'Help teammates find handbook policies. Cite the source and ask when information is missing.',
        );
      }
      await step('Skills');
      await step('Basics');
      await instructions.fill('These are the new standing instructions.');
      await page
        .getByText('This test used an earlier draft. Reset it to test your current choices.', { exact: true })
        .waitFor();
      await page.getByRole('button', { name: 'Reset test', exact: true }).click();
      fixture.oversizedSuggestion();
      await form.getByRole('button', { name: 'Improve instructions', exact: true }).click();
      await form.getByText(/Could not confirm the model response/).waitFor();
      assert.equal(await instructions.inputValue(), 'These are the new standing instructions.');
      assert.equal(await form.getByRole('button', { name: 'Apply suggestion', exact: true }).count(), 0);
      assert.deepEqual(errors, []);
    } catch (error) {
      await captureBrowserFailure(page, 'agent-builder-assistance');
      throw error;
    }
  },
);
