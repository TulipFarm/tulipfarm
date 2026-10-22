import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const directory = resolve(process.env.MCP_EVIDENCE_DIRECTORY ?? '.audit/workspace-mcp');
await mkdir(directory, { recursive: true });
const checks = [
  ['aggregate', 'pnpm', ['check']],
  [
    'release-controls',
    'python3',
    ['-m', 'unittest', 'discover', '-s', 'infra/storage-release/tests', '-p', 'test_workspace_mcp.py', '-v'],
  ],
  [
    'first-party-mcp',
    'pnpm',
    [
      'exec',
      'turbo',
      'run',
      'test',
      '--filter=@tulipfarm/provider-mcp',
      '--filter=@tulipfarm/github',
      '--filter=@tulipfarm/atlassian',
      '--filter=@tulipfarm/google-workspace',
    ],
  ],
  [
    'restricted-domain-and-sources',
    'node',
    [
      '--test',
      '--test-concurrency=1',
      'packages/workspace-mcp/test/domain.integration.mjs',
      'packages/access/test/mcp-source.integration.mjs',
      'packages/agents/test/mcp-provenance.integration.mjs',
      'packages/agents/test/mcp-full-source.integration.mjs',
    ],
  ],
  [
    'api-and-activities',
    'node',
    [
      '--test',
      '--test-concurrency=1',
      'apps/api/test/workspace-mcp.integration.mjs',
      'apps/api/test/workspace-mcp-oauth.integration.mjs',
      'apps/api/test/workspace-mcp-recovery.integration.mjs',
      'apps/api/test/workspace-mcp-rollout.integration.mjs',
      'apps/worker/test/conversation-mcp-rollout.integration.mjs',
      'apps/worker/test/workspace-mcp-execution.integration.mjs',
    ],
  ],
  ['browser-recovery-states', 'node', ['apps/web/test/workspace-mcp.browser.mjs']],
  ['real-api-worker-browser', 'node', ['--test', 'apps/web/test/workspace-mcp-live.browser.mjs']],
];
const results = [];
await writeFile(resolve(directory, 'checks.json'), '[]\n');
for (const [name, command, args] of checks) {
  const started = new Date();
  const child = spawn(command, args, {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const limit = setTimeout(() => child.kill('SIGTERM'), 45 * 60 * 1000);
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', chunk => {
      output += chunk;
    });
  let startError = null;
  child.on('error', error => {
    startError = error.message;
  });
  const [code, signal] = await new Promise(resolve => child.once('close', (code, signal) => resolve([code, signal])));
  clearTimeout(limit);
  await writeFile(resolve(directory, `${name}.log`), output);
  results.push({
    name,
    command: [command, ...args],
    started: started.toISOString(),
    elapsedMs: Date.now() - started.getTime(),
    code,
    signal,
    startError,
    verdict: code === 0 && !startError ? 'PASS' : 'FAIL',
  });
  await writeFile(resolve(directory, 'checks.json'), `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results.at(-1)));
  if (code !== 0) {
    process.exitCode = 1;
    break;
  }
}
