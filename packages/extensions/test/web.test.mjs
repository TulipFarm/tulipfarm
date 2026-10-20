import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOverrideRegistry, defineWebExtension, guardBrowserAnalytics, noopBrowserAnalytics } from '../src/web.ts';

const DefaultBilling = () => 'unlimited';
const defaults = { 'settings.billing': DefaultBilling, 'routes.extra': [] };

test('defaults apply until an extension overrides them', () => {
  const registry = createOverrideRegistry(defaults);
  assert.deepEqual(registry.names(), ['settings.billing', 'routes.extra']);
  assert.equal(registry.get('settings.billing'), DefaultBilling);
  assert.equal(registry.overriddenBy('settings.billing'), undefined);
  registry.apply([]);
  assert.equal(registry.sealed, true);
  assert.equal(registry.get('settings.billing'), DefaultBilling);
  assert.throws(() => registry.get('nope'), /Unknown override "nope"/);
});

test('an extension overrides components and routes by name, then the registry seals', () => {
  const Billing = () => 'credits';
  const routes = [{ path: '/billing' }];
  let late;
  const registry = createOverrideRegistry(defaults);
  registry.apply([
    defineWebExtension({
      name: 'private',
      register(slots) {
        late = slots;
        slots.override('settings.billing', Billing);
        slots.override('routes.extra', routes);
      },
    }),
  ]);
  assert.equal(registry.get('settings.billing'), Billing);
  assert.equal(registry.get('routes.extra'), routes);
  assert.equal(registry.overriddenBy('settings.billing'), 'private');
  assert.throws(() => late.override('settings.billing', DefaultBilling), /overrode "settings.billing" after startup/);
  assert.throws(() => registry.apply([]), /already applied/);
});

test('conflicts and unknown names fail', () => {
  const one = { name: 'one', register: slots => slots.override('settings.billing', () => 'one') };
  const two = { name: 'two', register: slots => slots.override('settings.billing', () => 'two') };
  assert.throws(
    () => createOverrideRegistry(defaults).apply([one, two]),
    /"two" cannot override "settings.billing": "one" already did/,
  );
  assert.throws(() => createOverrideRegistry(defaults).apply([one, one]), /"one" is listed twice/);
  assert.throws(
    () => createOverrideRegistry(defaults).apply([{ name: 'x', register: slots => slots.override('nope', 1) }]),
    /overrode unknown "nope"/,
  );
});

test('browser analytics defaults to a no-op and can be overridden by a web extension', () => {
  const registry = createOverrideRegistry({ analytics: noopBrowserAnalytics });
  registry.apply([]);
  const analytics = guardBrowserAnalytics(registry.get('analytics'));
  assert.equal(analytics.configured(), false);
  for (const name of ['choose', 'start', 'pageview', 'identify', 'workspace', 'capture', 'captureException', 'logout'])
    assert.equal(analytics[name]('x'), undefined);

  const seen = [];
  const vendor = {
    ...noopBrowserAnalytics,
    configured: () => true,
    capture: (event, properties) => seen.push([event, properties]),
    captureException: error => seen.push(['error', error.message]),
  };
  const overridden = createOverrideRegistry({ analytics: noopBrowserAnalytics });
  overridden.apply([
    defineWebExtension({
      name: 'private',
      register(slots) {
        slots.override('analytics', vendor);
      },
    }),
  ]);
  const client = guardBrowserAnalytics(overridden.get('analytics'));
  assert.equal(client.configured(), true);
  client.capture('page_opened', { page: 'settings' });
  client.captureException(new Error('render failed'));
  assert.deepEqual(seen, [
    ['page_opened', { page: 'settings' }],
    ['error', 'render failed'],
  ]);
});

test('a failing browser analytics client never throws into the app', () => {
  const broken = Object.fromEntries(
    Object.keys(noopBrowserAnalytics).map(name => [
      name,
      () => {
        throw new Error('vendor down');
      },
    ]),
  );
  const analytics = guardBrowserAnalytics(broken);
  assert.equal(analytics.configured(), false);
  assert.doesNotThrow(() => {
    analytics.start();
    analytics.capture('x');
    analytics.captureException(new Error('y'));
    analytics.logout();
  });
});
