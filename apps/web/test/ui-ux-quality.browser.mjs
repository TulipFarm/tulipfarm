import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const port = 5461,
  origin = `http://127.0.0.1:${port}`;
const shots = process.env.UI_QUALITY_SCREENSHOTS;
const id = n =>
  `${n}`.repeat(8) +
  '-' +
  `${n}`.repeat(4) +
  '-4' +
  `${n}`.repeat(3) +
  '-8' +
  `${n}`.repeat(3) +
  '-' +
  `${n}`.repeat(12);
const [wid, mid, tid, , rid, sid, xid, cid] = Array.from({ length: 9 }, (_, i) => id(i + 1));
const at = '2026-09-30T09:00:00Z';
const workspace = {
  id: wid,
  slug: 'acme',
  name: 'Acme Operations',
  status: 'ready',
  createdAt: at,
  soulCommit: 'a'.repeat(40),
};
const teams = [
  {
    id: tid,
    name: 'Customer Operations',
    description: 'Customer support',
    membershipIds: [mid],
    managerIds: [mid],
    canManage: true,
    canLeave: true,
  },
  {
    id: sid,
    name: 'Finance',
    description: 'Billing',
    membershipIds: [mid],
    managerIds: [mid],
    canManage: true,
    canLeave: true,
  },
  { id: xid, name: 'Sales', description: '', membershipIds: [mid], managerIds: [mid], canManage: true, canLeave: true },
];
const members = [{ id: mid, userId: 'ada', name: 'Ada', email: 'ada@example.com', role: 'admin' }];
const chat = {
  id: cid,
  title: 'Plan customer follow-ups',
  titleRevision: 0,
  archived: false,
  activityAt: at,
  createdAt: at,
};

function fixture(route) {
  const url = new URL(route.request().url()),
    p = url.pathname;
  const send = (json, status = 200) => route.fulfill({ status, json });
  if (p === '/v1/auth/get-session')
    return send({
      session: { id: 'fixture', userId: 'ada' },
      user: { id: 'ada', name: 'Ada', email: 'ada@example.com' },
    });
  if (p === '/v1/workspaces') return send([workspace]);
  if (p === '/v1/workspaces/acme') return send(workspace);
  if (p.endsWith('/settings'))
    return send({ workspaceId: wid, name: workspace.name, slug: 'acme', revision: 1, canManage: true });
  if (p.endsWith('/personal-memory')) return send({ content: '', revision: 1 });
  if (p.endsWith('/credits'))
    return send({ available: 100, granted: 100, used: 0, held: 0, days: [], breakdown: [], series: [] });
  if (p.endsWith('/governance/me'))
    return send({ membershipId: mid, role: 'admin', teams, capabilities: { manageGovernance: true, canLeave: true } });
  if (p.endsWith('/governance'))
    return send({
      actorMembershipId: mid,
      members,
      teams,
      directory: [],
      tableTeamIds: [tid, xid],
      tables: [{ id: rid, name: 'Customers', owningTeamId: tid }],
      grants: [],
    });
  if (p.endsWith('/invitations')) return send([]);
  if (p.endsWith('/model-catalog')) return send({ families: [] });
  if (p.endsWith('/model-policy/availability')) return send({ items: [] });
  if (p.endsWith('/agents/authoring-context')) return send({ currentSoulRevision: 'a'.repeat(40), teams, admin: true });
  if (p.endsWith('/agents')) return send({ agents: [], count: 0, nextCursor: null });
  if (p.endsWith('/tables')) return send({ tables: [], total: 0, nextCursor: null });
  if (p.endsWith('/skills')) return send({ workspace: [], nextCursor: null });
  if (p.endsWith('/conversations')) return send({ chats: [chat], nextCursor: null });
  if (p.endsWith(`/conversations/${cid}`)) return send(chat);
  if (p.endsWith('/messages')) return send({ messages: [], nextBefore: null });
  if (p.endsWith('/chat')) return send({ configured: true });
  if (p.endsWith('/integrations/creation-context')) return send({ teams: teams.map(({ id, name }) => ({ id, name })) });
  if (p.endsWith('/integrations')) return send({ integrations: [] });
  if (p.endsWith('/google-workspace/availability')) return send({ configured: true });
  if (p.endsWith('/google-workspace')) return send({ status: 'disconnected' });
  if (p.endsWith('/atlassian/accounts')) return send({ accounts: [], providers: [] });
  if (p.endsWith('/atlassian/sources'))
    return send({ sources: [], mcp: { enabled: false, explanation: 'Fixture operations unavailable.' } });
  if (p.endsWith('/provider-integrations')) return send([]);
  return send({ error: 'fixture-unavailable' }, 404);
}

const luminance = rgb => {
  const [r, g, b] = rgb
    .match(/[\d.]+/g)
    .slice(0, 3)
    .map(Number)
    .map(v => v / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

// Reduced motion keeps a 0.01ms transition on every property, so read styles after the next frames.
const settle = page =>
  page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

let server, browser;
before(async () => {
  server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: new URL('..', import.meta.url),
    stdio: 'ignore',
  });
  for (
    let i = 0;
    !(await fetch(origin).then(
      r => r.ok,
      () => false,
    ));
    i++
  ) {
    if (i > 300) throw Error('Vite did not start');
    await delay(100);
  }
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  server?.kill('SIGTERM');
});

