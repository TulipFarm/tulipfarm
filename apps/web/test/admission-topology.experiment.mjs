import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const latency = 150;
let failure = null;
const values = {
  session: { userId: 'fixture-user', sessionId: 'fixture-session' },
  workspace: { id: 'fixture-workspace', status: 'ready' },
  discovery: ['fixture-workspace'],
  membership: { membershipId: 'fixture-membership' },
};
const server = createServer(async (request, response) => {
  await delay(latency);
  const name = request.url.slice(1);
  if (name === 'bootstrap') {
    if (failure) {
      response.writeHead(failure.status).end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(values));
  } else if (Object.hasOwn(values, name)) {
    if (failure?.name === name) {
      response.writeHead(failure.status).end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(values[name]));
  } else response.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
async function read(name) {
  const response = await fetch(`${origin}/${name}`);
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}
async function existing() {
  const session = await read('session');
  const workspace = read('workspace');
  const membership = workspace.then(() => read('membership'));
  const discovery = read('discovery');
  const results = await Promise.allSettled([workspace, membership, discovery]);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return { session, workspace: results[0].value, membership: results[1].value, discovery: results[2].value };
}
try {
  const results = [];
  for (let run = 0; run < 5; run++) {
    const started = performance.now();
    assert.deepEqual(await existing(), values);
    const existingMs = Math.round(performance.now() - started);
    const combinedStarted = performance.now();
    assert.deepEqual(await read('bootstrap'), values);
    results.push({ run, existingMs, idealCombinedMs: Math.round(performance.now() - combinedStarted) });
  }
  for (const name of Object.keys(values)) {
    for (const status of [401, 403, 404, 503]) {
      failure = { name, status };
      await assert.rejects(existing(), { message: String(status) });
      await assert.rejects(read('bootstrap'), { message: String(status) });
    }
  }
  failure = null;
  assert.deepEqual(await existing(), values);
  assert.deepEqual(await read('bootstrap'), values);
  console.log(
    JSON.stringify(
      {
        method:
          'Local HTTP topology prototype. Each client round trip costs 150 ms. Server work is zero. Combined results are an optimistic latency bound, not an implemented endpoint or storage/authorization benchmark. Both variants fail closed on 16 injected failures and recover.',
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await new Promise(resolve => server.close(resolve));
}
