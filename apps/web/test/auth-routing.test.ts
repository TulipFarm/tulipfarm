import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { createServer } from 'vite';
import { createMemoryHistory, createRouter } from '@tanstack/react-router';

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const storage = new Map<string, string>();
const acme = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Acme',
  slug: 'acme',
  createdAt: '2026-09-27T00:00:00.000Z',
  status: 'provisioning',
};
const other = { ...acme, id: '22222222-2222-4222-8222-222222222222', name: 'Other', slug: 'other' };
let session: { session: { id: string }; user: { id: string; name: string } } | null;
let workspaces = [acme];
let workspaceStatus = 200;
let sessionStatus = 200;
const requests: string[] = [];

globalThis.fetch = async input => {
  const url = new URL(String(input));
  requests.push(url.pathname);
  if (url.pathname === '/v1/auth/get-session') return Response.json(session, { status: sessionStatus });
  if (url.pathname.startsWith('/v1/workspaces')) {
    if (workspaceStatus !== 200)
      return Response.json({ error: 'Workspace request failed' }, { status: workspaceStatus });
    if (url.pathname === '/v1/workspaces') return Response.json(workspaces);
    const workspace = workspaces.find(item => url.pathname === `/v1/workspaces/${item.slug}`);
    return workspace ? Response.json(workspace) : Response.json({ error: 'Not found' }, { status: 404 });
  }
  throw new Error(`Unexpected request: ${url.pathname}`);
};

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
});
after(async () => {
  releaseGuardSessionHold();
  await server.close();
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});
const { router: appRouter } = await server.ssrLoadModule('/src/router.tsx');
const { safeAuthRedirect, authCallbackURLs, magicLinkDestination, releaseGuardSessionHold } =
  await server.ssrLoadModule('/src/lib/auth.ts');
const { rememberWorkspace } = await server.ssrLoadModule('/src/lib/last-workspace.ts');
const { saveLastWorkspace, WorkspaceRequestError } = await server.ssrLoadModule('/src/lib/workspaces.ts');
const { redactOnboardingUrls } = await server.ssrLoadModule('/src/lib/analytics.ts');

beforeEach(() => {
  session = { session: { id: 'session' }, user: { id: 'returning-user', name: 'Ada' } };
  workspaces = [acme];
  workspaceStatus = 200;
  sessionStatus = 200;
  requests.length = 0;
  storage.clear();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    },
  });
});

async function load(path: string) {
  const router = createRouter({
    routeTree: appRouter.options.routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    isServer: true,
  });
  await router.load();
  return router;
}

async function destination(path: string) {
  const router = await load(path);
  const result = router._serverResult;
  assert.equal(result?.type, 'redirect', router.state.matches.map(match => String(match.error)).join(', '));
  if (result?.type !== 'redirect') throw new Error('Expected a redirect');
  return new URL(result.redirect.headers.get('Location')!, 'https://app.tulipfarm.ai');
}

test('returning user lands in an existing workspace', async () => {
  assert.equal((await destination('/')).pathname, '/acme');
  assert.deepEqual(requests, ['/v1/auth/get-session', '/v1/workspaces']);
});

test('chat routes admit UUID deep links and redirect saved hash links', async () => {
  const chatId = '33333333-3333-4333-8333-333333333333';
  const router = await load(`/acme/chat/${chatId}`);
  assert.equal(router.state.matches.at(-1)?.routeId, '/$workspaceSlug/chat/$chatId');
  assert.equal(router.state.matches.at(-1)?.status, 'success');
  const legacy = await destination(`/acme#chat=${chatId}`);
  assert.equal(legacy.pathname, `/acme/chat/${chatId}`);
  assert.equal(legacy.hash, '');
  const invalid = await load('/acme/chat/not-a-uuid');
  assert.ok(invalid.state.matches.some(match => match.status === 'notFound'));
});

test('signed-out chat deep links preserve their path through sign-in', async () => {
  session = null;
  const path = '/acme/chat/33333333-3333-4333-8333-333333333333';
  const login = await destination(path);
  assert.equal(login.pathname, '/login');
  assert.equal(login.searchParams.get('redirect'), path);
});

test('public component routes do not remove workspace authentication', async () => {
  session = null;
  const login = await destination('/acme/agents');
  assert.equal(login.pathname, '/login');
  assert.equal(login.searchParams.get('redirect'), '/acme/agents');
  assert.deepEqual(requests, ['/v1/auth/get-session']);
});

test('home restores the last workspace used by the current account', async () => {
  workspaces = [acme, other];
  rememberWorkspace('returning-user', other.id);
  assert.equal((await destination('/')).pathname, '/other');
});

