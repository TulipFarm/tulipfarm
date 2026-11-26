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
  // Adds and removes many iframes, and starts a slow download in one that is removed once the file starts.
  '/churn': `<!doctype html><title>Churn</title>
    <button onclick="churn()">Churn frames</button>
    <button onclick="framedPopup()">Open framed popup</button>
    <script>
      function framedPopup() {
        const popup = window.open('/framed-popup');
        popup.addEventListener('load', () => setTimeout(() => popup.close(), 200));
      }
      function churn() {
        for (let i = 0; i < 30; i += 1) {
          const frame = document.createElement('iframe');
          frame.srcdoc = 'frame ' + i;
          document.body.append(frame);
          frame.remove();
        }
        const frame = document.createElement('iframe');
        frame.src = '/trickle.bin';
        document.body.append(frame);
        fetch('/download-started').then(() => frame.remove());
      }
    </script>`,
  '/framed-popup': `<!doctype html><title>Framed popup</title>
    ${Array.from({ length: 10 }, (_, i) => `<iframe srcdoc="frame ${i}"></iframe>`).join('')}`,
  // Starts a download in an iframe and removes the iframe as soon as the server starts sending the file.
  '/frame-download': `<!doctype html><title>Frame download</title>
    <button onclick="start()">Download in a frame</button>
    <script>
      function start() {
        const frame = document.createElement('iframe');
        frame.src = '/stream.bin?frame';
        document.body.append(frame);
        fetch('/download-started').then(() => frame.remove());
      }
    </script>`,
  '/files': `<!doctype html><title>Files</title>
    <a href="/report.csv">Download report</a>
    <a href="/big.bin">Download archive</a>
    <a href="/stream.bin">Download stream</a>
    <a href="/slow.bin">Download slowly</a>
    <a href="/stream.bin?tab" target="_blank">Download in a new tab</a>
    <a href="/shared.bin">Download shared</a>
    <label>Invoice <input id="invoice" type="file"></label>
    <div role="button" aria-label="Upload photo" style="display:inline-block;padding:8px">Upload photo
      <input type="file" style="display:none" id="photo"></div>
    <label>Name <input name="name"></label>
    <p id="chosen">No file chosen</p>
    <script>
      for (const input of document.querySelectorAll('input[type=file]'))
        input.addEventListener('change', async () => {
          const file = input.files[0];
          document.getElementById('chosen').textContent = input.id + ': ' + file.name + ' ' + file.type + ' ' + (await file.text());
        });
    </script>`,
  '/slow': `<!doctype html><title>Slow</title>
    <button disabled onclick="document.title = 'Clicked'">Continue</button>
    <script>setTimeout(() => (document.querySelector('button').disabled = false), 1200)</script>`,
};

