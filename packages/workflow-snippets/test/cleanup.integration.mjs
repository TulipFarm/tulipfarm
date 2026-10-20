import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';
import { createSnippetRunner } from '../src/index.ts';
import { createSnippetBroker } from '../src/broker.ts';
import { createSnippetClient } from '../src/client.ts';

test(
  'failed real Docker cleanup blocks runner and broker admission until reconciliation',
  { timeout: 120000 },
  async () => {
    const image = process.env.SNIPPET_TEST_IMAGE;
    assert.ok(image);
    const docker = execFileSync('which', ['docker'], { encoding: 'utf8' }).trim();
    const directory = await mkdtemp(join(tmpdir(), 'snippet-cleanup-')),
      path = process.env.PATH;
    const owner = randomUUID(),
      database = join(directory, 'jobs.sqlite'),
      token = 'a'.repeat(64);
    const ids = ownerId =>
      execFileSync(docker, ['ps', '-aq', '--filter', `label=ai.tulipfarm.snippet-owner=${ownerId}`], {
        encoding: 'utf8',
      })
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    let broker, brokerOwner;
    try {
      const shim = join(directory, 'docker');
      await writeFile(shim, `#!/bin/sh\nif [ "$1" = "rm" ]; then exit 1; fi\nexec "${docker}" "$@"\n`);
      await chmod(shim, 0o755);
      process.env.PATH = `${directory}:${path}`;
      const runner = createSnippetRunner({ image, owner, runtime: 'runc', allowLocalRunc: true, timeoutMs: 1500 });
      const input = {
        language: 'javascript',
        source: 'await new Promise(r => setTimeout(r, 120000)); return 1;',
        input: null,
      };
      for (let i = 0; i < 5; i++) await assert.rejects(runner.execute(input), /cleanup-failed/);
      assert.equal(ids(owner).length, 1, 'uncertain cleanup cannot release a slot for another container');
      await assert.rejects(runner.reconcile(), /unavailable/);
      await assert.rejects(runner.execute(input), /cleanup-failed/);
      process.env.PATH = path;
      await runner.reconcile();
      assert.equal(ids(owner).length, 0);
      assert.equal(await runner.execute({ ...input, source: 'return 7' }), 7);
      process.env.PATH = `${directory}:${path}`;
      const concurrent = Array.from({ length: 4 }, () => assert.rejects(runner.execute(input), /cleanup-failed/));
      await assert.rejects(runner.execute(input), /unavailable/);
      await assert.rejects(runner.reconcile(), /unavailable/);
      await Promise.all(concurrent);
      assert.equal(ids(owner).length, 4);
      await assert.rejects(runner.execute(input), /cleanup-failed/);
      process.env.PATH = path;
      await runner.reconcile();
      assert.equal(ids(owner).length, 0);
      const options = { database, token, image, runtime: 'runc', allowLocalRunc: true, timeoutMs: 1500 };
      broker = await createSnippetBroker(options);
      await new Promise(resolve => broker.server.listen(0, '127.0.0.1', resolve));
      const client = createSnippetClient({
        url: `http://127.0.0.1:${broker.server.address().port}`,
        token,
        allowLocalHttp: true,
      });
      process.env.PATH = `${directory}:${path}`;
      const request = {
        ...input,
        workspaceId: randomUUID(),
        runId: randomUUID(),
        revision: randomUUID(),
        stepId: 'code',
      };
      assert.deepEqual(await client.submit(request), { kind: 'pending' });
      for (let i = 0; i < 100 && broker.server.listening; i++) await setTimeout(100);
      assert.equal(broker.server.listening, false, 'broker closes admission on cleanup failure');
      await broker.close();
      broker = undefined;
      const db = new DatabaseSync(database);
      brokerOwner = db.prepare('SELECT id FROM identity').get().id;
      assert.deepEqual(
        { ...db.prepare('SELECT state,result,attempts FROM jobs').get() },
        { state: 'running', result: null, attempts: 1 },
      );
      db.close();
      assert.equal(ids(brokerOwner).length, 1);
      await assert.rejects(createSnippetBroker(options), /unavailable/);
      process.env.PATH = path;
      broker = await createSnippetBroker(options);
      await new Promise(resolve => broker.server.listen(0, '127.0.0.1', resolve));
      const restarted = createSnippetClient({
        url: `http://127.0.0.1:${broker.server.address().port}`,
        token,
        allowLocalHttp: true,
      });
      let result;
      for (let i = 0; i < 100; i++) {
        result = await restarted.submit(request);
        if (result.kind !== 'pending') break;
        await setTimeout(100);
      }
      assert.deepEqual(result, { kind: 'failed', error: 'deadline' });
      assert.equal(ids(brokerOwner).length, 0);
    } finally {
      process.env.PATH = path;
      await broker?.close();
      for (const ownerId of [owner, brokerOwner].filter(Boolean)) {
        const containers = ids(ownerId);
        if (containers.length) execFileSync(docker, ['rm', '-f', ...containers]);
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);
