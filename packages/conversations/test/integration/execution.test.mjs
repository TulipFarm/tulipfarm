import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied, lockAuthorization } from '@tulipfarm/access';
import { executionPolicySchema } from '@tulipfarm/execution-contract';
import {
  claimIntent,
  finishIntent,
  requestHash,
  findArea,
  lockExecutionStorage,
  commitManifest,
  reserveAllocation,
  transitionAllocation,
  requireGeneration,
  reserveUpload,
  finishUpload,
  writeExecutionObject,
  readExecutionObject,
  removeExecutionObject,
  beginObjectCleanup,
  finishObjectCleanup,
  readObject,
  readJob,
  beginJob,
  observeJob,
  finishSavedJob,
  finishInterruptedJob,
  appendOutput,
  executionChunkBytes,
} from '@tulipfarm/execution';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { createChatExecution } from '../../src/execution.ts';
import { conversationFixture } from '../fixture.mjs';
import { connect, denied } from '../../../workspace-storage/test/integration/fixture.mjs';

const policy = executionPolicySchema.parse({
  version: 1,
  baseRevision: 'a'.repeat(64),
  defaultProfile: 'small',
  profiles: [{ id: 'small', resources: { kind: 'limited', cpuMillis: 500, memoryMiB: 1024, diskBytes: 1048576 } }],
  network: 'public-only',
  idleTimeoutSeconds: 300,
  limits: {
    jobTimeoutSeconds: 30,
    queueTimeoutSeconds: 5,
    stopGraceSeconds: 2,
    checkpointIntervalSeconds: 1,
    workspaceConcurrency: 1,
    deploymentConcurrency: 1,
    workspaceStorageBytes: 1048576,
    fileBytes: 65536,
    fileCount: 32,
    outputBytes: 8192,
    jobBudgetPicoUsd: '0',
  },
});
const configuration = { mode: 'docker', policy, policyRevision: requestHash(policy) };
const descriptor = {
  profiles: policy.profiles,
  capabilities: {
    isolation: 'container',
    network: 'public-only',
    hardDeadlines: true,
    reconnect: true,
    previews: false,
  },
};

test('retained byte streams enforce scope, size, digest and access checks at chunk boundaries', async () => {
  const data = new Map();
  const store = {
    putIfAbsent: async (key, value) => {
      if (!data.has(key)) data.set(key, Buffer.from(value));
    },
    read: async key => {
      const value = data.get(key);
      if (!value) throw new Error('Object not found');
      return value;
    },
    remove: async key => {
      data.delete(key);
    },
  };
  const contents = Buffer.alloc(executionChunkBytes + 7, 'a');
  const object = {
    workspaceId: randomUUID(),
    areaId: randomUUID(),
    objectId: randomUUID(),
    size: contents.length,
    sha256: createHash('sha256').update(contents).digest('hex'),
  };
  const signal = new AbortController().signal;
  const body = async function* () {
    yield contents.subarray(0, 13);
    yield contents.subarray(13);
  };
  const chunks = await writeExecutionObject(store, object, body(), signal);
  assert.deepEqual(
    chunks.map(chunk => chunk.size),
    [executionChunkBytes, 7],
  );
  const read = async (reference = object, authorize = async () => {}) => {
    const result = [];
    for await (const bytes of readExecutionObject(store, reference, chunks, authorize, signal)) result.push(bytes);
    return Buffer.concat(result);
  };
  assert.deepEqual(await read(), contents);
  await assert.rejects(read({ ...object, areaId: randomUUID() }), /Object not found/);
  await assert.rejects(read({ ...object, workspaceId: randomUUID() }), /Object not found/);
  let checks = 0;
  await assert.rejects(
    read(object, async () => {
      if (++checks === 3) throw new Error('Access revoked');
    }),
    /Access revoked/,
  );
  await assert.rejects(writeExecutionObject(store, { ...object, size: 1 }, body(), signal), /quota/);
  await assert.rejects(
    writeExecutionObject(store, { ...object, objectId: randomUUID(), sha256: 'f'.repeat(64) }, body(), signal),
    /request-conflict/,
  );
  const key = [...data.keys()][0];
  data.get(key)[0] ^= 1;
  await assert.rejects(read(), /request-conflict/);
});