let site;
let origin;
/** Responses held until a framed download starts. */
const downloadStarted = [];
/** Endless downloads the browser stopped, by path. */
const stopped = [];
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
    // An allowed site that sends the page, or one of its images, on to another site.
    if (url.pathname === '/to-other' || url.pathname === '/to-other-image') {
      response.writeHead(302, { location: `http://localhost:${site.address().port}${url.pathname}-landing` });
      return response.end();
    }
    if (url.pathname === '/redirecting') {
      response.writeHead(200, { 'content-type': 'text/html' });
      return response.end('<!doctype html><title>Redirecting</title><img alt="Moved image" src="/to-other-image">');
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
    if (url.pathname === '/report.csv') {
      response.writeHead(200, {
        'content-type': 'text/csv',
        'content-disposition': 'attachment; filename="report.csv"',
      });
      return response.end('month,total\nMay,42\n');
    }
    if (url.pathname === '/big.bin') {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="big.bin"',
      });
      return response.end(Buffer.alloc(4096, 1));
    }
    // Endless downloads with no length, one fast and one slow, that stop only when the browser does.
    if (url.pathname === '/stream.bin' || url.pathname === '/slow.bin') {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${url.pathname.slice(1)}"`,
      });
      const fast = url.pathname === '/stream.bin';
      const stream = () => setInterval(() => response.write(Buffer.alloc(fast ? 64 * 1024 : 1, 1)), fast ? 5 : 200);
      let timer;
      if (url.search === '?frame') {
        // Removing the iframe before the browser turns the response into a download cancels the load instead,
        // so the page waits, as with /trickle.bin, and the stream stays small until then.
        response.write(Buffer.alloc(1024, 1));
        timer = setTimeout(() => {
          for (const waiting of downloadStarted.splice(0)) waiting.end();
          timer = stream();
        }, 200);
      } else {
        response.flushHeaders();
        timer = stream();
      }
      response.on('close', () => {
        clearInterval(timer);
        stopped.push(url.pathname + url.search);
      });
      return;
    }
    // A download that sends a kilobyte at once and then one every 200 ms, so it passes 8 KiB after about 1.5 s.
    if (url.pathname === '/trickle.bin') {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="trickle.bin"',
      });
      response.write(Buffer.alloc(1024, 1));
      let sent = 1;
      const timer = setInterval(() => {
        response.write(Buffer.alloc(1024, 1));
        // The page removes the iframe once the browser has had time to turn the response into a download.
        if (++sent === 2) for (const waiting of downloadStarted.splice(0)) waiting.end();
      }, 200);
      response.on('close', () => {
        clearInterval(timer);
        stopped.push(url.pathname);
      });
      return;
    }
    // One address that streams endlessly to a browser with the "big" cookie and sends a small file to any other.
    if (url.pathname === '/shared.bin') {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="shared.bin"',
      });
      const big = /\bbig=1\b/.test(request.headers.cookie ?? '');
      let sent = 0;
      const timer = setInterval(
        () => {
          if (!big && sent >= 20) return void (clearInterval(timer), response.end());
          sent += 1;
          response.write(Buffer.alloc(big ? 64 * 1024 : 4096, 1));
        },
        big ? 5 : 50,
      );
      response.on('close', () => clearInterval(timer));
      return;
    }
    if (url.pathname === '/files' && url.searchParams.has('big')) {
      response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'big=1; Path=/' });
      return response.end(pages['/files']);
    }
    if (url.pathname === '/download-started') return void downloadStarted.push(response);
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
  site.closeAllConnections();
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

  const events = [];
  const unsubscribe = await host.subscribe(sessionId, event => events.push(event.type));
  // The person clicks the terms label through the live view, in viewport pixels.
  const [x, y] = [300, 440];
  // Inputs sent together run in order: the press, then the release.
  await host.input(
    sessionId,
    ['mousePressed', 'mouseReleased'].map(event => ({
      type: 'mouse',
      event,
      x,
      y,
      button: 'left',
      clickCount: 1,
      modifiers: 0,
    })),
  );
  await new Promise(resolve => setTimeout(resolve, 300));
  unsubscribe();
  assert.ok(events.includes('state'));
  assert.ok(events.includes('frame'));

  // The agent's next step ends the wait and learns a person used the page.
  result = await host.act(sessionId, { action: 'snapshot' });
  assert.equal(result.state.needsPerson, null);
  assert.match(result.notice, /A person clicked or typed in this browser/);
  assert.match(result.snapshot, /checkbox "I agree to the terms" \[checked\]/);
  result = await host.act(sessionId, { action: 'snapshot' });
  assert.doesNotMatch(result.notice ?? '', /A person clicked/, 'the notice is given once');
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

