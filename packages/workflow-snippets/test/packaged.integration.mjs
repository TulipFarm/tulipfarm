import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { createSnippetClient } from '../src/client.ts';

test(
  'packaged broker serves actual isolated execution and production refuses local runtime overrides',
  { timeout: 60000, skip: !process.env.SNIPPET_BROKER_TEST_IMAGE },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'packaged-broker-')),
      name = `snippet-broker-proof-${randomUUID()}`;
    const token = randomBytes(32).toString('hex');
    await writeFile(join(directory, 'token'), token, { mode: 0o600 });
    const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000 }).trim();
    try {
      docker([
        'run',
        '-d',
        '--name',
        name,
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '-p',
        '127.0.0.1::8090',
        '-v',
        '/var/run/docker.sock:/var/run/docker.sock',
        '-v',
        `${directory}:/data`,
        '-e',
        'NODE_ENV=development',
        '-e',
        'SNIPPET_RUNTIME=runc',
        '-e',
        'SNIPPET_ALLOW_LOCAL_RUNC=true',
        '-e',
        `SNIPPET_IMAGE=${process.env.SNIPPET_TEST_IMAGE}`,
        '-e',
        'SNIPPET_BROKER_TOKEN_FILE=/data/token',
        process.env.SNIPPET_BROKER_TEST_IMAGE,
      ]);
      const port = JSON.parse(docker(['inspect', name]))[0].NetworkSettings.Ports['8090/tcp'][0].HostPort;
      const client = createSnippetClient({ url: `http://127.0.0.1:${port}`, token, allowLocalHttp: true });
      const job = {
        workspaceId: randomUUID(),
        runId: randomUUID(),
        revision: randomUUID(),
        stepId: 'python',
        language: 'python',
        source: 'return input + 1',
        input: 41,
      };
      let result;
      for (let i = 0; i < 100; i++) {
        try {
          result = await client.submit(job);
          if (result.kind !== 'pending') break;
        } catch {}
        await setTimeout(100);
      }
      assert.deepEqual(result, { kind: 'completed', output: 42 });
      const guard = `import {createSnippetRunner} from '@tulipfarm/workflow-snippets'; import assert from 'node:assert/strict'; assert.throws(()=>createSnippetRunner({image:'local@sha256:${'a'.repeat(64)}',runtime:'runc',allowLocalRunc:true}),/unavailable/); assert.throws(()=>createSnippetRunner({image:'sha256:${'a'.repeat(64)}'}),/unavailable/);`;
      docker([
        'run',
        '--rm',
        '--network=none',
        process.env.SNIPPET_BROKER_TEST_IMAGE,
        'node',
        '--input-type=module',
        '-e',
        guard,
      ]);
    } finally {
      docker(['rm', '-f', name]);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
