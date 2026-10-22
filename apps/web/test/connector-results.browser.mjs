import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

test(
  'actual connector cards open Canvas and preserve confirmed, pending, unknown and withheld states',
  { timeout: 150000 },
  async () => {
    const server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(15000);
    const errors = [],
      external = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (['http:', 'https:'].includes(url.protocol) && url.hostname !== '127.0.0.1') {
        external.push(url.hostname);
        return route.abort();
      }
      return route.continue();
    });
    const canvas = page.getByRole('region', { name: 'Canvas', exact: true });
    const open = async (suffix = '') => {
      await page.goto(
        `${server.resolvedUrls.local[0]}bud-mock/chat/23232323-2323-4323-8323-232323232323?start=connector-results${suffix}`,
      );
      await page.getByRole('button', { name: 'View GitHub changes', exact: true }).waitFor();
    };
    try {
      await open();
      for (const name of ['Google Docs', 'Google Sheets', 'Google Slides'])
        await page.getByText(`Saved in ${name}`, { exact: true }).waitFor();
      await page.getByText('Confirmed in Slack', { exact: true }).waitFor();
      await page.getByText('1 action confirmed in GitHub', { exact: true }).waitFor();
      const githubLogo = page.locator('[id^="github-batch:"] [data-brand="github"]');
      assert.deepEqual(
        await githubLogo.evaluate(element => {
          const { width, height } = element.getBoundingClientRect();
          return { width, height };
        }),
        { width: 18, height: 18 },
        'monochrome app logos fill the same tile interior as color logos',
      );
      assert.equal(await canvas.count(), 0);
      const activity = page.getByRole('region', { name: 'Activity: Recorded activity', exact: true });
      assert.deepEqual(
        await activity.locator('[data-result-app]').evaluateAll(nodes => nodes.map(node => node.dataset.resultApp)),
        ['jira', 'confluence'],
      );
      await activity.getByRole('button', { name: '3 more apps', exact: true }).click();
      const popup = page.getByRole('dialog', { name: '3 more apps', exact: true });
      for (const name of ['Trello', 'Gmail', 'Connected apps'])
        await popup.getByRole('heading', { name, exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await activity.getByRole('button', { name: 'View activity' }).click();
      await canvas
        .getByRole('region', { name: 'Jira', exact: true })
        .getByText('Search Jira issues', { exact: true })
        .waitFor();
      await page.getByRole('button', { name: 'View GitHub changes', exact: true }).click();
      await canvas.getByRole('heading', { name: '1. issue.create · succeeded', exact: true }).waitFor();
      assert.equal(await canvas.getByRole('button', { name: 'Approve exact batch' }).count(), 0);
      await page.getByRole('button', { name: 'View Slack action', exact: true }).click();
      await canvas.getByText('Slack confirmed this action.', { exact: true }).waitFor();
      for (const width of [320, 375, 414, 768, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
          `${width}: no page overflow`,
        );
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      await open('-unknown');
      assert.equal(await page.getByText(/^Saved in Google/).count(), 0);
      await page.getByRole('button', { name: 'View Slack action', exact: true }).click();
      await canvas.getByText(/Delivery outcome is unknown/).waitFor();
      assert.equal(await canvas.getByRole('button', { name: 'Approve action', exact: true }).count(), 0);
      await page.getByRole('button', { name: 'View GitHub changes', exact: true }).click();
      await canvas.getByRole('button', { name: 'Reconcile with GitHub' }).waitFor();
      assert.equal(await canvas.getByRole('button', { name: 'Run approved batch' }).count(), 0);
      await open('-pending');
      await page.getByRole('button', { name: 'View Slack action', exact: true }).click();
      await canvas.getByRole('button', { name: 'Approve action', exact: true }).waitFor();
      assert.equal(await page.getByText('Confirmed in Slack', { exact: true }).count(), 0);
      await page.getByRole('button', { name: 'View GitHub changes', exact: true }).click();
      await canvas.getByRole('button', { name: 'Approve exact batch' }).waitFor();
      await page.evaluate(() => {
        const fetch = window.fetch.bind(window);
        const request = { calls: 0, confirmed: false, release: null };
        window.githubRequest = request;
        window.fetch = async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input), location.href);
          if (url.pathname.includes('/github/chats/') && init?.method === 'POST') {
            request.calls++;
            await new Promise(resolve => {
              request.release = resolve;
            });
            return Response.json({ error: 'lost-response' }, { status: 503 });
          }
          const response = await fetch(input, init);
          if (request.confirmed && url.pathname.endsWith('/batches')) {
            const result = await response.json();
            for (const batch of result.batches) {
              batch.decision = 'approve';
              batch.actions = batch.actions.map(action => ({ ...action, status: 'succeeded', result: { number: 12 } }));
            }
            return Response.json(result);
          }
          return response;
        };
      });
      await canvas.getByRole('button', { name: 'Approve exact batch' }).click();
      await page.waitForFunction(() => window.githubRequest.calls === 1);
      await page.getByRole('button', { name: 'Close GitHub changes', exact: true }).click();
      await page.getByRole('button', { name: 'View GitHub changes', exact: true }).click();
      await canvas.getByText('The request is still in progress. Do not submit it again.', { exact: true }).waitFor();
      assert.equal(await canvas.getByRole('button', { name: 'Reject batch' }).isDisabled(), true);
      assert.equal(await canvas.getByRole('button', { name: 'Applying approved batch…' }).isDisabled(), true);
      await page.evaluate(() => window.githubRequest.release());
      await canvas.getByRole('button', { name: 'Check batch status' }).waitFor();
      await page.getByRole('button', { name: 'Close GitHub changes', exact: true }).click();
      await page.getByRole('button', { name: 'View GitHub changes', exact: true }).click();
      assert.equal(await canvas.getByRole('button', { name: 'Approve exact batch' }).isDisabled(), true);
      await canvas.getByRole('button', { name: 'Check batch status' }).click();
      assert.equal(
        await canvas.getByRole('button', { name: 'Approve exact batch' }).isDisabled(),
        true,
        'an unchanged pending read cannot prove the lost decision failed',
      );
      await page.evaluate(() => {
        window.githubRequest.confirmed = true;
      });
      await canvas.getByRole('button', { name: 'Check batch status' }).click();
      await canvas.getByRole('heading', { name: '1. issue.create · succeeded', exact: true }).waitFor();
      assert.equal(await canvas.getByRole('alert').count(), 0);
      assert.equal(
        await page.evaluate(() => window.githubRequest.calls),
        1,
        'closing and reopening never replays the decision',
      );
      await open('-pending');
      await page.getByRole('button', { name: 'View Slack action', exact: true }).click();
      await canvas.getByRole('button', { name: 'Approve action', exact: true }).waitFor();
      await page.evaluate(() => {
        const fetch = window.fetch.bind(window);
        const request = { calls: 0, confirmed: false, release: null };
        window.slackRequest = request;
        window.fetch = async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input), location.href);
          if (url.pathname.includes('/slack/actions/') && init?.method === 'PUT') {
            request.calls++;
            await new Promise(resolve => {
              request.release = resolve;
            });
            throw new TypeError('Synthetic lost acknowledgement');
          }
          const response = await fetch(input, init);
          if (request.confirmed && url.pathname.includes('/slack/actions/')) {
            return Response.json({ ...(await response.json()), status: 'sent', sentMessageTs: '1234567890.123456' });
          }
          return response;
        };
      });
      await canvas.getByRole('button', { name: 'Approve action', exact: true }).click();
      await page.waitForFunction(() => window.slackRequest.calls === 1);
      await page.getByRole('button', { name: 'Close Slack action', exact: true }).click();
      await page.getByRole('button', { name: 'View Slack action', exact: true }).click();
      assert.equal(await canvas.getByRole('button', { name: 'Approve action', exact: true }).isDisabled(), true);
      await page.evaluate(() => window.slackRequest.release());
      await canvas
        .getByText('The last decision is unconfirmed. Check status before taking another action.', { exact: true })
        .waitFor();
      await page.getByRole('button', { name: 'Close Slack action', exact: true }).click();
      await page.getByRole('button', { name: 'View Slack action', exact: true }).click();
      await canvas.getByRole('button', { name: 'Check Slack action status', exact: true }).click();
      assert.equal(await canvas.getByRole('button', { name: 'Approve action', exact: true }).isDisabled(), true);
      await page.evaluate(() => {
        window.slackRequest.confirmed = true;
      });
      await canvas.getByRole('button', { name: 'Check Slack action status', exact: true }).click();
      await canvas.getByText('Slack confirmed this action.', { exact: true }).waitFor();
      assert.equal(
        await canvas.getByRole('alert').count(),
        0,
        'a fresh confirmed status clears the retained uncertainty',
      );
      assert.equal(await page.evaluate(() => window.slackRequest.calls), 1);
      await open('-withheld');
      await page.getByText('Private details unavailable', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'View GitHub changes', exact: true }).click();
      await canvas.getByText(/Private details are hidden/).waitFor();
      assert.doesNotMatch(await canvas.innerText(), /Review the launch brief|Local seeded issue/);
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
    } catch (error) {
      console.error(errors, await page.locator('body').innerText());
      await page.screenshot({ path: '/tmp/connector-results-failure.png' });
      throw error;
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
