// Test support for extension slots. Imports node:test, so it is never part of a runtime entry.

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { AppFile, AppPublisher, AppRoute, AppTraffic } from './slots.ts';

export type AppPublisherFixture = {
  readonly publisher: AppPublisher;
  /** A fresh public name the publisher may route. Each call returns a name no other call returned. */
  readonly name: () => Promise<string>;
};

export type AppPublisherCase = {
  readonly name: string;
  run(fixture: AppPublisherFixture): Promise<void>;
};

const signal = () => new AbortController().signal;

async function routeOf(publisher: AppPublisher, name: string) {
  for await (const route of publisher.list(signal())) if (route.name === name) return route;
  return undefined;
}

async function staged(publisher: AppPublisher, releaseId: string) {
  for await (const release of publisher.releases(signal())) if (release.releaseId === releaseId) return true;
  return false;
}

/** Behavior every `AppPublisher` must show. Hosted and built-in publishers run the same cases. */
export const appPublisherContract: readonly AppPublisherCase[] = [
  {
    name: 'apply only moves a route forward',
    async run({ publisher, name }) {
      const app = await name();
      const first = randomUUID();
      const second = randomUUID();
      const apply = (route: AppRoute) => publisher.apply(route, signal());
      assert.deepEqual(await apply({ name: app, kind: 'static', releaseId: first, status: 'active', version: 2 }), {
        stored: { name: app, kind: 'static', releaseId: first, status: 'active', version: 2 },
      });
      assert.deepEqual(await apply({ name: app, kind: 'static', releaseId: second, status: 'active', version: 1 }), {
        stored: { name: app, kind: 'static', releaseId: first, status: 'active', version: 2 },
      });
      assert.deepEqual(await apply({ name: app, kind: 'static', releaseId: second, status: 'disabled', version: 2 }), {
        stored: { name: app, kind: 'static', releaseId: first, status: 'active', version: 2 },
      });
      assert.deepEqual(await apply({ name: app, kind: 'static', releaseId: second, status: 'paused', version: 3 }), {
        stored: { name: app, kind: 'static', releaseId: second, status: 'paused', version: 3 },
      });
      assert.deepEqual(await apply({ name: app, kind: 'static', releaseId: null, status: 'active', version: 4 }), {
        stored: { name: app, kind: 'static', releaseId: null, status: 'active', version: 4 },
      });
      assert.deepEqual(await routeOf(publisher, app), {
        name: app,
        kind: 'static',
        releaseId: null,
        status: 'active',
        version: 4,
      });
    },
  },
  {
    name: 'a route keeps its kind',
    async run({ publisher, name }) {
      const app = await name();
      const release = randomUUID();
      await publisher.apply({ name: app, kind: 'static', releaseId: release, status: 'active', version: 1 }, signal());
      assert.deepEqual(await publisher.apply({ name: app, kind: 'server', status: 'active', version: 2 }, signal()), {
        stored: { name: app, kind: 'server', status: 'active', version: 2 },
      });
      assert.deepEqual(await routeOf(publisher, app), { name: app, kind: 'server', status: 'active', version: 2 });
      await publisher.apply({ name: app, kind: 'static', releaseId: release, status: 'paused', version: 3 }, signal());
      assert.deepEqual(await routeOf(publisher, app), {
        name: app,
        kind: 'static',
        releaseId: release,
        status: 'paused',
        version: 3,
      });
    },
  },
  {
    name: 'remove takes a route away only for a newer version',
    async run({ publisher, name }) {
      const removed = await name();
      const kept = await name();
      const release = randomUUID();
      await publisher.apply(
        { name: removed, kind: 'static', releaseId: release, status: 'active', version: 5 },
        signal(),
      );
      await publisher.apply({ name: kept, kind: 'static', releaseId: release, status: 'active', version: 1 }, signal());
      await publisher.remove({ name: removed, version: 5 }, signal());
      await publisher.remove({ name: removed, version: 4 }, signal());
      assert.deepEqual(await routeOf(publisher, removed), {
        name: removed,
        kind: 'static',
        releaseId: release,
        status: 'active',
        version: 5,
      });
      await publisher.remove({ name: removed, version: 6 }, signal());
      assert.equal(await routeOf(publisher, removed), undefined);
      assert.deepEqual(
        await publisher.apply(
          { name: removed, kind: 'static', releaseId: release, status: 'active', version: 6 },
          signal(),
        ),
        { stored: null },
      );
      assert.equal(await routeOf(publisher, removed), undefined);
      assert.deepEqual(await routeOf(publisher, kept), {
        name: kept,
        kind: 'static',
        releaseId: release,
        status: 'active',
        version: 1,
      });
    },
  },
  {
    name: 'stage copies each file once and discard drops the release',
    async run({ publisher }) {
      const releaseId = randomUUID();
      const contents = new Map([
        ['index.html', new TextEncoder().encode('<!doctype html><title>Orders</title>')],
        ['assets/app.js', new TextEncoder().encode('console.log("orders");')],
      ]);
      const files: AppFile[] = [];
      for (const [path, bytes] of contents)
        files.push({
          path,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          bytes: bytes.byteLength,
          contentType: path.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
        });
      const reads: string[] = [];
      const read = async function* (file: AppFile) {
        reads.push(file.path);
        yield contents.get(file.path)!;
      };
      await publisher.stage({ releaseId, files, read }, signal());
      assert.deepEqual(reads.toSorted(), ['assets/app.js', 'index.html']);
      assert.equal(await staged(publisher, releaseId), true);
      reads.length = 0;
      await publisher.stage({ releaseId, files, read }, signal());
      assert.deepEqual(reads, []);
      await publisher.discard({ releaseId }, signal());
      assert.equal(await staged(publisher, releaseId), false);
      await publisher.discard({ releaseId }, signal());
    },
  },
  {
    name: 'discard keeps a release that a route points at',
    async run({ publisher, name }) {
      const app = await name();
      const live = randomUUID();
      const next = randomUUID();
      const file: AppFile = { path: 'index.html', sha256: '0'.repeat(64), bytes: 2, contentType: 'text/html' };
      const read = async function* () {
        yield new TextEncoder().encode('hi');
      };
      await publisher.stage({ releaseId: live, files: [file], read }, signal());
      await publisher.stage({ releaseId: next, files: [file], read }, signal());
      await publisher.apply({ name: app, kind: 'static', releaseId: live, status: 'paused', version: 1 }, signal());
      await publisher.discard({ releaseId: live }, signal());
      assert.equal(await staged(publisher, live), true);
      await publisher.apply({ name: app, kind: 'static', releaseId: next, status: 'active', version: 2 }, signal());
      await publisher.discard({ releaseId: live }, signal());
      assert.equal(await staged(publisher, live), false);
      assert.equal(await staged(publisher, next), true);
    },
  },
];