test('execution persists chat authority, fenced jobs and immutable file manifests', { timeout: 60000 }, async t => {
  const f = await conversationFixture();
  try {
    const w = f.workspace;
    const service = createChatExecution(f.runtime, configuration, descriptor);
    const tx = operation => f.runtime.transaction(w.id, commonCompatibility, operation);
    async function chat(grant = true) {
      const id = randomUUID();
      await f.store.create(w.id, w.userId, { chatId: id, commandId: randomUUID() });
      if (grant) {
        const status = await service.status(w.id, w.userId, id);
        await service.grant(w.id, w.userId, id, { profileId: 'small', scopeRevision: status.scopeRevision });
      }
      return id;
    }
    async function request(chatId) {
      const sent = await f.store.send(w.id, w.userId, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'Local execution fixture' }],
      });
      await f.db.platform.query(
        `UPDATE ${f.table('tf_conversation_turns')} SET status='processing',attempt_epoch=1,
          lease_until=clock_timestamp()+interval '1 minute' WHERE id=$1`,
        [sent.turnId],
      );
      const callId = randomUUID();
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_conversation_tool_calls')}(id,conversation_id,turn_id,sequence,tool,status)
          VALUES($1,$2,$3,1,'execution.command','running')`,
        [callId, chatId, sent.turnId],
      );
      return {
        callId,
        turnId: sent.turnId,
        turnGeneration: 0,
        turnEpoch: 1,
        command: { program: 'python', args: ['-V'] },
        sources: [],
      };
    }

    async function outputJob() {
      const chatId = await chat(),
        input = await request(chatId);
      const job = await service.enqueue(w.id, w.userId, chatId, input);
      const area = await tx(t => findArea(t, chatId));
      const runnerId = randomUUID();
      let allocation = await tx(t => reserveAllocation(t, area, runnerId, new Date(Date.now() + 60000).toISOString()));
      allocation = await tx(t => transitionAllocation(t, allocation, 'ready'));
      await tx(t => beginJob(t, area, job.id, allocation, policy));
      const intent = await tx(t => claimIntent(t, 60));
      assert.equal(intent.job_id, job.id);
      return { chatId, input, job, area, runnerId, intent };
    }

    await t.test('file cleanup fences late and uncertain uploads and retries partial retirement', async () => {
      const chatId = await chat();
      const area = await tx(t => findArea(t, chatId));
      const data = new Map();
      let gate, failFence;
      const store = {
        async putIfAbsent(key, value) {
          if (key === gate?.key) {
            if (gate.order === 'after' && !data.has(key)) data.set(key, Buffer.from(value));
            gate.entered.resolve();
            await gate.release.promise;
            if (gate.order === 'after') throw new Error('lost write response');
          }
          if (!data.has(key)) data.set(key, Buffer.from(value));
        },
        async read(key, expected) {
          const value = data.get(key);
          if (!value || value.length !== expected) throw new Error('size-mismatch');
          return value;
        },
        async retireExecutionChunk(key) {
          if (key === failFence) {
            failFence = undefined;
            throw new Error('retirement unavailable');
          }
          data.set(key, Buffer.alloc(0));
        },
      };
      const content = Buffer.alloc(executionChunkBytes + 17, 7);
      const file = {
        path: 'retiring.bin',
        size: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
        executable: false,
      };
      const limits = {
        ...policy.limits,
        fileBytes: content.length,
        workspaceStorageBytes: 16 * executionChunkBytes,
      };
      const signal = new AbortController().signal;
      const source = async function* () {
        yield content;
      };
      async function reserve() {
        const upload = await tx(async t => {
          await lockExecutionStorage(t);
          return reserveUpload(t, area, file, [], limits);
        });
        const ref = {
          workspaceId: w.id,
          areaId: area.id,
          objectId: upload.objectId,
          size: file.size,
          sha256: file.sha256,
        };
        const prefix = `execution/v1/${w.id}/${area.id}/${upload.objectId}`;
        return { ref, prefix };
      }
      async function expire(objectId) {
        await f.db.platform.query(
          `UPDATE ${f.table('tf_execution_objects')} SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
          [objectId],
        );
        await f.db.platform.query(
          `UPDATE ${f.table('tf_execution_outbox')} SET available_at=clock_timestamp()-interval '1 second' WHERE object_id=$1`,
          [objectId],
        );
        const intent = await tx(t => claimIntent(t, 60));
        assert.equal(intent.object_id, objectId);
        return intent;
      }
      async function cleanup(ref, intent) {
        assert.ok(await tx(t => beginObjectCleanup(t, area.id, ref.objectId)));
        await removeExecutionObject(store, ref, signal);
        await tx(async t => {
          await finishObjectCleanup(t, area.id, ref.objectId);
          await finishIntent(t, intent);
        });
      }
      for (const order of ['before', 'after']) {
        const { ref, prefix } = await reserve();
        gate = {
          key: `${prefix}/0`,
          order,
          entered: Promise.withResolvers(),
          release: Promise.withResolvers(),
        };
        const write = writeExecutionObject(store, ref, source(), signal).then(
          receipt => ({ receipt }),
          error => ({ error }),
        );
        try {
          await gate.entered.promise;
          await cleanup(ref, await expire(ref.objectId));
          assert.equal((await tx(t => readObject(t, area.id, ref.objectId))).state, 'deleted');
          gate.release.resolve();
          assert.ok((await write).error);
          assert.equal(data.get(`${prefix}/0`).length, 0);
          assert.equal(data.get(`${prefix}/1`).length, 0);
          assert.equal(await tx(t => beginObjectCleanup(t, area.id, ref.objectId)), undefined);
        } finally {
          gate.release.resolve();
          await write;
          gate = undefined;
        }
      }
      const { ref, prefix } = await reserve();
      const chunks = await writeExecutionObject(store, ref, source(), signal);
      await tx(t => finishUpload(t, area, ref.objectId, chunks));
      const intent = await expire(ref.objectId);
      failFence = `${prefix}/1`;
      await assert.rejects(cleanup(ref, intent), /retirement unavailable/);
      assert.equal((await tx(t => readObject(t, area.id, ref.objectId))).state, 'deleting');
      assert.equal(data.get(`${prefix}/0`).length, 0);
      assert.equal(data.get(`${prefix}/1`).length, 17);
      assert.equal(
        (
          await f.db.platform.query(`SELECT completed_at FROM ${f.table('tf_execution_outbox')} WHERE id=$1`, [
            intent.id,
          ])
        ).rows[0].completed_at,
        null,
      );
      await cleanup(ref, intent);
      assert.equal((await tx(t => readObject(t, area.id, ref.objectId))).state, 'deleted');
      assert.equal(
        [...data.values()].reduce((total, bytes) => total + bytes.length, 0),
        0,
      );
    });

    await t.test('output capture uses bounded batches, durable cursors and the owning runner claim', async () => {
      const current = await outputJob();
      const events = Array.from({ length: 67 }, (_, index) => ({
        kind: 'chunk',
        sequence: index + 1,
        stream: 'stdout',
        data: Buffer.from([index]).toString('base64'),
      }));
      events.push({ kind: 'end', sequence: 68 });
      const requests = [];
      let pulled = 0,
        closed = 0;
      const backend = {
        descriptor,
        async *readOutput(input) {
          requests.push(input);
          try {
            for (const event of events.filter(event => event.sequence > input.after)) {
              pulled++;
              yield event;
            }
          } finally {
            closed++;
          }
        },
      };
      const capture = (overrides = {}) =>
        service.captureOutput(w.id, w.userId, current.chatId, {
          intent: current.intent,
          runnerId: current.runnerId,
          backend,
          signal: new AbortController().signal,
          ...overrides,
        });
      await assert.rejects(capture({ runnerId: randomUUID() }), /stale/);
      await assert.rejects(capture({ intent: { ...current.intent, lease_id: randomUUID() } }), /stale/);
      await assert.rejects(capture({ intent: { ...current.intent, area_id: randomUUID() } }), /stale/);
      await assert.rejects(capture({ signal: AbortSignal.abort() }), { name: 'AbortError' });
      assert.equal(requests.length, 0);
      await assert.rejects(
        capture({
          backend: {
            descriptor,
            async *readOutput() {
              yield { kind: 'chunk', sequence: 1, stream: 'stdout', data: Buffer.alloc(8192).toString('base64') };
              yield { kind: 'chunk', sequence: 2, stream: 'stdout', data: 'AQ==' };
            },
          },
        }),
        /quota/,
      );
      assert.equal((await service.output(w.id, w.userId, current.chatId, current.job.id)).after, 0);
      assert.deepEqual(await capture(), { after: 64, bytes: 64, truncated: false, complete: false });
      assert.equal(pulled, 64);
      assert.equal(closed, 1);
      const saved = { after: 68, bytes: 67, truncated: false, complete: true };
      assert.deepEqual(await capture(), saved);
      assert.deepEqual(await capture(), saved);
      assert.deepEqual(
        requests.map(request => request.after),
        [0, 64],
      );
      assert.equal(closed, 2);
      const page = await service.output(w.id, w.userId, current.chatId, current.job.id, 64);
      assert.deepEqual(page.events, events.slice(64));
      assert.equal(page.complete, true);
      await tx(t => finishIntent(t, current.intent));
    });

    await t.test('output capture rechecks authority and lease after I/O without holding database locks', async () => {
      const current = await outputJob();
      const event = { kind: 'chunk', sequence: 1, stream: 'stderr', data: 'AP8=' };
      const capture = (backend, overrides = {}) =>
        service.captureOutput(w.id, w.userId, current.chatId, {
          intent: current.intent,
          runnerId: current.runnerId,
          backend,
          signal: new AbortController().signal,
          ...overrides,
        });
      const duringRead = effect => ({
        descriptor,
        async *readOutput() {
          yield event;
          await tx(async t => {
            await t.client.query("SET LOCAL lock_timeout='2s'");
            await lockAuthorization(t);
            await effect(t);
          });
        },
      });
      for (const change of [
        {
          apply: t =>
            t.client.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
              w.membershipId,
            ]),
          undo: () =>
            f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=NULL WHERE id=$1`, [
              w.membershipId,
            ]),
          error: AccessDenied,
        },
        {
          apply: t =>
            t.client.query(`UPDATE ${f.table('tf_conversation_turns')} SET attempt_epoch=2 WHERE id=$1`, [
              current.input.turnId,
            ]),
          undo: () =>
            f.db.platform.query(`UPDATE ${f.table('tf_conversation_turns')} SET attempt_epoch=1 WHERE id=$1`, [
              current.input.turnId,
            ]),
          error: /stale/,
        },
        {
          apply: t =>
            t.client.query(
              `UPDATE ${f.table('tf_execution_consents')} SET revoked_at=clock_timestamp() WHERE area_id=$1`,
              [current.area.id],
            ),
          undo: () =>
            f.db.platform.query(`UPDATE ${f.table('tf_execution_consents')} SET revoked_at=NULL WHERE area_id=$1`, [
              current.area.id,
            ]),
          error: /consent-required/,
        },
        {
          apply: t =>
            t.client.query(`UPDATE ${f.table('tf_execution_areas')} SET generation=generation+1 WHERE id=$1`, [
              current.area.id,
            ]),
          undo: () =>
            f.db.platform.query(`UPDATE ${f.table('tf_execution_areas')} SET generation=$2 WHERE id=$1`, [
              current.area.id,
              current.area.generation,
            ]),
          error: /stale/,
        },
      ]) {
        try {
          await assert.rejects(capture(duringRead(change.apply)), change.error);
          assert.equal((await tx(t => readJob(t, current.area.id, current.job.id))).output_cursor, 0);
        } finally {
          await change.undo();
        }
      }
      await assert.rejects(
        capture(
          duringRead(t =>
            t.client.query(
              `UPDATE ${f.table('tf_execution_outbox')} SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,
              [current.intent.id],
            ),
          ),
        ),
        /stale/,
      );
      const expired = current.intent;
      current.intent = await tx(t => claimIntent(t, 60));
      assert.equal(current.intent.id, expired.id);
      assert.notEqual(current.intent.lease_id, expired.lease_id);
      const backend = {
        descriptor,
        async *readOutput() {
          yield event;
          yield { kind: 'end', sequence: 2 };
        },
      };
      await assert.rejects(capture(backend, { intent: expired }), /stale/);
      const abort = new AbortController();
      await assert.rejects(
        capture(
          duringRead(async () => abort.abort()),
          { signal: abort.signal },
        ),
        {
          name: 'AbortError',
        },
      );
      assert.equal((await service.output(w.id, w.userId, current.chatId, current.job.id)).after, 0);
      assert.deepEqual(await capture(backend), { after: 2, bytes: 2, truncated: false, complete: true });
      await tx(t => finishIntent(t, current.intent));
    });

    await t.test('consent is chat-scoped, revocable and bound to the configuration shown', async () => {
      const id = await chat(false);
      const status = await service.status(w.id, w.userId, id);
      const input = await request(id);
      await assert.rejects(service.enqueue(w.id, w.userId, id, input), /Resource not found/);
      await assert.rejects(
        service.grant(w.id, w.userId, id, { profileId: 'small', scopeRevision: 'b'.repeat(64) }),
        /stale/,
      );
      await service.grant(w.id, w.userId, id, { profileId: 'small', scopeRevision: status.scopeRevision });
      assert.equal((await service.status(w.id, w.userId, id)).consentRequired, false);
      const changed = createChatExecution(f.runtime, { ...configuration, policyRevision: 'b'.repeat(64) }, descriptor);
      assert.equal((await changed.status(w.id, w.userId, id)).consentRequired, true);
      await assert.rejects(changed.enqueue(w.id, w.userId, id, input), /consent-required/);
      await service.revoke(w.id, w.userId, id);
      assert.equal((await service.status(w.id, w.userId, id)).consentRequired, true);
      await assert.rejects(service.enqueue(w.id, w.userId, id, input), /consent-required/);
    });

    await t.test(
      'stable jobs reject changed input and stale turns; other chats and people cannot read them',
      async () => {
        const id = await chat(),
          other = await chat(),
          input = await request(id);
        await assert.rejects(service.enqueue(w.id, w.userId, id, { ...input, turnEpoch: 0 }), /stale/);
        const job = await service.enqueue(w.id, w.userId, id, input);
        assert.equal((await service.enqueue(w.id, w.userId, id, input)).id, job.id);
        await assert.rejects(
          service.enqueue(w.id, w.userId, id, { ...input, command: { program: 'node', args: ['-v'] } }),
          /request-conflict/,
        );
        await assert.rejects(service.job(w.id, w.userId, other, job.id), /not-found/);
        await assert.rejects(service.job(w.id, randomUUID(), id, job.id), /Resource not found/);
        await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
          w.membershipId,
        ]);
        try {
          await assert.rejects(service.job(w.id, w.userId, id, job.id), /Resource not found/);
        } finally {
          await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=NULL WHERE id=$1`, [
            w.membershipId,
          ]);
        }
      },
    );

    await t.test('Stop handles execution-waiting turns and deletion leaves durable cleanup intent', async () => {
      const id = await chat(),
        input = await request(id);
      const job = await service.enqueue(w.id, w.userId, id, input);
      await f.db.platform.query(
        `UPDATE ${f.table('tf_conversation_turns')} SET status='waiting',lease_until=NULL WHERE id=$1`,
        [input.turnId],
      );
      await f.store.cancel(w.id, w.userId, id, input.turnId, { commandId: randomUUID(), expectedGeneration: 0 });
      assert.equal((await service.job(w.id, w.userId, id, job.id)).state, 'cancelled');
      await f.store.remove(w.id, w.userId, id, { commandId: randomUUID() });
      await assert.rejects(service.job(w.id, w.userId, id, job.id), /Resource not found/);
      const area = await tx(client => findArea(client, id));
      assert.equal(area.state, 'deleting');
      assert.equal(
        (
          await f.db.platform.query(
            `SELECT count(*)::integer AS n FROM ${f.table('tf_execution_outbox')} WHERE area_id=$1 AND operation='cleanup'`,
            [area.id],
          )
        ).rows[0].n,
        1,
      );
    });

    await t.test('expired outbox claims cannot acknowledge a replacement lease', async () => {
      const claim = await tx(client => claimIntent(client, 30));
      assert.ok(claim);
      await f.db.platform.query(
        `UPDATE ${f.table('tf_execution_outbox')} SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,
        [claim.id],
      );
      const next = await tx(client => claimIntent(client, 30));
      assert.equal(next.id, claim.id);
      assert.notEqual(next.lease_id, claim.lease_id);
      await assert.rejects(
        tx(client => finishIntent(client, claim)),
        /stale/,
      );
      await tx(client => finishIntent(client, next));
    });

    await t.test('allocations keep runner affinity and a confirmed stop fences the old writer', async () => {
      const id = await chat(),
        runner = randomUUID();
      const area = await tx(client => findArea(client, id));
      const deadline = new Date(Date.now() + 30000).toISOString();
      const allocation = await tx(client => reserveAllocation(client, area, runner, deadline));
      assert.equal((await tx(client => reserveAllocation(client, area, runner, deadline))).id, allocation.id);
      await assert.rejects(
        tx(client => reserveAllocation(client, area, randomUUID(), deadline)),
        /stale/,
      );
      const stopping = await tx(client => transitionAllocation(client, allocation, 'stopping'));
      await tx(client => transitionAllocation(client, stopping, 'stopped'));
      const input = await request(id);
      await service.enqueue(w.id, w.userId, id, input);
      const current = await tx(client => findArea(client, id));
      assert.equal(current.generation, area.generation + 1);
      await assert.rejects(
        tx(client => requireGeneration(client, area.id, area.generation)),
        /stale/,
      );
    });

    await t.test('manifest replacement is fenced, paged, and readable with execution off', async () => {
      const id = await chat();
      const area = await tx(client => findArea(client, id));
      const file = {
        path: 'answer.txt',
        size: 4,
        sha256: createHash('sha256').update('test').digest('hex'),
        executable: false,
        objectId: randomUUID(),
        sources: [],
      };
      const commit = (parent, files) =>
        tx(async client => {
          await lockExecutionStorage(client);
          return commitManifest(client, area, parent, files, policy.limits);
        });
      await assert.rejects(commit(null, [file, file]), /request-conflict/);
      await assert.rejects(commit(null, [{ ...file, size: policy.limits.fileBytes + 1 }]), /quota/);
      const upload = await tx(async client => {
        await lockExecutionStorage(client);
        return reserveUpload(
          client,
          area,
          {
            path: file.path,
            size: file.size,
            sha256: file.sha256,
            executable: file.executable,
          },
          file.sources,
          policy.limits,
        );
      });
      const data = new Map();
      const bytes = {
        putIfAbsent: async (key, value) => {
          if (!data.has(key)) data.set(key, Buffer.from(value));
        },
        read: async key => data.get(key),
        remove: async key => {
          data.delete(key);
        },
      };
      const reference = {
        workspaceId: w.id,
        areaId: area.id,
        objectId: upload.objectId,
        size: file.size,
        sha256: file.sha256,
      };
      const chunks = await writeExecutionObject(
        bytes,
        reference,
        (async function* () {
          yield Buffer.from('test');
        })(),
        new AbortController().signal,
      );
      await tx(client => finishUpload(client, area, upload.objectId, chunks));
      const manifest = await commit(null, [upload]);
      const stored = await tx(client => readObject(client, area.id, upload.objectId));
      let output = '',
        checks = 0;
      for await (const chunk of readExecutionObject(
        bytes,
        reference,
        stored.chunks,
        async () => {
          checks++;
        },
        new AbortController().signal,
      ))
        output += Buffer.from(chunk).toString();
      assert.equal(output, 'test');
      assert.ok(checks > 0);
      await assert.rejects(commit(null, []), /stale/);
      const off = createChatExecution(f.runtime, { mode: 'off' });
      const listed = await off.files(w.id, w.userId, id);
      assert.deepEqual(listed.files, [{ path: file.path, size: 4, sha256: file.sha256, executable: false }]);
      assert.equal('objectId' in listed.files[0], false);
      const other = await chat();
      assert.deepEqual((await off.files(w.id, w.userId, other)).files, []);
      await commit(manifest.id, []);
      assert.deepEqual((await off.files(w.id, w.userId, id)).files, []);
    });

    await t.test(
      'saved downloads recheck chat access around each storage read and fence replaced manifests',
      async () => {
        const id = await chat();
        const area = await tx(client => findArea(client, id));
        const contents = Buffer.alloc(executionChunkBytes + 7, 'a');
        const file = {
          path: 'download.bin',
          size: contents.length,
          sha256: createHash('sha256').update(contents).digest('hex'),
          executable: false,
        };
        const limits = {
          ...policy.limits,
          fileBytes: 2 * executionChunkBytes,
          workspaceStorageBytes: 4 * executionChunkBytes,
        };
        const upload = await tx(async client => {
          await lockExecutionStorage(client);
          return reserveUpload(client, area, file, [], limits);
        });
        const data = new Map();
        let onRead;
        const bytes = {
          putIfAbsent: async (key, value) => {
            if (!data.has(key)) data.set(key, Buffer.from(value));
          },
          read: async key => {
            const value = data.get(key);
            await onRead?.();
            return value;
          },
          remove: async key => {
            data.delete(key);
          },
        };
        const signal = new AbortController().signal;
        const chunks = await writeExecutionObject(
          bytes,
          { workspaceId: w.id, areaId: area.id, objectId: upload.objectId, size: file.size, sha256: file.sha256 },
          (async function* () {
            yield contents;
          })(),
          signal,
        );
        await tx(client => finishUpload(client, area, upload.objectId, chunks));
        const commit = (parent, files) =>
          tx(async client => {
            await lockExecutionStorage(client);
            return commitManifest(client, area, parent, files, limits);
          });
        const manifest = await commit(null, [upload]);
        const off = createChatExecution(f.runtime, { mode: 'off' }, undefined, bytes);
        const listed = await off.files(w.id, w.userId, id);
        assert.equal(listed.manifestId, manifest.id);
        const input = { manifestId: listed.manifestId, path: file.path };
        const download = () => off.download(w.id, w.userId, id, input, signal);
        const first = await download();
        assert.deepEqual(first.file, file);
        assert.deepEqual(Buffer.concat(await Array.fromAsync(first.bytes)), contents);
        await assert.rejects(off.download(w.id, randomUUID(), id, input, signal), AccessDenied);
        await assert.rejects(off.download(w.id, w.userId, await chat(), input, signal), /stale/);
        await assert.rejects(off.download(w.id, w.userId, id, { ...input, path: 'absent.bin' }, signal), /not-found/);

        const membership = removed =>
          f.db.platform.query(
            `UPDATE ${f.table('tf_memberships')} SET removed_at=CASE WHEN $2 THEN clock_timestamp() ELSE NULL END WHERE id=$1`,
            [w.membershipId, removed],
          );
        try {
          const stream = (await download()).bytes[Symbol.asyncIterator]();
          assert.equal((await stream.next()).value.length, executionChunkBytes);
          await membership(true);
          await assert.rejects(stream.next(), AccessDenied);
        } finally {
          await membership(false);
        }
        try {
          const stream = (await download()).bytes[Symbol.asyncIterator]();
          onRead = () => membership(true);
          await assert.rejects(stream.next(), AccessDenied);
        } finally {
          onRead = undefined;
          await membership(false);
        }
        const outdated = await download();
        await commit(manifest.id, []);
        await assert.rejects(Array.fromAsync(outdated.bytes), /stale/);
      },
    );

    await t.test('output replay is immutable, bounded, paged and readable with execution off', async () => {
      const id = await chat();
      const accepted = await service.enqueue(w.id, w.userId, id, await request(id));
      const area = await tx(client => findArea(client, id));
      const events = Array.from({ length: 65 }, (_, index) => ({
        kind: 'chunk',
        sequence: index + 1,
        stream: index % 2 ? 'stderr' : 'stdout',
        data: Buffer.from([index, 0, 255]).toString('base64'),
      }));
      const append = (values, limits = policy.limits) =>
        tx(client => appendOutput(client, area, accepted.id, values, limits));
      await assert.rejects(append(events.slice(0, 1)), /request-conflict/);
      const allocation = await tx(client =>
        reserveAllocation(client, area, randomUUID(), new Date(Date.now() + 30000).toISOString()),
      );
      const ready = await tx(client => transitionAllocation(client, allocation, 'ready'));
      await tx(client => beginJob(client, area, accepted.id, ready, policy));
      const first = await append(events.slice(0, 64));
      assert.deepEqual(first, { cursor: 64, bytes: 192, truncated: false, complete: false });
      assert.deepEqual(await append(events.slice(0, 64)), first);
      await assert.rejects(
        append([{ ...events[0], data: Buffer.from('changed').toString('base64') }]),
        /request-conflict/,
      );
      await assert.rejects(append([{ kind: 'end', sequence: 66 }]), /request-conflict/);
      await assert.rejects(append([events[64]], { ...policy.limits, outputBytes: first.bytes }), /quota/);
      await tx(client => observeJob(client, area, accepted.id, { state: 'running' }));
      const truncated = { kind: 'truncated', sequence: 66 };
      assert.deepEqual(await append([events[64], truncated]), {
        cursor: 66,
        bytes: 195,
        truncated: true,
        complete: false,
      });
      await assert.rejects(append([{ ...events[0], sequence: 67 }]), /request-conflict/);
      const end = { kind: 'end', sequence: 67 };
      const final = await append([end]);
      assert.equal(final.complete, true);
      assert.deepEqual(await append([end]), final);
      await assert.rejects(append([{ ...events[0], sequence: 68 }]), /request-conflict/);

      const runtime = f.createRuntime();
      try {
        const off = createChatExecution(runtime, { mode: 'off' });
        const firstPage = await off.output(w.id, w.userId, id, accepted.id);
        assert.deepEqual(firstPage, { events: events.slice(0, 64), after: 64, complete: false });
        const lastPage = await off.output(w.id, w.userId, id, accepted.id, firstPage.after);
        assert.deepEqual(lastPage, { events: [events[64], truncated, end], after: 67, complete: true });
        assert.deepEqual(
          Buffer.concat(
            [...firstPage.events, ...lastPage.events]
              .filter(event => event.kind === 'chunk')
              .map(event => Buffer.from(event.data, 'base64')),
          ),
          Buffer.from(Array.from({ length: 65 }, (_, index) => [index, 0, 255]).flat()),
        );
        await assert.rejects(off.output(w.id, w.userId, id, accepted.id, 68), /request-conflict/);
        await assert.rejects(off.output(w.id, w.userId, await chat(), accepted.id), /not-found/);
        await assert.rejects(off.output(w.id, randomUUID(), id, accepted.id), AccessDenied);
        await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
          w.membershipId,
        ]);
        try {
          await assert.rejects(off.output(w.id, w.userId, id, accepted.id), AccessDenied);
        } finally {
          await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=NULL WHERE id=$1`, [
            w.membershipId,
          ]);
        }
      } finally {
        await runtime.close();
      }
    });

    await t.test(
      'a durable start runs once, unknown outcomes cannot relaunch, and completion waits for a new save',
      async () => {
        const id = await chat(),
          input = await request(id);
        const accepted = await service.enqueue(w.id, w.userId, id, input);
        const area = await tx(client => findArea(client, id));
        const allocation = await tx(client =>
          reserveAllocation(client, area, randomUUID(), new Date(Date.now() + 30000).toISOString()),
        );
        const ready = await tx(client => transitionAllocation(client, allocation, 'ready'));
        const started = await tx(client => beginJob(client, area, accepted.id, ready, policy));
        assert.equal(started.launch, true);
        assert.equal((await tx(client => beginJob(client, area, accepted.id, ready, policy))).launch, false);
        await tx(client => observeJob(client, area, accepted.id, { state: 'outcome-unknown' }));
        assert.equal((await tx(client => beginJob(client, area, accepted.id, ready, policy))).launch, false);
        const save = parent =>
          tx(async client => {
            await lockExecutionStorage(client);
            return commitManifest(client, area, parent, [], policy.limits);
          });
        const early = await save(null);
        await tx(client => observeJob(client, area, accepted.id, { state: 'completed', exitCode: 0 }));
        assert.equal((await service.job(w.id, w.userId, id, accepted.id)).state, 'saving');
        await assert.rejects(
          tx(client => finishSavedJob(client, area, accepted.id, early.id)),
          /busy/,
        );
        await tx(client => appendOutput(client, area, accepted.id, [{ kind: 'end', sequence: 1 }], policy.limits));
        await assert.rejects(
          tx(client => finishSavedJob(client, area, accepted.id, early.id)),
          /stale/,
        );
        const saved = await save(early.id);
        const finished = await tx(client => finishSavedJob(client, area, accepted.id, saved.id));
        assert.equal(finished.state, 'completed');
        assert.equal(finished.file_save.state, 'complete');
        assert.equal(finished.file_save.manifestId, saved.id);
      },
    );

    await t.test('forced stops retain only the last committed save after confirmed allocation shutdown', async () => {
      for (const outcome of ['cancelled', 'timed-out']) {
        for (const savedBeforeStop of [true, false]) {
          const id = await chat();
          const accepted = await service.enqueue(w.id, w.userId, id, await request(id));
          const area = await tx(client => findArea(client, id));
          const allocation = await tx(client =>
            reserveAllocation(client, area, randomUUID(), new Date(Date.now() + 30000).toISOString()),
          );
          const ready = await tx(client => transitionAllocation(client, allocation, 'ready'));
          await tx(client => beginJob(client, area, accepted.id, ready, policy));
          const saved = savedBeforeStop
            ? await tx(async client => {
                await lockExecutionStorage(client);
                return commitManifest(client, area, null, [], policy.limits);
              })
            : null;
          await tx(client => observeJob(client, area, accepted.id, { state: 'outcome-unknown' }));
          await assert.rejects(
            tx(client => finishInterruptedJob(client, area, accepted.id)),
            /request-conflict/,
          );
          await tx(client => observeJob(client, area, accepted.id, { state: outcome }));
          await assert.rejects(
            tx(client => finishInterruptedJob(client, area, accepted.id)),
            /busy/,
          );
          const stopping = await tx(client => transitionAllocation(client, ready, 'stopping'));
          await assert.rejects(
            tx(client => finishInterruptedJob(client, area, accepted.id)),
            /busy/,
          );
          await tx(client => transitionAllocation(client, stopping, 'stopped'));
          await assert.rejects(
            tx(client => finishInterruptedJob(client, { ...area, generation: area.generation + 1 }, accepted.id)),
            /stale/,
          );
          const finished = await tx(client => finishInterruptedJob(client, area, accepted.id));
          assert.equal(finished.state, outcome);
          assert.equal(finished.output_complete, false);
          assert.equal(finished.file_save.state, 'partial');
          assert.equal(finished.file_save.manifestId, saved?.id ?? null);
          assert.equal(finished.file_save.savedAt !== null, savedBeforeStop);
          assert.equal((await tx(client => findArea(client, id))).manifest_id, saved?.id ?? null);
          assert.deepEqual(
            (await tx(client => finishInterruptedJob(client, area, accepted.id))).file_save,
            finished.file_save,
          );
          const counts = await f.db.platform.query(
            `SELECT (SELECT count(*)::integer FROM ${f.table('tf_execution_manifests')} WHERE area_id=$1) AS manifests,
              (SELECT count(*)::integer FROM ${f.table('tf_execution_outbox')} WHERE job_id=$2 AND operation='resume') AS resumes`,
            [area.id, accepted.id],
          );
          assert.deepEqual(counts.rows[0], { manifests: savedBeforeStop ? 1 : 0, resumes: 1 });
          assert.deepEqual((await service.job(w.id, w.userId, id, accepted.id)).fileSave, finished.file_save);
        }
      }
    });

    await t.test('workspace database credentials cannot read another workspace execution tables', async () => {
      const other = await f.db.create();
      const client = await connect(f.db.login(other));
      try {
        await denied(client, `SELECT * FROM ${f.table('tf_execution_jobs')}`);
        await denied(client, `SELECT * FROM ${f.table('tf_execution_manifest_files')}`);
      } finally {
        await client.end();
      }
    });
  } finally {
    await f.close();
  }
});
