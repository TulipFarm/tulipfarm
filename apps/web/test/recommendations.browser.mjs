import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { fallbackRecommendations } from '@tulipfarm/recommendations';
import { governanceSnapshot } from './governance-snapshot.mjs';
import { catalogFamily } from '../src/features/models/catalog-fixture.ts';

const port = Number(process.env.RECOMMENDATIONS_PORT ?? 5319);
const origin = `http://127.0.0.1:${port}`;
const capture = process.env.RECOMMENDATIONS_SCREENSHOTS;
const cdpPort = process.env.RECOMMENDATIONS_CDP_PORT;
const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
  env: process.env,
});
const workspace = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'acme',
  name: 'Acme',
  status: 'ready',
  createdAt: '2026-09-30T00:00:00Z',
  soulCommit: 'a'.repeat(40),
};
const memberId = '22222222-2222-4222-8222-222222222222';
const teams = [{ id: '33333333-3333-4333-8333-333333333333', name: 'Operations' }];
const family = (id, displayName, provider) =>
  catalogFamily(id, {
    displayName,
    provider,
    currentVersion: `${id}-v1`,
    inputCreditsPerMillionTokens: 300,
    outputCreditsPerMillionTokens: 1500,
    mappingRevision: 'mapping-1',
    pricingRevision: 'pricing-1',
  });
const dynamic = {
  onboarding: true,
  status: 'ready',
  version: 1,
  items: [
    {
      id: 'connect-apps',
      kind: 'onboarding',
      label: 'Connect Slack, Google, or GitHub',
      brands: [],
      action: { kind: 'open', destination: 'integrations' },
    },
    {
      id: 'create-workflow',
      kind: 'onboarding',
      label: 'Automate a repeated task',
      brands: [],
      action: { kind: 'prompt', prompt: 'Help me turn a task I repeat every week into a Workflow.' },
    },
    {
      id: 'inbox',
      kind: 'prompt',
      label: 'Triage my unread email',
      brands: ['gmail'],
      action: { kind: 'prompt', prompt: 'Review my unread Gmail and list what needs a reply today.' },
    },
    ...fallbackRecommendations.slice(1, 3),
  ],
};