test('another account or a removed membership cannot select the home workspace', async () => {
  rememberWorkspace('another-user', other.id);
  workspaces = [acme, other];
  assert.equal((await destination('/')).pathname, '/acme');
  rememberWorkspace('returning-user', other.id);
  workspaces = [acme];
  assert.equal((await destination('/')).pathname, '/acme');
});

test('home works when browser storage is unavailable', async () => {
  Object.defineProperty(window, 'localStorage', {
    get() {
      throw new Error('Storage disabled');
    },
  });
  assert.doesNotThrow(() => rememberWorkspace('returning-user', acme.id));
  assert.equal((await destination('/')).pathname, '/acme');
});

test('saving the last workspace uses a credentialed write and reports failures', async () => {
  const mockFetch = globalThis.fetch;
  const controller = new AbortController();
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(new URL(String(url)).pathname, '/v1/workspaces/northstar/last-used');
      assert.equal(options?.method, 'PUT');
      assert.equal(options?.credentials, 'include');
      assert.equal(options?.signal, controller.signal);
      return new Response(null, { status: 204 });
    };
    await saveLastWorkspace('northstar', controller.signal);
    globalThis.fetch = async () => Response.json({ error: 'Workspace not found' }, { status: 404 });
    await assert.rejects(
      saveLastWorkspace('northstar', controller.signal),
      error => error instanceof WorkspaceRequestError && error.status === 404,
    );
  } finally {
    globalThis.fetch = mockFetch;
  }
});

test('only users without memberships are automatically sent to creation', async () => {
  workspaces = [];
  assert.equal((await destination('/')).pathname, '/create-workspace');
});

test('signed-out home and deep links preserve the sign-in destination', async () => {
  session = null;
  for (const path of ['/', '/acme/settings?tab=general#members']) {
    const url = await destination(path);
    assert.equal(url.pathname, '/login');
    assert.equal(url.searchParams.get('redirect'), path);
  }
  assert.ok(requests.every(path => path === '/v1/auth/get-session'));
});

test('workspace-first onboarding is public and resumes the same draft through authentication', async () => {
  for (const pathname of ['/onboarding', '/onboarding/chat']) {
    const path = `${pathname}#token=${'a'.repeat(64)}`;
    session = null;
    assert.equal((await load('/create-workspace')).state.matches.at(-1)?.status, 'success');
    assert.equal((await destination(path)).searchParams.get('redirect'), path);
    assert.equal(safeAuthRedirect(path), path);
    const callbacks = authCallbackURLs(path, 'https://app.tulipfarm.ai');
    assert.equal(magicLinkDestination(callbacks.callbackURL, 'https://app.tulipfarm.ai'), path);
    session = { session: { id: 'session' }, user: { id: 'user', name: '' } };
    assert.equal((await destination(path)).pathname, '/complete-profile');
    assert.equal((await destination(path)).searchParams.get('redirect'), path);
    session.user.name = 'Ada';
    assert.equal((await load(path)).state.matches.at(-1)?.status, 'success');
  }
  assert.equal(safeAuthRedirect('/onboarding/unknown'), '/');
  assert.equal(safeAuthRedirect('/onboarding/chat/unknown'), '/');
});

test('onboarding callback tokens are stripped from analytics URL properties', () => {
  const token = 'a'.repeat(64);
  const origin = 'https://app.tulipfarm.ai';
  for (const pathname of ['/onboarding', '/onboarding/chat']) {
    const callbacks = authCallbackURLs(`${pathname}#token=${token}`, origin);
    assert.deepEqual(
      redactOnboardingUrls(
        {
          $current_url: callbacks.callbackURL,
          $referrer: `${origin}/verify-email?token=magic&callbackURL=${encodeURIComponent(callbacks.callbackURL)}`,
          $set_once: { $initial_current_url: callbacks.errorCallbackURL },
          nested: [callbacks.callbackURL, 5, null],
          ordinary: `${origin}/acme/settings?tab=members`,
        },
        origin,
      ),
      {
        $current_url: `${origin}${pathname}`,
        $referrer: `${origin}/verify-email`,
        $set_once: { $initial_current_url: `${origin}/login` },
        nested: [`${origin}${pathname}`, 5, null],
        ordinary: `${origin}/workspace/settings`,
      },
    );
  }
});

test('signed-in login and registration use home or the requested workspace', async () => {
  for (const path of ['/login', '/register']) {
    assert.equal((await destination(path)).pathname, '/');
    const url = await destination(`${path}?redirect=${encodeURIComponent('/acme/settings?tab=general#members')}`);
    assert.equal(url.pathname + url.search + url.hash, '/acme/settings?tab=general#members');
  }
});

