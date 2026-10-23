import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(new URL('/app/package.json', import.meta.url));
const { workspaceTableMigrations } = await import(require.resolve('@tulipfarm/workspaces/table-migrations'));
const migrations = await workspaceTableMigrations();
assert.deepEqual(
  migrations.map(migration => migration.name),
  ['0001_baseline.sql', '0002_turn_trace.sql', '0003_chat_send_timing.sql', '0004_social.sql'],
);
if (process.argv[2] === 'api') {
  const { buildApp } = await import('/app/dist/app.js');
  assert.equal(typeof buildApp, 'function');
  await import('/app/dist/agents.js');
  await import('/app/dist/integrations.js');
} else if (process.argv[2] === 'worker') {
  await import('/app/dist/agent-composition.js');
  await import('/app/dist/table-authoring-composition.js');
} else {
  throw new Error('Select api or worker');
}
console.log(`PASS ${process.argv[2]} image contains the common migration baseline and composition imports.`);
