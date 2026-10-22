import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { taskPrerequisites } from './verification-preflight.mjs';

await taskPrerequisites(process.env, true);
const listener = createServer();
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const temporal = spawn(
  process.env.TEMPORAL_BINARY,
  ['server', 'start-dev', '--headless', '--ip', '127.0.0.1', '--port', String(port)],
  { stdio: 'ignore' },
);
try {
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const socket = createConnection({ host: '127.0.0.1', port });
        socket.once('connect', () => {
          socket.destroy();
          resolve();
        });
        socket.once('error', reject);
      });
      break;
    } catch (error) {
      if (attempt >= 100 || temporal.exitCode !== null) throw error;
      await delay(100);
    }
  }
  const tests = process.argv.slice(2);
  const child = spawn(
    process.execPath,
    [
      'tooling/verify-agent-task-foundation.mjs',
      ...(tests.length ? tests : ['apps/web/test/task-journey-live.browser.mjs']),
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, TASK_TEST_TEMPORAL_ADDRESS: `127.0.0.1:${port}` },
    },
  );
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, 'Task journey proof failed');
} finally {
  if (temporal.exitCode === null) {
    const stopped = once(temporal, 'exit');
    temporal.kill('SIGTERM');
    await stopped;
  }
}