async function open(path, { theme = 'light', coarse = false } = {}) {
  const viewport = coarse ? { width: 390, height: 844 } : { width: 1440, height: 1000 };
  const context = await browser.newContext({
    viewport,
    colorScheme: theme,
    isMobile: coarse,
    hasTouch: coarse,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/v1/**', fixture);
  await page.goto(origin + path);
  return { page, errors, close: () => context.close() };
}

for (const theme of ['light', 'dark']) {
  test(`keyboard focus is visible on scroll regions but not after a click (${theme})`, async () => {
    const { page, errors, close } = await open(`/acme/chat/${cid}`, { theme });
    const timeline = page.getByRole('region', { name: 'Conversation', exact: true });
    await timeline.waitFor();
    await timeline.click();
    await settle(page);
    assert.equal(
      await timeline.evaluate(node => getComputedStyle(node).outlineStyle),
      'none',
      'a pointer click must not outline the timeline (#740)',
    );
    await page
      .getByRole('heading', { name: chat.title })
      .first()
      .waitFor()
      .catch(() => {});
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Conversation');
    await settle(page);
    const ring = await timeline.evaluate(node => {
      const style = getComputedStyle(node);
      return {
        style: style.outlineStyle,
        width: style.outlineWidth,
        color: style.outlineColor,
        offset: style.outlineOffset,
        surface: getComputedStyle(document.querySelector('[data-slot="sidebar-inset"]') ?? document.body)
          .backgroundColor,
      };
    });
    assert.equal(ring.style, 'solid');
    assert.equal(ring.width, '1px');
    assert.equal(ring.offset, '-1px');
    assert.ok(
      contrast(ring.color, ring.surface) >= 3,
      `region focus ring contrast ${contrast(ring.color, ring.surface).toFixed(2)}`,
    );
    if (shots) await page.screenshot({ path: `${shots}/focus-region-${theme}.png` });
    assert.deepEqual(errors, []);
    await close();
  });

  test(`shared controls use flat idle edges and strong keyboard focus (${theme})`, async () => {
    const { page, errors, close } = await open('/acme/agents/new', { theme });
    const input = page.locator('[data-slot="input"]').first();
    await input.waitFor();
    const scrollbars = await input.evaluate(node => {
      let region = node.parentElement;
      while (region && !['auto', 'scroll'].includes(getComputedStyle(region).overflowY)) region = region.parentElement;
      if (!region) return null;
      const style = getComputedStyle(region);
      const probe = document.createElement('span');
      probe.style.scrollbarColor = 'color-mix(in srgb, var(--muted-foreground) 40%, transparent) transparent';
      region.append(probe);
      const expected = getComputedStyle(probe).scrollbarColor;
      probe.remove();
      return { width: style.scrollbarWidth, color: style.scrollbarColor, expected };
    });
    assert.ok(scrollbars, 'The form has a native scroll region');
    assert.equal(scrollbars.width, 'thin', 'Outer page scrollbars stay thin');
    assert.equal(scrollbars.color, scrollbars.expected, 'Native scrollbars use themed thumbs and transparent tracks');
    await page.getByRole('heading', { level: 1 }).first().click();
    await settle(page);
    const outline = page.locator('[data-slot="button"][data-variant="outline"]:visible').first();
    const edge = await outline.evaluate(node => getComputedStyle(node).borderTopColor);
    const controls = await page
      .locator(
        '[data-slot="input"]:visible, [data-slot="textarea"]:visible, [data-slot="select-trigger"]:visible, [data-slot="input-group"][data-variant="default"]:visible, [data-slot="button"][data-variant="outline"]:visible',
      )
      .evaluateAll(nodes =>
        nodes
          .filter(node => getComputedStyle(node).borderTopWidth !== '0px')
          .map(node => ({
            slot: node.dataset.slot,
            border: getComputedStyle(node).borderTopColor,
            shadow: getComputedStyle(node).boxShadow,
          })),
      );
    assert.ok(controls.some(control => control.slot === 'input'));
    assert.ok(controls.some(control => control.slot === 'textarea'));
    for (const control of controls) {
      assert.equal(control.border, edge, `${control.slot} shares the idle outline edge`);
      assert.equal(control.shadow, 'none', `${control.slot} is flat when idle`);
    }
    await page.keyboard.press('Tab');
    await input.focus();
    await settle(page);
    const measured = await input.evaluate(node => {
      let surface = node.parentElement;
      while (surface && ['rgba(0, 0, 0, 0)', 'transparent'].includes(getComputedStyle(surface).backgroundColor))
        surface = surface.parentElement;
      const style = getComputedStyle(node);
      return {
        focused: node.matches(':focus-visible'),
        border: style.borderTopColor,
        outline: style.outlineColor,
        width: style.outlineWidth,
        fill: style.backgroundColor,
        surface: getComputedStyle(surface ?? document.body).backgroundColor,
      };
    });
    assert.equal(measured.focused, true);
    assert.notEqual(measured.border, edge, 'keyboard focus is stronger than the idle edge');
    assert.ok(Number.parseFloat(measured.width) >= 1, 'keyboard focus has a visible outline');
    assert.ok(
      contrast(measured.outline, measured.surface) >= 3,
      `focus vs surface ${contrast(measured.outline, measured.surface).toFixed(2)}`,
    );
    assert.ok(
      contrast(measured.border, measured.fill) >= 3,
      `focus vs fill ${contrast(measured.border, measured.fill).toFixed(2)}`,
    );
    if (shots) await page.screenshot({ path: `${shots}/field-boundary-${theme}.png` });
    assert.deepEqual(errors, []);
    await close();
  });
}

test('clearing a search with the keyboard keeps focus in the search box', async () => {
  const { page, errors, close } = await open('/acme/integrations');
  const search = page.getByRole('searchbox').first();
  await search.fill('Gmail');
  await search.focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Clear search');
  await page.keyboard.press('Enter');
  assert.equal(await search.inputValue(), '');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('type')), 'search');
  assert.deepEqual(errors, []);
  await close();
});

test('clearing the chat list search keeps focus in the search box', async () => {
  const { page, errors, close } = await open('/acme/chat');
  const search = page.getByLabel('Search chat titles', { exact: true });
  await search.fill('Pricing');
  await search.focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Clear search');
  await page.keyboard.press('Enter');
  assert.equal(await search.inputValue(), '');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'chat-search');
  assert.deepEqual(errors, []);
  await close();
});

test('coarse pointers get 44px select options while fine pointers keep compact options', async () => {
  for (const coarse of [true, false]) {
    const { page, errors, close } = await open('/acme/grants', { coarse });
    await page.getByLabel('Team receiving access').click();
    const option = page.getByRole('option', { name: 'Sales', exact: true });
    await option.waitFor();
    const { height } = await option.boundingBox();
    if (coarse) assert.ok(height >= 44, `coarse option height ${height}`);
    else assert.ok(height < 36, `fine option height ${height}`);
    if (shots) await page.screenshot({ path: `${shots}/select-options-${coarse ? 'coarse' : 'fine'}.png` });
    assert.deepEqual(errors, []);
    await close();
  }
});

test('the whole choice row toggles its checkbox', async () => {
  const { page, errors, close } = await open('/acme/agents/new', { coarse: true });
  // Actions sit on the builder's Access step, chosen from a select below sm (cloud 3e124b0f #1004, features/agents/builder-layout.tsx:49-50).
  await page.getByRole('combobox', { name: 'Setup section', exact: true }).click();
  await page.getByRole('option', { name: '3. Access', exact: true }).click();
  const group = page.getByRole('region', { name: 'Tables actions', exact: true });
  await group.getByRole('button').first().click();
  const option = group
    .locator('[data-slot="choice-option"]')
    .filter({ has: page.getByRole('checkbox') })
    .first();
  await option.scrollIntoViewIfNeeded();
  const checkbox = option.getByRole('checkbox');
  const before = await checkbox.getAttribute('aria-checked');
  const box = await option.boundingBox(),
    label = await option.locator('label').boundingBox();
  assert.ok(box.height >= 44, `choice row height ${box.height}`);
  await page.mouse.click(box.x + box.width - 8, box.y + box.height - 4);
  assert.notEqual(
    await checkbox.getAttribute('aria-checked'),
    before,
    `clicking row whitespace below the ${label.height}px label toggles the choice`,
  );
  await option.getByText(await option.locator('label span').last().innerText(), { exact: true }).click();
  assert.equal(
    await checkbox.getAttribute('aria-checked'),
    before,
    'the label text stays clickable above the row hit area',
  );
  const described = page
    .locator('[data-slot="choice-option"]')
    .filter({ has: page.locator('p') })
    .first();
  if (await described.count()) {
    const toggle = described.getByRole('checkbox'),
      was = await toggle.getAttribute('aria-checked');
    const text = await described.locator('p').boundingBox();
    await page.mouse.click(text.x + text.width / 2, text.y + text.height / 2);
    assert.notEqual(
      await toggle.getAttribute('aria-checked'),
      was,
      'clicking the option description toggles the choice',
    );
  }
  assert.deepEqual(errors, []);
  await close();
});

test('workspace pages expose one top-level main landmark', async () => {
  for (const path of ['/acme/settings', '/acme/grants', '/acme/integrations', '/acme/does-not-exist']) {
    const { page, errors, close } = await open(path);
    await page.getByRole('heading', { level: 1 }).first().waitFor();
    assert.deepEqual(
      await page.evaluate(() => ({
        mains: document.querySelectorAll('main, [role="main"]').length,
        nested: !!document.querySelector('main main, main [role="main"]'),
      })),
      { mains: 1, nested: false },
      path,
    );
    assert.deepEqual(errors, []);
    await close();
  }
});
