import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { promptFixture } from '../../../packages/slack/test/link-prompts.integration.mjs';
import {
  markWorkspaceReady,
  registerPlatformWorkspace,
} from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { createSlackInstallationDiscovery } from '../src/slack-installations.ts';

test('worker discovers installations beyond one page and rechecks readiness, app and disconnection', async () => {
  const f = await promptFixture();
  try {
    const workspaceIds = [...Array.from({ length: 101 }, () => randomUUID()), f.workspace.id].sort();
    for (const id of workspaceIds) await markWorkspaceReady(f.db.platform, id);
    const unavailable = randomUUID();
    await registerPlatformWorkspace(f.db.platform, unavailable);
    const discovery = createSlackInstallationDiscovery(f.db.platform, f.runtime, 'ATEST');
    assert.deepEqual(await discovery.next(), workspaceIds.slice(0, 100));
    assert.deepEqual(await discovery.next(), workspaceIds.slice(100));
    assert.deepEqual(await discovery.next(), workspaceIds.slice(0, 100));
    assert.equal(await discovery.installed(f.workspace.id), true);
    await discovery.requireInstalled(f.workspace.id);
    assert.equal(
      await createSlackInstallationDiscovery(f.db.platform, f.runtime, 'AOTHER').installed(f.workspace.id),
      false,
    );
    await assert.rejects(discovery.requireInstalled(unavailable), /slack-workspace-disabled/);
    await f.db.platform.query(`UPDATE ${f.table('tf_slack_installations')} SET state='revoked'`);
    assert.equal(await discovery.installed(f.workspace.id), false);
    await assert.rejects(discovery.requireInstalled(f.workspace.id), /slack-workspace-disabled/);
    await f.db.platform.query(`UPDATE ${f.table('tf_slack_installations')} SET state='active'`);
    await discovery.requireInstalled(f.workspace.id);
    await f.db.platform.query(
      "UPDATE app.workspace_storage SET stage='unavailable', disabled_at=now(), disabled_operation_id=gen_random_uuid() WHERE workspace_id=$1",
      [f.workspace.id],
    );
    await assert.rejects(discovery.requireInstalled(f.workspace.id), /slack-workspace-disabled/);
  } finally {
    await f.close();
  }
});