test('profile completion preserves the requested destination and exits when complete', async () => {
  session!.user.name = ' ';
  const url = await destination('/acme/settings');
  assert.equal(url.pathname, '/complete-profile');
  assert.equal(url.searchParams.get('redirect'), '/acme/settings');
  assert.equal((await load('/complete-profile?redirect=%2Facme%2Fsettings')).state.matches.at(-1)?.status, 'success');
  session!.user.name = 'Ada';
  assert.equal((await destination('/complete-profile?redirect=%2Facme%2Fsettings')).pathname, '/acme/settings');
});

test('existing members can explicitly create another workspace', async () => {
  const router = await load('/create-workspace');
  assert.equal(router.state.matches.at(-1)?.status, 'success');
  assert.ok(!requests.includes('/v1/workspaces'));
});

test('logout is available without a profile and signed-out logout goes to login', async () => {
  session!.user.name = '';
  assert.equal((await load('/logout')).state.matches.at(-1)?.status, 'success');
  session = null;
  assert.equal((await destination('/logout')).pathname, '/login');
});

test('legacy account paths lead to working authentication pages', async () => {
  for (const [path, expected] of [
    ['/signup', '/register'],
    ['/forgot-password', '/login'],
    ['/reset-password', '/login'],
    ['/auth', '/login'],
    ['/callback', '/'],
  ]) {
    const url = await destination(`${path}?redirect=%2Facme%2Fsettings`);
    assert.equal(url.pathname, expected);
    assert.equal(url.searchParams.get('redirect'), '/acme/settings');
  }
});

test('workspace and session failures are errors rather than new-user onboarding', async () => {
  workspaceStatus = 503;
  assert.equal((await load('/')).state.matches.at(-1)?.status, 'error');
  sessionStatus = 503;
  assert.equal((await load('/')).state.matches.at(-1)?.status, 'error');
});

test('expired workspace access returns to login and missing memberships return not found', async () => {
  workspaceStatus = 401;
  assert.equal((await destination('/')).pathname, '/login');
  const url = await destination('/acme/settings');
  assert.equal(url.pathname, '/login');
  assert.equal(url.searchParams.get('redirect'), '/acme/settings');
  workspaceStatus = 404;
  assert.ok((await load('/acme')).state.matches.some(match => match.status === 'notFound'));
  workspaceStatus = 403;
  assert.ok((await load('/acme')).state.matches.some(match => match.status === 'notFound'));
});

test('unsafe and authentication-loop redirects resolve to home', () => {
  for (const value of [
    null,
    '',
    'https://example.com',
    '//example.com',
    '/\\example.com',
    '/login',
    '/login/',
    '/register',
    '/logout',
    '/complete-profile',
    '/%6cogin',
    '/acme/../login',
    '/acme\n',
    '/%2fexample.com',
    '/%5cexample.com',
    '/%00acme',
    '/%zz',
  ]) {
    assert.equal(safeAuthRedirect(value), '/', String(value));
  }
  assert.equal(safeAuthRedirect('/acme/settings?tab=general#members'), '/acme/settings?tab=general#members');
  assert.equal(safeAuthRedirect('/create-workspace'), '/create-workspace');
});

const setupId = '44444444-4444-4444-8444-444444444444';
const setup = `/workspace-setups/${setupId}`;
const recovery = '/account/workspace-recovery';
const continuation = (path: string, destination: string) => `${path}?redirect=${encodeURIComponent(destination)}`;

async function settle(path: string) {
  const router = await load(path);
  const result = router._serverResult;
  return result?.type === 'redirect' ? result.redirect.headers.get('Location') : router.state.location.href;
}

test('setup and workspace recovery destinations survive sign-in, registration and profile completion', async () => {
  session = null;
  for (const path of [setup, recovery]) {
    assert.equal(await settle(path), continuation('/login', path));
    for (const authPath of ['/login', '/register'])
      assert.equal(await settle(continuation(authPath, path)), continuation(authPath, path));
  }
  session = { session: { id: 'session' }, user: { id: 'returning-user', name: ' ' } };
  for (const path of [setup, recovery]) {
    assert.equal(await settle(path), continuation('/complete-profile', path));
    assert.equal(await settle(continuation('/login', path)), continuation('/complete-profile', path));
    assert.equal(await settle(continuation('/complete-profile', path)), continuation('/complete-profile', path));
  }
  session.user.name = 'Ada';
  for (const path of [setup, recovery]) {
    for (const authPath of ['/login', '/register', '/complete-profile'])
      assert.equal(await settle(continuation(authPath, path)), path);
  }
});

