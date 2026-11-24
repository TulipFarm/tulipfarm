// Drives a real Chromium against a local site. Needs Playwright's Chromium, or CHROMIUM_EXECUTABLE_PATH.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { createBrowserHost } from '../src/host.ts';

const pages = {
  '/': `<!doctype html><title>Sign up</title>
    <h1>Create an account</h1>
    <form action="/done">
      <label>Email <input name="email" type="email"></label>
      <label style="position:absolute;left:0;top:400px;width:600px;height:80px"><input type="checkbox" name="terms"> I agree to the terms</label>
      <label>Plan <select name="plan"><option>Free</option><option>Team</option></select></label>
      <button type="submit">Sign up</button>
    </form>
    <a href="/popup" target="_blank">Open help</a>`,
  '/popup': `<!doctype html><title>Help</title><p>Help centre</p>`,
  '/slow': `<!doctype html><title>Slow</title>
    <button disabled onclick="document.title = 'Clicked'">Continue</button>
    <script>setTimeout(() => (document.querySelector('button').disabled = false), 1200)</script>`,
};

let site;
let origin;
let internal;
before(async () => {
  internal = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>Internal</title><p>internal secret</p>');
  });
  internal.listen(0, '::1');
  await once(internal, 'listening');
  site = createServer((request, response) => {
    const url = new URL(request.url, 'http://x');
    if (url.pathname === '/redirect') {
      response.writeHead(302, { location: `http://[::1]:${internal.address().port}/` });
      return response.end();
    }
    if (url.pathname === '/done') {
      response.writeHead(200, { 'content-type': 'text/html' });
      return response.end(
        `<!doctype html><title>Welcome</title><p>${[...url.searchParams].map(([k, v]) => `${k}=${v}`).join(' ')}</p>`,
      );
    }
    response.writeHead(pages[url.pathname] ? 200 : 404, { 'content-type': 'text/html' });
    response.end(pages[url.pathname] ?? 'missing');
  });
  site.listen(0, '127.0.0.1');
  await once(site, 'listening');
  origin = `http://127.0.0.1:${site.address().port}`;
});
after(() => {
  site.close();
  internal.close();
});

const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || undefined;
const sessionId = '00000000-0000-4000-8000-000000000001';
const options = { executablePath, maxSessions: 2, idleMs: 60_000, holdMs: 120_000 };

function ref(snapshot, pattern) {
  const line = snapshot.split('\n').find(candidate => pattern.test(candidate));
  assert.ok(line, `no line matches ${pattern} in\n${snapshot}`);
  return /\[ref=([a-z0-9]+)\]/.exec(line)[1];
}

test('the agent fills a form and the person takes over to tick a box', async t => {
  const host = await createBrowserHost({ ...options, allowPrivateNetworks: true });
  t.after(() => host.shutdown());
  await host.open(sessionId);
  let result = await host.act(sessionId, { action: 'navigate', url: `${origin}/` });
  assert.equal(result.state.title, 'Sign up');
  assert.ok(result.screenshot.length > 1000);

  result = await host.act(sessionId, {
    action: 'type',
    ref: ref(result.snapshot, /textbox "Email"/),
    text: 'a@b.co',
    submit: false,
  });
  result = await host.act(sessionId, {
    action: 'select',
    ref: ref(result.snapshot, /combobox "Plan"/),
    values: ['Team'],
  });

  const waiting = await host.needsPerson(sessionId, 'Tick the terms box');
  assert.equal(waiting.needsPerson, 'Tick the terms box');

  await assert.rejects(host.input(sessionId, { type: 'text', text: 'x' }), { code: 'agent-in-control' });
  await host.control(sessionId, { controller: 'person', memberId: 'member-1' });
  await assert.rejects(host.act(sessionId, { action: 'snapshot' }), { code: 'person-in-control' });

  const events = [];
  const unsubscribe = await host.subscribe(sessionId, event => events.push(event.type));
  // The person clicks the terms label through the live view, in viewport pixels.
  const [x, y] = [300, 440];
  for (const event of ['mousePressed', 'mouseReleased'])
    await host.input(sessionId, { type: 'mouse', event, x, y, button: 'left', clickCount: 1, modifiers: 0 });
  await new Promise(resolve => setTimeout(resolve, 300));
  unsubscribe();
  assert.ok(events.includes('state'));
  assert.ok(events.includes('frame'));

  const handed = await host.control(sessionId, { controller: 'agent' });
  assert.equal(handed.needsPerson, null);
  result = await host.act(sessionId, { action: 'snapshot' });
  assert.match(result.snapshot, /checkbox "I agree to the terms" \[checked\]/);
  result = await host.act(sessionId, { action: 'click', ref: ref(result.snapshot, /button "Sign up"/) });
  assert.equal(result.state.title, 'Welcome');
  assert.match(result.snapshot, /email=a@b.co terms=on plan=Team/);
});

