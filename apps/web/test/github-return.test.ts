import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { githubReturn, parseGitHubReturn, rememberGitHubReturn } from '../src/lib/github-return.ts';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const otherWorkspace = '22222222-2222-4222-8222-222222222222';
const state = `${workspaceId}.${'a'.repeat(43)}`;
const storage = new Map<string, string>();
const location = { pathname: '/', search: '' };
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    location,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
    },
  },
});
const at = (path: string) => {
  const [pathname, search = ''] = path.split('?');
  location.pathname = pathname!;
  location.search = search ? `?${search}` : '';
};

beforeEach(() => storage.clear());

test('GitHub App installation parameters on the sign-in callback are ignored', () => {
  assert.deepEqual(
    parseGitHubReturn('/github/callback', `?code=abc&state=${state}&installation_id=42&setup_action=install`),
    { kind: 'oauth', input: { code: 'abc', state }, workspaceId },
  );
  assert.deepEqual(parseGitHubReturn('/github/callback', `?code=abc&state=${state}&installation_id=x`), {
    kind: 'invalid',
    workspaceId,
  });
});

test('GitHub App setup returns are recognised without a sign-in state', () => {
  assert.deepEqual(parseGitHubReturn('/integrations/github', '?installation_id=42&setup_action=update'), {
    kind: 'setup',
    action: 'update',
  });
  assert.deepEqual(parseGitHubReturn('/integrations/github', '?setup_action=request'), {
    kind: 'setup',
    action: 'request',
  });
  assert.deepEqual(parseGitHubReturn('/github/callback', '?code=abc&installation_id=42&setup_action=install'), {
    kind: 'setup',
    action: 'install',
  });
  assert.deepEqual(parseGitHubReturn('/integrations/github', ''), { kind: 'setup', action: null });
  assert.deepEqual(parseGitHubReturn('/github/callback', ''), { kind: 'invalid', workspaceId: null });
});

test('the return link points to where GitHub sign-in started, never to a GitHub return page', () => {
  at('/acme/chat/thread-1?draft=1');
  rememberGitHubReturn(workspaceId);
  assert.deepEqual(githubReturn(workspaceId), { workspaceId, path: '/acme/chat/thread-1?draft=1' });
  at('/github/callback');
  rememberGitHubReturn(workspaceId);
  assert.equal(githubReturn(workspaceId)?.path, '/acme/chat/thread-1?draft=1');
  assert.equal(githubReturn(otherWorkspace), null);
  rememberGitHubReturn(otherWorkspace);
  assert.deepEqual(githubReturn(otherWorkspace), { workspaceId: otherWorkspace, path: null });
});