test('an expired setup session returns to the setup page after sign-in', async () => {
  const expired = (await load(setup)).buildLocation({ to: '/login', search: { redirect: setup } }).href;
  assert.equal(expired, continuation('/login', setup));
  session = null;
  assert.equal(await settle(expired), expired);
  session = { session: { id: 'session' }, user: { id: 'returning-user', name: 'Ada' } };
  assert.equal(await settle(expired), setup);
});

test('callback URLs keep setup and workspace recovery destinations', () => {
  const origin = 'https://app.tulipfarm.ai';
  for (const path of [setup, recovery]) {
    const callbacks = authCallbackURLs(path, origin);
    assert.equal(callbacks.callbackURL, `${origin}${path}`);
    assert.equal(callbacks.newUserCallbackURL, `${origin}${path}`);
    assert.equal(new URL(callbacks.errorCallbackURL).searchParams.get('redirect'), path);
    assert.equal(magicLinkDestination(callbacks.callbackURL, origin), path);
  }
});

test('only exact setup and workspace recovery paths are allowed', () => {
  for (const value of [
    '/workspace-setups',
    '/workspace-setups/',
    '/workspace-setups/not-a-setup',
    `${setup}/`,
    `${setup}/status`,
    `/workspace-setups/${setupId}/../../login`,
    `/workspace-setups%2F${setupId}`,
    `/%77orkspace-setups/${setupId}`,
    '/account',
    '/account/',
    '/account/settings',
    `${recovery}/`,
    `${recovery}/extra`,
    `${recovery}/../../login`,
    '/account%2Fworkspace-recovery',
    '/%61ccount/workspace-recovery',
    `https://example.com${recovery}`,
    `//example.com${setup}`,
  ]) {
    assert.equal(safeAuthRedirect(value), '/', value);
  }
});

test('Google and email callbacks preserve destinations for both new and returning users', () => {
  const origin = 'https://app.tulipfarm.ai';
  const callbacks = authCallbackURLs('/acme/settings', origin);
  assert.equal(callbacks.callbackURL, `${origin}/acme/settings`);
  assert.equal(callbacks.newUserCallbackURL, callbacks.callbackURL);
  assert.equal(new URL(callbacks.errorCallbackURL).searchParams.get('redirect'), '/acme/settings');
  assert.equal(authCallbackURLs(null, origin).callbackURL, `${origin}/`);
  assert.equal(magicLinkDestination(`${origin}/acme/settings`, origin), '/acme/settings');
  assert.equal(magicLinkDestination('https://example.com/acme', origin), '/');
  assert.equal(magicLinkDestination(null, origin), '/');
});

test('invitation continuation survives auth, profile completion and already signed-out logout without workspace lookup', async () => {
  const invitation = `/invite?token=${acme.id}.${'a'.repeat(43)}`;
  assert.equal(safeAuthRedirect(invitation), invitation);
  const callbacks = authCallbackURLs(invitation, 'https://app.tulipfarm.ai');
  assert.equal(callbacks.callbackURL, `https://app.tulipfarm.ai${invitation}`);
  assert.equal(callbacks.newUserCallbackURL, callbacks.callbackURL);
  assert.equal(new URL(callbacks.errorCallbackURL).searchParams.get('redirect'), invitation);
  assert.equal(magicLinkDestination(callbacks.callbackURL, 'https://app.tulipfarm.ai'), invitation);
  for (const path of ['/login', '/register'])
    assert.equal(
      (await destination(`${path}?redirect=${encodeURIComponent(invitation)}`)).searchParams.get('token'),
      `${acme.id}.${'a'.repeat(43)}`,
    );
  session!.user.name = '';
  assert.equal((await destination(invitation)).searchParams.get('redirect'), invitation);
  session = null;
  assert.equal((await load(invitation)).state.matches.at(-1)?.status, 'success');
  assert.equal(
    (await destination(`/logout?redirect=${encodeURIComponent(invitation)}`)).searchParams.get('redirect'),
    invitation,
  );
  assert.equal(requests.includes('/v1/workspaces'), false);
  for (const path of [
    '/invite',
    '/invite?token=x',
    `${invitation}&next=https://evil.example`,
    `${invitation}#x`,
    `${invitation}&token=x`,
    invitation.replace('/invite', '/%69nvite'),
  ])
    assert.equal(safeAuthRedirect(path), '/');
});
