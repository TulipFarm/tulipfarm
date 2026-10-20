import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { agentBuilderFixture } from './agent-builder.fixture.mjs';
import {
  startBuiltApp,
  builderBrowserOptions,
  captureBuilderScreenshot,
  captureBrowserFailure,
} from './built-app.fixture.mjs';

async function environment(t) {
  const server = await startBuiltApp();
  t.after(() => server.close());
  const browser = await chromium.launch(builderBrowserOptions());
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10000);
  const errors = [],
    fixture = agentBuilderFixture();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/v1/**', route => {
    const request = route.request();
    return route.fulfill(fixture.respond(request.method(), request.url(), request.postDataJSON()));
  });
  await page.goto(`${server.origin}/${fixture.workspace.slug}/agents/new`);
  const form = page.getByRole('form', { name: 'Agent setup', exact: true });
  const step = name =>
    page
      .getByRole('tab', { name: new RegExp(name) })
      .first()
      .click();
  await form.getByLabel('Agent name', { exact: true }).waitFor();
  return { page, fixture, errors, form, step };
}

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
      await step('Skills');
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
      await form.getByRole('button', { name: 'Add schedule', exact: true }).click();
      await form
        .getByRole('textbox', { name: 'Task prompt', exact: true })
        .fill('Prepare the weekly People Ops update.');
      await step('Basics');
      await form.getByRole('heading', { name: 'Identity', exact: true }).scrollIntoViewIfNeeded();
      await captureBuilderScreenshot(page, 'agent-builder-desktop');
      await step('Review');
      await form
        .getByRole('region', { name: 'Reviewed scheduled tasks' })
        .getByText('Prepare the weekly People Ops update.', { exact: true })
        .waitFor();
      fixture.loseNextPublication();
      await form.getByRole('button', { name: 'Save draft', exact: true }).click();
      await form.getByRole('button', { name: 'Retry same operation', exact: true }).click();
      await form.getByText('Draft saved. Slack channels and schedules are not started.', { exact: true }).waitFor();
      const saves = fixture.requests.filter(request => request.path.endsWith('/setup'));
      assert.equal(saves.length, 2);
      assert.deepEqual(saves[0].body, saves[1].body, 'uncertain publication reuses exact review and identity');
      assert.equal(fixture.publications.size, 1);
      const setup = [...fixture.setups.values()][0].setup;
      assert.equal(setup.owningTeamId, fixture.team.id);
      assert.deepEqual(setup.definition.tools, ['rows.get']);
      assert.equal(setup.definition.skills.length, 2);
      assert.equal(setup.slackChannels.length, 2);
      assert.equal(setup.schedules[0].action.text, 'Prepare the weekly People Ops update.');
      assert.deepEqual(setup.policy, { grants: [], personGrants: [] }, 'placement never silently shares');
      assert.deepEqual(saves[0].body.consent.sponsorScheduleIds, [], 'saving needs no sponsor approval');
      await page.reload();
      await form.getByRole('button', { name: 'Continue editing', exact: true }).click();
      await step('Triggers');
      assert.equal(await form.getByText('Check needed', { exact: true }).count(), 2);
      for (const recheck of await form.getByRole('button', { name: 'Recheck', exact: true }).all())
        await recheck.click();
      await form
        .getByRole('checkbox', { name: 'I sponsor these runs with my current permissions', exact: true })
        .check();
      await step('Review');
      await form.getByRole('button', { name: 'Create and activate', exact: true }).click();
      await page.getByRole('heading', { name: 'Agent created and activated.', exact: true }).waitFor();
      assert.equal(fixture.publications.size, 2);
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
    .getByText('Instructions saved, but setup is incomplete. No new triggers were started.', { exact: true })
    .waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Agent created and activated.', exact: true }).count(), 0);
  assert.equal(fixture.publications.size, 1);
  await form.getByRole('button', { name: 'Retry this setup', exact: true }).click();
  await page.getByRole('heading', { name: 'Agent created and activated.', exact: true }).waitFor();
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