test('a limited session follows no redirect to another site, and that site never hears of it', async t => {
  const host = await createBrowserHost({ ...options, allowPrivateNetworks: true });
  t.after(() => host.shutdown());
  otherSiteHits.length = 0;
  await host.open(sessionId, ['127.0.0.1']);
  const moved = await host.act(sessionId, { action: 'navigate', url: `${origin}/to-other` });
  assert.match(moved.snapshot, /This agent isn’t allowed to open this site\./);
  assert.equal(moved.notice, `Blocked http://localhost:${site.address().port}: this browser can only open 127.0.0.1.`);
  const page = await host.act(sessionId, { action: 'navigate', url: `${origin}/redirecting` });
  assert.equal(page.state.title, 'Redirecting');
  await new Promise(resolve => setTimeout(resolve, 300));
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

test('a person’s input waits for the agent action already running', async t => {
  const host = await createBrowserHost({ ...options, allowPrivateNetworks: true });
  t.after(() => host.shutdown());
  await host.open(sessionId);
  const page = await host.act(sessionId, { action: 'navigate', url: `${origin}/slow` });
  const clicking = host.act(sessionId, { action: 'click', ref: ref(page.snapshot, /button "Continue"/) });
  await new Promise(resolve => setTimeout(resolve, 100));
  await host.input(sessionId, {
    type: 'mouse',
    event: 'mouseMoved',
    x: 10,
    y: 10,
    button: 'none',
    clickCount: 0,
    modifiers: 0,
  });
  assert.equal((await host.state(sessionId)).title, 'Clicked');
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

const workspace = '00000000-0000-4000-8000-0000000000aa';
const other = '00000000-0000-4000-8000-0000000000bb';
const session = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('a workspace’s extra sessions wait in line, first come first served, while open ones resume at once', async t => {
  const host = await createBrowserHost({ ...options, maxSessions: 6, maxSessionsPerWorkspace: 2 });
  t.after(() => host.shutdown());
  await host.open(session(1), undefined, workspace);
  await host.open(session(2), undefined, workspace);
  const order = [];
  const third = host.open(session(3), undefined, workspace).then(state => order.push(state.sessionId));
  const fourth = host.open(session(4), undefined, workspace).then(state => order.push(state.sessionId));
  // Another workspace and an open session never wait.
  await host.open(session(5), undefined, other);
  assert.equal((await host.open(session(1), undefined, workspace)).sessionId, session(1));
  assert.deepEqual(order, []);
  await host.close(session(1));
  await third;
  assert.deepEqual(order, [session(3)]);
  await host.close(session(2));
  await fourth;
  assert.deepEqual(order, [session(3), session(4)]);
});

test('a session that waits too long is told its place in line, and leaving the line frees it', async t => {
  const host = await createBrowserHost({ ...options, maxSessions: 6, maxSessionsPerWorkspace: 2, queueWaitMs: 300 });
  t.after(() => host.shutdown());
  await host.open(session(1), undefined, workspace);
  await host.open(session(2), undefined, workspace);
  const ended = new AbortController();
  const gaveUp = host.open(session(3), undefined, workspace, ended.signal);
  const waiting = host.open(session(4), undefined, workspace);
  ended.abort();
  await assert.rejects(gaveUp, { code: 'invalid-request' });
  await assert.rejects(waiting, error => {
    assert.equal(error.code, 'browser-busy');
    assert.equal(error.position, 1);
    assert.equal(error.message, 'All 2 browsers for this workspace are in use. This step is number 1 in line.');
    return true;
  });
  // Nobody is left in line, so the next session opens as soon as a browser closes.
  await host.close(session(1));
  assert.equal((await host.open(session(5), undefined, workspace)).sessionId, session(5));
  assert.equal(host.size(), 2);
});

test('a session’s state says when it opened, was last used and closes unless used', async t => {
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const host = await createBrowserHost({ ...options, idleMs: 60_000, holdMs: 600_000, now: () => clock });
  t.after(() => host.shutdown());
  const opened = await host.open(sessionId, undefined, workspace);
  assert.equal(opened.openedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(opened.closesAt, '2026-01-01T00:01:00.000Z');
  clock += 5000;
  await host.needsPerson(sessionId, { reason: 'Solve the captcha' });
  const waiting = await host.state(sessionId);
  assert.equal(waiting.openedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(waiting.activeAt, '2026-01-01T00:00:05.000Z');
  assert.equal(waiting.closesAt, '2026-01-01T00:10:05.000Z');
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

  // Asked to sign in again, the loaded login has signed out until a person uses the browser.
  let state = await host.needsPerson(next, { reason: 'Sign in again to continue.', signIn: site });
  assert.equal(state.signIn, site);
  assert.deepEqual(state.logins, [{ id: login, site, signedOut: true }]);
  // An agent step with no one using the browser ends the wait, but the login stays signed out.
  result = await host.act(next, { action: 'snapshot' });
  assert.equal(result.state.signIn, null);
  assert.deepEqual(result.state.logins, [{ id: login, site, signedOut: true }]);
  await host.needsPerson(next, { reason: 'Sign in again to continue.', signIn: site });
  await host.input(next, { type: 'text', text: 'x' });
  result = await host.act(next, { action: 'snapshot' });
  assert.equal(result.state.signIn, null);
  assert.deepEqual(result.state.logins, [{ id: login, site, signedOut: false }]);
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

test('a download is held for the agent once, and one over the size limit is refused', async t => {
  const host = await createBrowserHost({ ...options, allowPrivateNetworks: true, maxDownloadBytes: 1024 });
  t.after(() => host.shutdown());
  await host.open(sessionId);
  let result = await host.act(sessionId, { action: 'navigate', url: `${origin}/files` });
  assert.equal(result.downloads, undefined);
  result = await host.act(sessionId, { action: 'click', ref: ref(result.snapshot, /link "Download report"/) });
  assert.equal(result.downloads?.length, 1, JSON.stringify(result));
  const [download] = result.downloads;
  assert.equal(download.name, 'report.csv');
  assert.equal(download.size, 19);
  assert.equal(result.state.title, 'Files');

  const held = host.takeDownload(sessionId, download.id);
  const chunks = [];
  for await (const chunk of await held.read()) chunks.push(chunk);
  await held.done();
  assert.equal(Buffer.concat(chunks).toString(), 'month,total\nMay,42\n');
  assert.throws(() => host.takeDownload(sessionId, download.id), { code: 'download-not-found' });
  result = await host.act(sessionId, { action: 'snapshot' });
  assert.equal(result.downloads, undefined);

  result = await host.act(sessionId, { action: 'click', ref: ref(result.snapshot, /link "Download archive"/) });
  assert.equal(result.downloads, undefined);
  assert.match(result.notice ?? '', /"big.bin" was not saved: files are limited to 0 MiB/);
  // Opening a file's address directly downloads it instead of failing the step.
  result = await host.act(sessionId, { action: 'navigate', url: `${origin}/report.csv` });
  assert.equal(result.downloads?.[0]?.name, 'report.csv');
});

test('a session limited to listed sites downloads through its proxy, held to the same limits', async t => {
  const host = await createBrowserHost({
    ...options,
    allowPrivateNetworks: true,
    maxDownloadBytes: 256 * 1024,
    downloadWaitMs: 3000,
  });
  t.after(() => host.shutdown());
  await host.open(sessionId, ['127.0.0.1']);
  let result = await host.act(sessionId, { action: 'navigate', url: `${origin}/files` });
  result = await host.act(sessionId, { action: 'click', ref: ref(result.snapshot, /link "Download report"/) });
  assert.equal(result.downloads?.[0]?.name, 'report.csv', JSON.stringify(result));
  const held = host.takeDownload(sessionId, result.downloads[0].id);
  const chunks = [];
  for await (const chunk of await held.read()) chunks.push(chunk);
  await held.done();
  assert.equal(Buffer.concat(chunks).toString(), 'month,total\nMay,42\n');

  stopped.length = 0;
  result = await host.act(sessionId, { action: 'snapshot' });
  result = await host.act(sessionId, { action: 'click', ref: ref(result.snapshot, /link "Download in a new tab"/) });
  assert.equal(result.downloads, undefined);
  assert.match(result.notice ?? '', /"stream.bin" was not saved: files are limited to 0 MiB/);
  assert.ok(stopped.includes('/stream.bin?tab'), 'the browser stopped receiving it');
});

test('the agent uploads a file only into a file input', async t => {
  const host = await createBrowserHost({ ...options, allowPrivateNetworks: true });
  t.after(() => host.shutdown());
  await host.open(sessionId);
  let result = await host.act(sessionId, { action: 'navigate', url: `${origin}/files` });
  const file = { name: 'invoice.txt', mediaType: 'text/plain' };
  await assert.rejects(
    host.upload(sessionId, { ...file, ref: ref(result.snapshot, /textbox "Name"/) }, Buffer.from('x')),
    { code: 'field-refused' },
  );
  await assert.rejects(host.upload(sessionId, { ...file, ref: 'e999' }, Buffer.from('x')), { code: 'ref-not-found' });
  result = await host.upload(
    sessionId,
    { ...file, ref: ref(result.snapshot, /button "Invoice"/) },
    Buffer.from('Total: 42'),
  );
  assert.match(result.snapshot, /invoice: invoice.txt text\/plain Total: 42/);
  // A styled upload button with its input hidden inside it.
  result = await host.upload(
    sessionId,
    { name: 'photo.txt', mediaType: 'text/plain', ref: ref(result.snapshot, /button "Upload photo"/) },
    Buffer.from('smile'),
  );
  assert.match(result.snapshot, /photo: photo.txt text\/plain smile/);
});

test('a download is stopped while it transfers once it passes the size limit', async t => {
  const host = await createBrowserHost({
    ...options,
    allowPrivateNetworks: true,
    maxDownloadBytes: 256 * 1024,
    downloadWaitMs: 3000,
  });
  t.after(() => host.shutdown());
  await host.open(sessionId);
  let result = await host.act(sessionId, { action: 'navigate', url: `${origin}/files` });
  const started = Date.now();
  result = await host.act(sessionId, { action: 'click', ref: ref(result.snapshot, /link "Download stream"/) });
  assert.equal(result.downloads, undefined);
  assert.match(result.notice ?? '', /"stream.bin" was not saved: files are limited to 0 MiB/);
  assert.ok(stopped.includes('/stream.bin'), 'the browser stopped receiving it');
  assert.ok(Date.now() - started < 3000, 'without waiting for it to finish');
});

test('a download a new tab starts is also stopped while it transfers', async t => {
  const host = await createBrowserHost({
    ...options,
    allowPrivateNetworks: true,
    maxDownloadBytes: 256 * 1024,
    downloadWaitMs: 3000,
  });
  t.after(() => host.shutdown());
  await host.open(sessionId);
  let result = await host.act(sessionId, { action: 'navigate', url: `${origin}/files` });
  const started = Date.now();
  result = await host.act(sessionId, { action: 'click', ref: ref(result.snapshot, /link "Download in a new tab"/) });
  assert.equal(result.downloads, undefined);
  assert.match(result.notice ?? '', /"stream.bin" was not saved: files are limited to 0 MiB/);
  assert.ok(stopped.includes('/stream.bin?tab'), 'the browser stopped receiving it');
  assert.ok(Date.now() - started < 3000, 'without waiting for it to finish');
});

test('a download is held to its limits after the iframe that started it is removed', async t => {
  const host = await createBrowserHost({
    ...options,
    allowPrivateNetworks: true,
    maxDownloadBytes: 256 * 1024,
    downloadWaitMs: 3000,
  });
  t.after(() => host.shutdown());
  await host.open(sessionId);
  let result = await host.act(sessionId, { action: 'navigate', url: `${origin}/frame-download` });
  const started = Date.now();
  result = await host.act(sessionId, { action: 'click', ref: ref(result.snapshot, /button "Download in a frame"/) });
  assert.equal(result.downloads, undefined);
  assert.match(result.notice ?? '', /"stream.bin" was not saved: files are limited to 0 MiB/);
  assert.ok(stopped.includes('/stream.bin?frame'), 'the browser stopped receiving it');
  assert.ok(Date.now() - started < 3000, 'without waiting for it to finish');
});

test('removed frames are forgotten after a minute while a download one started is still held to its limits', async t => {
  let clock = 1_000_000;
  const host = await createBrowserHost({
    ...options,
    allowPrivateNetworks: true,
    idleMs: 60 * 60_000,
    maxDownloadBytes: 8 * 1024,
    downloadWaitMs: 5000,
    now: () => clock,
  });
  t.after(() => host.shutdown());
  await host.open(sessionId);
  const result = await host.act(sessionId, { action: 'navigate', url: `${origin}/churn` });
  const before = host.trackedFrames();
  const clicked = host.act(sessionId, { action: 'click', ref: ref(result.snapshot, /button "Churn frames"/) });
  while (host.trackedFrames() < before + 31) await new Promise(resolve => setTimeout(resolve, 10));
  while (!stopped.includes('/trickle.bin') && host.trackedFrames() > before) {
    clock += 61_000;
    await host.sweep();
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(host.trackedFrames(), before, 'removed frames are forgotten');
  assert.ok(!stopped.includes('/trickle.bin'), 'while the download is still in progress');
  const done = await clicked;
  assert.match(done.notice ?? '', /"trickle.bin" was not saved: files are limited to 0 MiB/);
  assert.ok(stopped.includes('/trickle.bin'), 'the browser stopped receiving it');

  // A closed tab's own iframes get no removal events of their own, and are forgotten with it.
  const opened = await host.act(sessionId, { action: 'navigate', url: `${origin}/churn` });
  await host.act(sessionId, { action: 'click', ref: ref(opened.snapshot, /button "Open framed popup"/) });
  while (host.trackedFrames() < before + 11) await new Promise(resolve => setTimeout(resolve, 10));
  for (const deadline = Date.now() + 3000; host.trackedFrames() > before && Date.now() < deadline;) {
    clock += 61_000;
    await host.sweep();
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(host.trackedFrames(), before, 'a closed tab and its iframes are forgotten');
});

test('two sessions downloading the same file are each held to their own limits', async t => {
  const host = await createBrowserHost({
    ...options,
    allowPrivateNetworks: true,
    maxDownloadBytes: 256 * 1024,
    downloadWaitMs: 3000,
  });
  t.after(() => host.shutdown());
  const other = '00000000-0000-4000-8000-000000000002';
  for (let round = 0; round < 3; round += 1) {
    await host.open(sessionId);
    await host.open(other);
    const big = await host.act(sessionId, { action: 'navigate', url: `${origin}/files?big` });
    const small = await host.act(other, { action: 'navigate', url: `${origin}/files` });
    const click = (id, result) =>
      host.act(id, { action: 'click', ref: ref(result.snapshot, /link "Download shared"/) });
    const [stoppedResult, savedResult] = await Promise.all([click(sessionId, big), click(other, small)]);
    assert.match(stoppedResult.notice ?? '', /"shared.bin" was not saved: files are limited to 0 MiB/);
    assert.deepEqual(
      savedResult.downloads?.map(({ name, size }) => ({ name, size })),
      [{ name: 'shared.bin', size: 20 * 4096 }],
      savedResult.notice,
    );
    await host.close(sessionId);
    await host.close(other);
  }
});

test('downloads in progress count toward the held limit, and held bytes are capped', async t => {
  const host = await createBrowserHost({
    ...options,
    allowPrivateNetworks: true,
    maxHeldDownloads: 1,
    downloadWaitMs: 300,
  });
  t.after(() => host.shutdown());
  await host.open(sessionId);
  let result = await host.act(sessionId, { action: 'navigate', url: `${origin}/files` });
  result = await host.act(sessionId, { action: 'click', ref: ref(result.snapshot, /link "Download slowly"/) });
  assert.match(result.notice ?? '', /A download is still in progress/);
  result = await host.act(sessionId, { action: 'click', ref: ref(result.snapshot, /link "Download report"/) });
  assert.equal(result.downloads, undefined);
  assert.match(result.notice ?? '', /"report.csv" was not saved: too many downloads are waiting to be saved/);

  const capped = await createBrowserHost({ ...options, allowPrivateNetworks: true, maxHeldDownloadBytes: 30 });
  t.after(() => capped.shutdown());
  await capped.open(sessionId);
  result = await capped.act(sessionId, { action: 'navigate', url: `${origin}/files` });
  result = await capped.act(sessionId, { action: 'click', ref: ref(result.snapshot, /link "Download report"/) });
  assert.equal(result.downloads?.length, 1);
  result = await capped.act(sessionId, { action: 'click', ref: ref(result.snapshot, /link "Download report"/) });
  assert.equal(result.downloads?.length, 1, 'the second would pass the bytes held');
  assert.match(result.notice ?? '', /"report.csv" was not saved: too many downloads are waiting to be saved/);
});

test('a download waiting to be saved expires five minutes after it finished', async t => {
  let clock = 1_000_000;
  const host = await createBrowserHost({
    ...options,
    allowPrivateNetworks: true,
    idleMs: 60 * 60_000,
    now: () => clock,
  });
  t.after(() => host.shutdown());
  await host.open(sessionId);
  let result = await host.act(sessionId, { action: 'navigate', url: `${origin}/files` });
  result = await host.act(sessionId, { action: 'click', ref: ref(result.snapshot, /link "Download report"/) });
  const [download] = result.downloads;
  clock += 4 * 60_000;
  await host.sweep();
  result = await host.act(sessionId, { action: 'snapshot' });
  assert.equal(result.downloads?.[0]?.id, download.id, 'still held while the session is used');
  clock += 60_000;
  await host.sweep();
  assert.throws(() => host.takeDownload(sessionId, download.id), { code: 'download-not-found' });
  result = await host.act(sessionId, { action: 'snapshot' });
  assert.equal(result.downloads, undefined);
  assert.match(result.notice ?? '', /"report.csv" was not saved: it waited too long/);
});

test('downloads are not saved once a secret is typed in the session', async t => {
  const host = await createBrowserHost({ ...options, allowPrivateNetworks: true, downloadWaitMs: 1000 });
  t.after(() => host.shutdown());
  await host.open(sessionId);
  let result = await host.act(sessionId, { action: 'navigate', url: `${origin}/files` });
  result = await host.act(sessionId, { action: 'click', ref: ref(result.snapshot, /link "Download report"/) });
  const [held] = result.downloads;
  result = await host.act(sessionId, { action: 'click', ref: ref(result.snapshot, /link "Download slowly"/) });
  assert.match(result.notice ?? '', /A download is still in progress/);
  const page = await host.act(sessionId, { action: 'navigate', url: `${origin}/login` });
  result = await host.typeSecret(sessionId, {
    hosts: ['127.0.0.1'],
    fields: [
      { ref: ref(page.snapshot, /textbox "Email"/), kind: 'username', value: 'ada@example.com' },
      { ref: ref(page.snapshot, /textbox "Password"/), kind: 'password', value: 'DUMMY-pass-123' },
    ],
  });
  assert.equal(result.downloads, undefined);
  assert.match(result.notice ?? '', /"report.csv" was not saved: downloads aren’t saved after a password is typed/);
  assert.match(result.notice ?? '', /"slow.bin" was not saved: downloads aren’t saved after a password is typed/);
  assert.throws(() => host.takeDownload(sessionId, held.id), { code: 'download-not-found' });
  result = await host.act(sessionId, { action: 'navigate', url: `${origin}/report.csv` });
  assert.equal(result.downloads, undefined);
  assert.match(result.notice ?? '', /downloads aren’t saved after a password is typed in this browser/);
  result = await host.act(sessionId, { action: 'navigate', url: `${origin}/files` });
  result = await host.upload(
    sessionId,
    { name: 'invoice.txt', mediaType: 'text/plain', ref: ref(result.snapshot, /button "Invoice"/) },
    Buffer.from('Total: 42'),
  );
  assert.match(result.snapshot, /invoice: invoice.txt/, 'uploads still work');
});