let browser;
try {
  for (let attempt = 0; ; attempt++) {
    if (
      await fetch(origin).then(
        response => response.ok,
        () => false,
      )
    )
      break;
    assert.ok(attempt < 100, 'Vite starts');
    await delay(100);
  }
  browser = await chromium.launch({
    headless: true,
    ...(cdpPort ? { args: [`--remote-debugging-port=${cdpPort}`] } : {}),
  });
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      isMobile: mobile,
      hasTouch: mobile,
      reducedMotion: 'reduce',
      colorScheme: mobile ? 'dark' : 'light',
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const Original = window.EventSource;
      const sources = [];
      window.EventSource = class extends EventTarget {
        readyState = 0;
        constructor(url, options) {
          super();
          if (!String(url).endsWith('/recommendations/events')) return new Original(url, options);
          sources.push(this);
          setTimeout(() => {
            if (this.readyState === 2) return;
            this.readyState = 1;
            this.dispatchEvent(new Event('open'));
            this.dispatchEvent(new MessageEvent('resync', { data: '{"kind":"resync"}' }));
          }, 0);
        }
        close() {
          this.readyState = 2;
        }
      };
      window.recommendationEvent = (kind, data) => {
        for (const source of sources)
          if (source.readyState === 1)
            source.dispatchEvent(new MessageEvent(kind, { data: JSON.stringify({ kind, ...data }) }));
      };
    });
    page.setDefaultTimeout(12000);
    let recommendations = { status: 200, json: dynamic };
    let reads = 0;
    let holdReads = false;
    const waitingReads = [];
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let json;
      if (path === '/v1/auth/get-session')
        json = {
          session: { id: 'session-ada', userId: 'ada' },
          user: { id: 'ada', name: 'Ada', email: 'ada@example.com' },
        };
      else if (path === '/v1/workspaces') json = [workspace];
      else if (path === '/v1/workspaces/acme') json = workspace;
      else if (path.endsWith('/recommendations')) {
        assert.equal(route.request().method(), 'GET', 'list recovery never posts generation work');
        reads++;
        const response = structuredClone(recommendations);
        if (holdReads) await new Promise(resolve => waitingReads.push(resolve));
        return route.fulfill(response);
      } else if (path.endsWith('/credits'))
        json = { available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] };
      else if (path.endsWith('/model-catalog'))
        json = { families: [family('claude-sonnet', 'Claude Sonnet', 'anthropic')] };
      else if (path.endsWith('/governance/me'))
        json = {
          membershipId: memberId,
          role: 'admin',
          teams,
          capabilities: { manageGovernance: true, canLeave: true },
        };
      else if (path.endsWith('/governance'))
        json = governanceSnapshot({
          actorMembershipId: memberId,
          members: [{ id: memberId, userId: 'ada', name: 'Ada', email: 'ada@example.com', role: 'admin' }],
          teams: teams.map(team => ({ ...team, description: '', membershipIds: [] })),
          resources: [],
          grants: [],
        });
      else if (path.endsWith('/integrations/creation-context')) json = { teams };
      else if (path.endsWith('/atlassian/accounts'))
        json = {
          accounts: [],
          providers: [
            { protocol: 'atlassian-mcp', configured: false },
            { protocol: 'atlassian-rest', configured: false },
            { protocol: 'trello', configured: false },
          ],
        };
      else if (path.endsWith('/atlassian/sources'))
        json = {
          sources: [],
          mcp: { enabled: false, explanation: 'Provider operations are not configured in this fixture.' },
        };
      else if (path.endsWith('/integrations')) json = { integrations: [] };
      else if (path.endsWith('/provider-integrations') || path.endsWith('/workflows')) json = [];
      else if (path.endsWith('/skills')) json = { workspace: [], nextCursor: null };
      else if (/\/conversations\/[\w-]+$/.test(path) && route.request().method() === 'PUT')
        json = { id: path.split('/').at(-1) };
      else if (/\/conversations\/[\w-]+\/messages\/[\w-]+$/.test(path))
        json = { messageId: path.split('/').at(-1), turnId: path.split('/').at(-1), sequence: 1 };
      else if (path.endsWith('/messages')) json = { messages: [], nextBefore: null };
      else return route.fulfill({ status: 503, json: { error: 'unavailable' } });
      await route.fulfill({ json });
    });
    const suffix = mobile ? 'mobile' : 'desktop';
    const shot = async name => {
      if (capture) {
        await page.screenshot({ path: `${capture}/${name}-${suffix}.png` });
      }
    };
    const emit = (kind, version) =>
      page.evaluate(
        ({ kind, workspaceId, membershipId, version }) =>
          window.recommendationEvent(kind, { workspaceId, membershipId, version }),
        { kind, workspaceId: workspace.id, membershipId: memberId, version },
      );
    const region = page.getByRole('region', { name: 'Recommended for you' });

    await page.goto(`${origin}/acme`);
    await region.getByRole('button', { name: /Connect Slack, Google, or GitHub/ }).waitFor();
    // The home shows three suggested tasks as bento cards, then the first setup step as one more card.
    const cards = region.getByRole('button');
    const chipLabels = () =>
      cards.evaluateAll(buttons =>
        buttons.map(button => button.querySelector(':scope > span:last-child > span:nth-child(2)').textContent.trim()),
      );
    assert.deepEqual(
      await chipLabels(),
      ['Triage my unread email', 'Draft a support reply', 'Plan my week', 'Connect Slack, Google, or GitHub'],
      'Three task cards, then setup starts with one next step',
    );
    assert.deepEqual(
      await cards.evaluateAll(buttons =>
        buttons.map(button => button.querySelector(':scope > span:last-child > span:first-child').textContent),
      ),
      ['Suggested for you', 'Suggested task', 'Suggested task', 'Set up your workspace'],
      'Each card names what kind of suggestion it is',
    );
    assert.equal(await region.getByRole('button', { name: /Automate a repeated task/ }).count(), 0);
    assert.equal(await region.getByRole('button', { name: /Plan customer follow-ups/ }).count(), 0);
    assert.equal(
      await cards.evaluateAll(buttons => buttons.filter(button => button.querySelector('.rounded-xl svg')).length),
      4,
      'Each card leads with its task icon',
    );
    const chipHeights = await cards.evaluateAll(buttons =>
      buttons.map(button => button.getBoundingClientRect().height),
    );
    assert.ok(
      chipHeights.every(height => height >= 44) && chipHeights[0] >= Math.max(...chipHeights.slice(1)),
      `Cards keep touch targets and the featured card is the tallest: ${chipHeights}`,
    );
    await shot('recommendations');

    {
      recommendations = { status: 200, json: { ...dynamic, status: 'pending', version: 2 } };
      await emit('changed', 2);
      await page.getByText('New recommendations are waiting for a background update.').waitFor();
      assert.equal(
        await region.getByRole('button', { name: /Triage my unread email/ }).count(),
        1,
        'pending keeps the last safe list',
      );
      await shot('pending');
      recommendations = { status: 200, json: { ...dynamic, status: 'budget-paused', version: 2 } };
      await emit('changed', 2);
      await page.getByText('Background updates are paused at the platform spending limit.').waitFor();
      await shot('budget-paused');
      recommendations = { status: 200, json: { ...dynamic, status: 'failed', version: 2 } };
      await emit('changed', 2);
      await page.getByText('The background update failed. You can still use the prompts below.').waitFor();
      recommendations = {
        status: 200,
        json: {
          ...dynamic,
          version: 3,
          items: dynamic.items.map(item =>
            item.id === 'inbox' ? { ...item, label: "Review this week's customer emails" } : item,
          ),
        },
      };
      await emit('changed', 3);
      await region.getByRole('button', { name: "Review this week's customer emails" }).waitFor();
      await shot('background-published');
      holdReads = true;
      await emit('changed', 4);
      for (let attempts = 0; waitingReads.length === 0; attempts++) {
        assert.ok(attempts < 100);
        await delay(10);
      }
      recommendations = {
        status: 200,
        json: { onboarding: false, status: 'pending', version: 5, items: fallbackRecommendations },
      };
      await emit('invalidated', 5);
      await region.getByRole('button', { name: /Plan customer follow-ups/ }).waitFor();
      assert.equal(
        await region.getByRole('button', { name: /customer emails/ }).count(),
        0,
        'unsafe text clears before a new read finishes',
      );
      await shot('invalidated');
      holdReads = false;
      for (const release of waitingReads.splice(0)) release();
      await page.getByText('New recommendations are waiting for a background update.').waitFor();
      assert.equal(
        await region.getByRole('button', { name: /customer emails/ }).count(),
        0,
        'a canceled late response cannot restore private text',
      );
      recommendations = { status: 503, json: { error: 'recommendations-unavailable' } };
      await emit('changed', 6);
      const reload = page.getByRole('button', { name: 'Try again', exact: true });
      await reload.waitFor();
      assert.equal(
        await page.getByText('Saved recommendations could not be loaded.').count(),
        1,
        'Read errors remain visible',
      );
      await shot('read-error');
      recommendations = { status: 200, json: { ...dynamic, version: 6 } };
      await reload.click();
      await region.getByRole('button', { name: /Triage my unread email/ }).waitFor();
      recommendations = {
        status: 200,
        json: { onboarding: false, status: 'unavailable', version: 7, items: fallbackRecommendations },
      };
      await emit('changed', 7);
      await region.getByRole('button', { name: /Plan customer follow-ups/ }).waitFor();
      assert.deepEqual(
        await chipLabels(),
        ['Plan customer follow-ups', 'Draft a support reply', 'Plan my week'],
        'An unavailable saved list offers the first three generic prompts and no setup step',
      );
      assert.equal(
        await page.getByText('Personal recommendations are not available. You can use these general prompts.').count(),
        0,
        'Generic prompts have no unavailable footer',
      );
      await shot('unavailable');
      recommendations = { status: 200, json: { ...dynamic, version: 8 } };
      await emit('changed', 8);
      await region.getByRole('button', { name: /Triage my unread email/ }).waitFor();
    }

    const sent = page.waitForRequest(request => /\/messages\/[\w-]+$/.test(new URL(request.url()).pathname));
    await region.getByRole('button', { name: /Triage my unread email/ }).click();
    assert.match((await sent).postDataJSON().parts[0].text, /unread Gmail/, 'A prompt item sends its prompt');
    await shot('sent');

    await page.goto(`${origin}/acme`);
    await region.getByRole('button', { name: /Connect Slack, Google, or GitHub/ }).click();
    await page.waitForURL(`${origin}/acme/integrations`);

    const before = reads;
    recommendations = { status: 503, json: { error: 'recommendations-unavailable' } };
    await page.goto(`${origin}/acme`);
    await region.getByRole('button', { name: /Plan customer follow-ups/ }).waitFor();
    assert.ok(reads > before, 'The list reads recommendations again');
    assert.equal(
      await region.getByRole('button', { name: /Connect Slack/ }).count(),
      0,
      'Failures fall back to generic prompts',
    );
    await shot('fallback');
    if (cdpPort && mobile && capture)
      execFileSync(
        'agent-browser',
        [
          '--session',
          'recommendations',
          '--cdp',
          cdpPort,
          'screenshot',
          `${capture}/fallback-mobile-agent-browser.png`,
        ],
        { stdio: 'pipe' },
      );
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('recommendations browser checks passed');
} finally {
  try {
    if (cdpPort) execFileSync('agent-browser', ['--session', 'recommendations', 'close'], { stdio: 'ignore' });
  } finally {
    try {
      await browser?.close();
    } finally {
      server.kill('SIGTERM');
    }
  }
}
