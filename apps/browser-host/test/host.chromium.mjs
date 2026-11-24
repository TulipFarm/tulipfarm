// Drives a real Chromium against a local site. Needs Playwright's Chromium, or CHROMIUM_EXECUTABLE_PATH.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { blockedNotice, createBrowserHost } from '../src/host.ts';

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
// Requests that reached the site under its other name, localhost, which limited sessions must never reach.
const otherSiteHits = [];
before(async () => {
  internal = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>Internal</title><p>internal secret</p>');
  });
  internal.listen(0, '::1');
  await once(internal, 'listening');
  site = createServer((request, response) => {
    const url = new URL(request.url, 'http://x');
    if (request.headers.host?.startsWith('localhost')) otherSiteHits.push(url.pathname);
    if (url.pathname === '/mixed') {
      const other = `http://localhost:${site.address().port}`;
      response.writeHead(200, { 'content-type': 'text/html' });
      return response.end(
        `<!doctype html><title>Mixed</title>
        <iframe title="Other frame" src="${other}/frame"></iframe>
        <img alt="Other image" src="${other}/image">
        <img alt="Own image" src="/own-image">
        <a href="${other}/popup" target="_blank">Other help</a>
        <script>
          fetch('${other}/data').catch(() => undefined);
          const socket = new WebSocket('ws://localhost:${site.address().port}/socket');
          socket.onerror = () => undefined;
        </script>`,
      );
    }
    if (url.pathname === '/redirect') {
      response.writeHead(302, { location: `http://[::1]:${internal.address().port}/` });
      return response.end();
    }
    if (url.pathname === '/sign-in') {
      response.writeHead(200, {
        'content-type': 'text/html',
        'set-cookie': 'member=ada; Path=/; HttpOnly; Max-Age=3600',
      });
      return response.end(
        `<!doctype html><title>Signed in</title><script>localStorage.setItem('cart', '3 items')</script>`,
      );
    }
    if (url.pathname === '/account') {
      response.writeHead(200, { 'content-type': 'text/html' });
      const member = /member=(\w+)/.exec(request.headers.cookie ?? '')?.[1] ?? 'nobody';
      return response.end(
        `<!doctype html><title>Account of ${member}</title><p id="cart"></p><script>document.getElementById('cart').textContent = 'Cart: ' + localStorage.getItem('cart')</script>`,
      );
    }
    if (url.pathname === '/login') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      const other = `http://localhost:${site.address().port}/frame`;
      return response.end(
        `<!doctype html><title>Sign in</title>
        <form action="/done">
          <label>Email <input name="user" type="email"></label>
          <label>Password <input name="pass" type="password"></label>
          <label>Notes <input name="notes"></label>
          <button type="submit">Sign in</button>
        </form>
        <p id="inputs">No input yet</p>
        <iframe title="Other site" src="${other}"></iframe>
        <script>
          let inputs = 0;
          document.querySelector('form').addEventListener('input', () => {
            document.getElementById('inputs').textContent = 'Inputs seen: ' + ++inputs;
          });
          // A page that hands focus to another site's frame must not hand it the secret.
          for (const input of document.querySelectorAll('form input'))
            input.addEventListener('focus', () => setInterval(() => document.querySelector('iframe').focus(), 1));
        </script>`,
      );
    }
    if (url.pathname === '/frame') {
      response.writeHead(200, { 'content-type': 'text/html' });
      return response.end(
        `<!doctype html><label>Frame password <input type="password"></label><p id="leak">Nothing typed here</p>
        <script>
          document.querySelector('input').focus();
          document.addEventListener('keydown', () => (document.getElementById('leak').textContent = 'Frame got keys'));
          document.querySelector('input').addEventListener('input', () => (document.getElementById('leak').textContent = 'Frame got input'));
        </script>`,
      );
    }
    if (url.pathname === '/done') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return response.end(
        `<!doctype html><title>Welcome</title><h1>Hi ${url.searchParams.get('pass')}</h1>
        <p>${[...url.searchParams].map(([k, v]) => `${k}=${v}`).join(' ')}</p>`,
      );
    }
    response.writeHead(pages[url.pathname] ? 200 : 404, { 'content-type': 'text/html' });
    response.end(pages[url.pathname] ?? 'missing');
  });
  site.on('upgrade', (request, socket) => {
    if (request.headers.host?.startsWith('localhost')) otherSiteHits.push('websocket');
    socket.destroy();
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

  const waiting = await host.needsPerson(sessionId, { reason: 'Tick the terms box' });
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

test('a session limited to listed sites opens only their pages, while their pages load what they need', async t => {
  const host = await createBrowserHost({ ...options, allowPrivateNetworks: true });
  t.after(() => host.shutdown());
  await host.open(sessionId, ['127.0.0.1']);
  const allowed = await host.act(sessionId, { action: 'navigate', url: `${origin}/login` });
  assert.equal(allowed.state.title, 'Sign in');
  assert.equal(allowed.notice, undefined);
  const blocked = await host.act(sessionId, { action: 'navigate', url: `http://localhost:${site.address().port}/` });
  assert.equal(
    blocked.notice,
    `Blocked http://localhost:${site.address().port}: this browser can only open 127.0.0.1.`,
  );
  assert.notEqual(blocked.state.title, 'Sign up');
  // Opening the session again does not lift the limit.
  await host.open(sessionId);
  const again = await host.act(sessionId, { action: 'navigate', url: `http://localhost:${site.address().port}/` });
  assert.match(again.notice ?? '', /can only open/);
});

test('a limited session’s pages reach no other site: no frame, resource, fetch, WebSocket or popup', async t => {
  const host = await createBrowserHost({ ...options, allowPrivateNetworks: true });
  t.after(() => host.shutdown());
  otherSiteHits.length = 0;
  await host.open(sessionId, ['127.0.0.1']);
  const page = await host.act(sessionId, { action: 'navigate', url: `${origin}/mixed` });
  assert.equal(page.state.title, 'Mixed');
  await host.act(sessionId, { action: 'click', ref: ref(page.snapshot, /link "Other help"/) });
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.deepEqual(otherSiteHits, []);
});

test('the blocked notice names five sites, then how many more', () => {
  assert.equal(
    blockedNotice('https://x.example', [
      'a.example',
      'b.example',
      'c.example',
      'd.example',
      'e.example',
      'f.example',
      'g.example',
    ]),
    'Blocked https://x.example: this browser can only open a.example, b.example, c.example, d.example, e.example and 2 more.',
  );
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
  await host.needsPerson(waiting, { reason: 'Solve the captcha' });
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

test('a saved login carries a site’s cookies and storage into a new session', async t => {
  const host = await createBrowserHost({ ...options, allowPrivateNetworks: true });
  t.after(() => host.shutdown());
  const site = '127.0.0.1';
  await host.open(sessionId);
  await host.act(sessionId, { action: 'navigate', url: `${origin}/sign-in` });
  const saved = await host.siteState(sessionId, site);
  assert.deepEqual(
    saved.cookies.map(cookie => [cookie.name, cookie.value, cookie.httpOnly]),
    [['member', 'ada', true]],
  );
  assert.deepEqual(saved.origins, [{ origin, localStorage: [{ name: 'cart', value: '3 items' }] }]);
  assert.deepEqual((await host.siteState(sessionId, 'example.com')).cookies, [], 'other sites are left out');
  await host.close(sessionId);

  const next = '00000000-0000-4000-8000-000000000002';
  await host.open(next);
  let result = await host.act(next, { action: 'navigate', url: `${origin}/account` });
  assert.equal(result.state.title, 'Account of nobody', 'a new session starts signed out');
  const login = '7d3f1e2a-4b5c-4d6e-8f70-1a2b3c4d5e6f';
  const loaded = await host.loadLogin(next, { id: login, site, state: saved });
  assert.deepEqual(loaded.logins, [{ id: login, site, signedOut: false }]);
  result = await host.act(next, { action: 'navigate', url: `${origin}/account` });
  assert.equal(result.state.title, 'Account of ada');
  assert.match(result.snapshot, /Cart: 3 items/);
  const exported = await host.siteState(next, site);
  assert.deepEqual(exported.origins[0].localStorage, [{ name: 'cart', value: '3 items' }], 'the load marker stays out');

  // Asked to sign in again, the loaded login has signed out until a person hands back.
  let state = await host.needsPerson(next, { reason: 'Sign in again to continue.', signIn: site });
  assert.equal(state.signIn, site);
  assert.deepEqual(state.logins, [{ id: login, site, signedOut: true }]);
  await host.control(next, { controller: 'person', memberId: 'member-1' });
  state = await host.control(next, { controller: 'agent' });
  assert.equal(state.signIn, null);
  assert.deepEqual(state.logins, [{ id: login, site, signedOut: false }]);
});

test('loading another login for a site replaces the sign-in, and reloading one applies its newer storage', async t => {
  const host = await createBrowserHost({ ...options, allowPrivateNetworks: true });
  t.after(() => host.shutdown());
  const site = '127.0.0.1';
  await host.open(sessionId);
  await host.act(sessionId, { action: 'navigate', url: `${origin}/sign-in` });
  const ada = await host.siteState(sessionId, site);
  const account = (member, cart) => ({
    cookies: ada.cookies.map(cookie => ({ ...cookie, value: member })),
    origins: [{ origin, localStorage: [{ name: 'cart', value: cart }] }],
  });
  await host.close(sessionId);

  const next = '00000000-0000-4000-8000-000000000002';
  await host.open(next);
  const first = '7d3f1e2a-4b5c-4d6e-8f70-1a2b3c4d5e6f';
  const second = '8e4f2f3b-5c6d-4e7f-9081-2b3c4d5e6f70';
  await host.loadLogin(next, { id: first, site, state: account('ada', '3 items') });
  const switched = await host.loadLogin(next, { id: second, site, state: account('bob', '1 item') });
  assert.deepEqual(
    switched.logins,
    [{ id: second, site, signedOut: false }],
    'only the latest login describes the site',
  );
  let result = await host.act(next, { action: 'navigate', url: `${origin}/account` });
  assert.equal(result.state.title, 'Account of bob');
  assert.match(result.snapshot, /Cart: 1 item/);
  assert.deepEqual(
    (await host.siteState(next, site)).cookies.map(cookie => cookie.value),
    ['bob'],
    'the first account’s cookies are gone',
  );

  await host.loadLogin(next, { id: first, site, state: account('ada', '5 items') });
  result = await host.act(next, { action: 'navigate', url: `${origin}/account` });
  assert.equal(result.state.title, 'Account of ada');
  assert.match(result.snapshot, /Cart: 5 items/, 'a login loaded again replaces the storage it set before');
  result = await host.act(next, { action: 'navigate', url: `${origin}/account` });
  assert.match(result.snapshot, /Cart: 5 items/, 'an earlier load’s storage never comes back');
});

test('a secret is typed only into sign-in fields on its own site and never shown back', async t => {
  const host = await createBrowserHost({ ...options, allowPrivateNetworks: true });
  t.after(() => host.shutdown());
  await host.open(sessionId);
  const page = await host.act(sessionId, { action: 'navigate', url: `${origin}/login` });
  const user = ref(page.snapshot, /textbox "Email"/);
  const pass = ref(page.snapshot, /textbox "Password"/);
  const notes = ref(page.snapshot, /textbox "Notes"/);
  const framed = ref(page.snapshot, /textbox "Frame password"/);
  const submit = ref(page.snapshot, /button "Sign in"/);
  // Quotes, a backslash, an apostrophe, non-ASCII letters, a run of spaces and " #" make the snapshot escape it.
  const secret = { username: 'ada@example.com', password: `"DUMMY\\Secret" it's é ü  #x` };
  const fields = (username, password) => [
    { ref: username, kind: 'username', value: secret.username },
    { ref: password, kind: 'password', value: secret.password },
  ];
  const refused = async (input, code) =>
    assert.rejects(host.typeSecret(sessionId, input), error => error.code === code, code);
  await refused({ hosts: ['example.com'], fields: fields(user, pass) }, 'destination-denied');
  await refused({ hosts: ['127.0.0.1'], fields: fields(user, notes) }, 'field-refused');
  await refused({ hosts: ['127.0.0.1'], fields: fields(pass, pass) }, 'field-refused');
  await refused({ hosts: ['127.0.0.1'], fields: fields(user, framed) }, 'destination-denied');
  const unchanged = await host.act(sessionId, { action: 'snapshot' });
  assert.equal(unchanged.snapshot.includes(secret.username), false);
  assert.ok(unchanged.screenshot, 'nothing typed yet, so the agent still sees the page');

  const filled = await host.typeSecret(sessionId, { hosts: ['127.0.0.1'], fields: fields(user, pass) });
  assert.equal(filled.screenshot, undefined, 'a sign-in result never carries a screenshot');
  assert.match(filled.snapshot, /Inputs seen: 2/, 'the page’s own listeners saw both values');
  assert.match(filled.snapshot, /Nothing typed here/, 'the frame that took focus got nothing');
  const typing = await host.act(sessionId, { action: 'snapshot' });
  assert.equal(typing.screenshot, undefined, 'no screenshots once a secret was typed');
  assert.match(typing.notice, /Screenshots are off in this browser/);

  const done = await host.typeSecret(sessionId, { hosts: ['127.0.0.1'], fields: fields(user, pass), submit });
  assert.equal(done.state.title, 'Welcome');
  const escaped = JSON.stringify(secret.password).slice(1, -1);
  const shown = JSON.stringify(done);
  for (const value of [
    secret.username,
    secret.password,
    secret.password.replace(/\s+/g, ' '),
    escaped,
    escaped.replace(/\s+/g, ' '),
    escaped.replace(/\s+/g, ' ').replace(/'/g, "''"),
    encodeURIComponent(secret.password),
    new URLSearchParams({ v: secret.password }).toString().slice(2),
    'DUMMY',
  ])
    assert.equal(shown.includes(value), false, value);
  assert.match(done.snapshot, /heading .*Hi ••••/);
  assert.match(done.snapshot, /user=•••• pass=••••/);
  assert.match(done.state.url, /user=••••&pass=••••/);
  const later = await host.act(sessionId, { action: 'snapshot' });
  assert.equal(later.snapshot.includes('DUMMY'), false);
  assert.equal(later.screenshot, undefined);
  // A page can draw the secret anywhere, such as in CSS content, so screenshots stay off for the whole session.
  const away = await host.act(sessionId, { action: 'navigate', url: `${origin}/account` });
  assert.equal(away.screenshot, undefined);
  assert.match(away.notice, /accessibility snapshot still works/);
});

test('a secret is redacted in the forms the browser and the snapshot change it to', async t => {
  const host = await createBrowserHost({ ...options, allowPrivateNetworks: true });
  t.after(() => host.shutdown());
  await host.open(sessionId);
  for (const [username, password] of [
    [' ada@example.com ', ' DUMMY-Padded-123 '],
    ['ada@example.com', 'DUMMY-New\nLine-123'],
    ['ada@example.com', 'DUMMY-Zero\u200bWidth-123'],
    ['ada@example.com', 'DUMMY-Soft\u00adHyphen-123'],
    ['ada@example.com', 'DUMMY-Zero\u200bJoin\u200cWidth-123'],
  ]) {
    const page = await host.act(sessionId, { action: 'navigate', url: `${origin}/login` });
    const done = await host.typeSecret(sessionId, {
      hosts: ['127.0.0.1'],
      fields: [
        { ref: ref(page.snapshot, /textbox "Email"/), kind: 'username', value: username },
        { ref: ref(page.snapshot, /textbox "Password"/), kind: 'password', value: password },
      ],
      submit: ref(page.snapshot, /button "Sign in"/),
    });
    assert.equal(done.state.title, 'Welcome', JSON.stringify(password));
    const shown = JSON.stringify(done);
    assert.equal(shown.includes('DUMMY'), false, `${JSON.stringify(password)} in ${shown}`);
    assert.equal(shown.includes('ada@example.com'), false, JSON.stringify(username));
  }
});
