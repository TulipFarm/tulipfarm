import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { slackPrerequisites } from './verification-preflight.mjs';

await slackPrerequisites();
process.env.R2_SOUL_BUCKET = 'tulipfarm-cloud-soul-local';
const root = fileURLToPath(new URL('../', import.meta.url));
process.env.PLAYWRIGHT_MODULE ??= fileURLToPath(
  new URL('../apps/web/node_modules/playwright/index.mjs', import.meta.url),
);
process.env.WEB_ORIGIN = 'https://app.example.test';
process.env.BETTER_AUTH_URL = 'https://api.example.test';
const suites = [
  ['installation, identity, signed lifecycle', [1, 2, 11], ['--test', 'apps/api/test/slack-intake.integration.mjs']],
  [
    'rotation and reconnect races',
    [13],
    ['--test', 'packages/slack/test/recovery.integration.mjs', 'packages/slack/test/member-unlink.integration.mjs'],
  ],
  [
    'named agents, invocation, private threads',
    [3, 4, 5, 7, 9, 12, 13, 14, 15, 17],
    ['--test', 'packages/agents/test/slack-channels.integration.mjs'],
  ],
  [
    'general assistant and channel audience',
    [3, 6, 8, 9, 14, 15],
    ['--test', 'packages/agents/test/slack-safe-delivery.integration.mjs'],
  ],
  [
    'outbound, default DM, approvals, unknown effects',
    [4, 10, 16, 18],
    ['--test', 'apps/api/test/slack-actions.integration.mjs'],
  ],
  [
    'compiled prompt and DM workflows',
    [12, 13, 16],
    [
      '--test',
      '--test-name-pattern=compiled Slack|compiled direct|default DM|worker',
      'apps/worker/test/slack.integration.mjs',
      'apps/worker/test/slack-dm.integration.mjs',
      'apps/worker/test/slack-discovery.integration.mjs',
    ],
  ],
  [
    'Web API contract and rendering',
    [10, 15],
    ['--test', 'packages/slack/test/web-api.test.mjs', 'packages/slack-presentation/test/*.test.mjs'],
  ],
  [
    'browser approval, recovery and Temporal restart',
    [4, 13, 18],
    ['--test', '--test-name-pattern=composed browser', 'apps/web/test/slack-outbound-live.browser.mjs'],
  ],
  ['browser link states', [2, 13], ['apps/web/test/slack-link.browser.mjs']],
  ['browser create and attach', [5], ['apps/web/test/slack-create-live.browser.mjs']],
];
const covered = new Set();
for (const [name, decisions, args] of suites) {
  console.log(`\nAcceptance suite: ${name}. Decisions ${decisions.join(', ')}.`);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${name} failed with ${code ?? signal}`)),
    );
  });
  for (const decision of decisions) covered.add(decision);
}
assert.deepEqual(
  [...covered].sort((a, b) => a - b),
  Array.from({ length: 18 }, (_, index) => index + 1),
);
console.log(
  `PASS ${suites.length} distinct acceptance suites cover 18 decisions. This is local acceptance with synthetic Slack and model responses, not live-provider qualification. Imported test totals are not additional journeys.`,
);