/** Registers the publisher contract as node:test tests. `setup` runs per test, after any `before` hooks. */
export function testAppPublisher(label: string, setup: () => AppPublisherFixture | Promise<AppPublisherFixture>) {
  for (const contractCase of appPublisherContract)
    test(`${label}: ${contractCase.name}`, async () => contractCase.run(await setup()));
}

export type MemoryAppPublisher = AppPublisher & {
  /** Staged file bytes by `releases/<releaseId>/<path>`. */
  readonly objects: ReadonlyMap<string, Uint8Array>;
};

/** An in-memory publisher that passes the contract, for tests of code that publishes. */
export function memoryAppPublisher(
  options: { readonly usage?: (window: { start: string; end: string }) => readonly AppTraffic[] } = {},
): MemoryAppPublisher {
  const routes = new Map<string, AppRoute>();
  const versions = new Map<string, number>();
  const objects = new Map<string, Uint8Array>();
  const prefix = (releaseId: string) => `releases/${releaseId}/`;
  return {
    objects,
    async stage({ releaseId, files, read }, signal) {
      for (const file of files) {
        signal.throwIfAborted();
        const key = prefix(releaseId) + file.path;
        if (objects.has(key)) continue;
        const chunks: Uint8Array[] = [];
        for await (const chunk of read(file)) chunks.push(chunk);
        objects.set(key, Buffer.concat(chunks));
      }
    },
    async apply(route) {
      if ((versions.get(route.name) ?? -1) < route.version) {
        routes.set(route.name, { ...route });
        versions.set(route.name, route.version);
      }
      return { stored: routes.get(route.name) ?? null };
    },
    async remove({ name, version }) {
      if ((versions.get(name) ?? -1) >= version) return;
      routes.delete(name);
      versions.set(name, version);
    },
    async discard({ releaseId }) {
      for (const route of routes.values()) if (route.kind === 'static' && route.releaseId === releaseId) return;
      for (const key of objects.keys()) if (key.startsWith(prefix(releaseId))) objects.delete(key);
    },
    async *list() {
      yield* routes.values();
    },
    async *releases() {
      const ids = new Set([...objects.keys()].map(key => key.split('/')[1]!));
      for (const releaseId of ids) yield { releaseId };
    },
    async *usage(window) {
      yield* options.usage?.(window) ?? [];
    },
  };
}
