import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createServer } from 'vite';

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const requests: string[] = [];
globalThis.fetch = async input => {
  const url = new URL(String(input));
  requests.push(`${url.pathname}${url.search}`);
  return Response.json({ 'openai-models': true });
};
const window = new EventTarget();
Object.defineProperty(globalThis, 'window', { value: window, configurable: true });

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
});
after(async () => {
  await server.close();
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});
const { setFlagWorkspace } = await server.ssrLoadModule('/src/lib/feature-flags.ts');

test('flags are read once per workspace per page load, never again on focus or revisits', async () => {
  setFlagWorkspace('acme');
  setFlagWorkspace('acme');
  setFlagWorkspace('other');
  setFlagWorkspace('acme');
  window.dispatchEvent(new Event('blur'));
  window.dispatchEvent(new Event('focus'));
  await setImmediate();
  assert.deepEqual(requests, ['/v1/feature-flags?workspace=acme', '/v1/feature-flags?workspace=other']);
});