test('a stale ref asks the agent for a new snapshot', async t => {
  const host = await createBrowserHost({ ...options, allowPrivateNetworks: true });
  t.after(() => host.shutdown());
  await host.open(sessionId);
  await host.act(sessionId, { action: 'navigate', url: `${origin}/` });
  await assert.rejects(host.act(sessionId, { action: 'click', ref: 'e999' }), { code: 'ref-not-found' });
});

test('a new tab becomes the page the agent sees', async t => {
  const host = await createBrowserHost({ ...options, allowPrivateNetworks: true });
  t.after(() => host.shutdown());
  await host.open(sessionId);
  const result = await host.act(sessionId, { action: 'navigate', url: `${origin}/` });
  const opened = await host.act(sessionId, { action: 'click', ref: ref(result.snapshot, /link "Open help"/) });
  await new Promise(resolve => setTimeout(resolve, 300));
  const state = await host.state(sessionId);
  assert.equal(state.title, 'Help', JSON.stringify(opened.state));
});

test('private addresses are blocked unless allowed', async t => {
  const host = await createBrowserHost(options);
  t.after(() => host.shutdown());
  await host.open(sessionId);
  const result = await host.act(sessionId, { action: 'navigate', url: `${origin}/` });
  assert.match(result.notice ?? '', /only opens public websites/);
  assert.notEqual(result.state.title, 'Sign up');
});

test('a redirect to a blocked address is refused at every hop', async t => {
  const host = await createBrowserHost({ ...options, allowAddress: address => address === '127.0.0.1' });
  t.after(() => host.shutdown());
  await host.open(sessionId);
  const result = await host.act(sessionId, { action: 'navigate', url: `${origin}/redirect` });
  assert.notEqual(result.state.title, 'Internal');
  assert.doesNotMatch(result.snapshot, /internal secret/);
});

test('taking over waits for the agent action already running', async t => {
  const host = await createBrowserHost({ ...options, allowPrivateNetworks: true });
  t.after(() => host.shutdown());
  await host.open(sessionId);
  const page = await host.act(sessionId, { action: 'navigate', url: `${origin}/slow` });
  const clicking = host.act(sessionId, { action: 'click', ref: ref(page.snapshot, /button "Continue"/) });
  await new Promise(resolve => setTimeout(resolve, 100));
  const state = await host.control(sessionId, { controller: 'person', memberId: 'member-1' });
  assert.equal(state.title, 'Clicked');
  assert.equal(state.controller, 'person');
  await clicking;
});

test('idle sessions close, and sessions waiting for a person are held longer', async t => {
  let clock = 0;
  const host = await createBrowserHost({ ...options, idleMs: 1000, holdMs: 5000, now: () => clock });
  t.after(() => host.shutdown());
  const waiting = '00000000-0000-4000-8000-000000000002';
  await host.open(sessionId);
  await host.open(waiting);
  await host.needsPerson(waiting, 'Solve the captcha');
  clock = 2000;
  assert.equal(await host.sweep(), 1);
  assert.equal(await host.state(waiting).then(state => state.needsPerson), 'Solve the captcha');
  clock = 8000;
  assert.equal(await host.sweep(), 1);
  assert.equal(host.size(), 0);
});

test('the host refuses sessions beyond its capacity', async t => {
  const host = await createBrowserHost({ ...options, maxSessions: 1 });
  t.after(() => host.shutdown());
  await host.open(sessionId);
  await assert.rejects(host.open('00000000-0000-4000-8000-000000000002'), { code: 'capacity' });
});
