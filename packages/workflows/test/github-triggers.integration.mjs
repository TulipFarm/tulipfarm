import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { createWorkflows } from '../src/service.ts';
import { createGitHubSubscriptions, createGitHubWorkflowFanOut } from '../src/github-triggers.ts';
import { activate } from './commands.fixture.mjs';

const migration = name => readFile(new URL(`../../../apps/database/migrations/${name}`, import.meta.url), 'utf8');

test(
  'a GitHub trigger subscribes on activation, starts runs from matching deliveries and unsubscribes on disable',
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    let runtime;
    try {
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await migration('0001_baseline.sql')}
${await migration('0008_github_workflow_subscriptions.sql')}`);
      const w = await db.create(await workspaceTableMigrations());
      const table = name => qualified(w.names.schema, name);
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      const service = createWorkflows(runtime, { githubSubscriptions: createGitHubSubscriptions(db.platform) });
      const fanOut = createGitHubWorkflowFanOut(db.platform, runtime);
      const id = randomUUID(),
        revision = randomUUID();
      const definition = {
        version: 1,
        name: 'Stars',
        trigger: { kind: 'github', repositoryId: '42', event: 'star', actions: ['created'] },
        steps: [{ id: 'copy', kind: 'transform', fields: { login: { kind: 'input', path: ['sender'] } } }],
      };
      const star = (deliveryId, action = 'created', login = 'octocat') =>
        fanOut({
          event: 'star',
          deliveryId,
          body: { action, repository: { id: 42, full_name: 'acme/app' }, sender: { login } },
        });
      const subscriptions = async () =>
        (
          await db.platform.query(
            'SELECT repository_id,event,actions FROM app.github_workflow_subscriptions WHERE workflow_id=$1',
            [id],
          )
        ).rows;
      const events = async () =>
        (
          await db.platform.query(
            `SELECT event_key,payload->>'sender' AS sender FROM ${table('tf_provider_events')} WHERE workflow_id=$1 ORDER BY event_key`,
            [id],
          )
        ).rows;

      await assert.rejects(
        service.save(w.id, w.userId, id, { revision, expectedRevision: null, definition }),
        /github-repository-not-connected/,
        'a repository the user has not connected in Knowledge cannot be named',
      );
      const source = randomUUID();
      await db.platform.query(
        `INSERT INTO ${table('tf_knowledge_sources')} (id,provider,account_namespace,selection,owner_membership_id) VALUES ($1,'github','acme','repos',$2)`,
        [source, w.membershipId],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_knowledge_github_sources')} (source_id,binding,selection,title,fingerprint,cursor) VALUES ($1,'{}','{}','Acme','f','{}')`,
        [source],
      );
      await db.platform.query(`INSERT INTO ${table('tf_knowledge_github_members')} VALUES ($1,$2)`, [
        source,
        w.membershipId,
      ]);
      await db.platform.query(
        `INSERT INTO ${table('tf_knowledge_github_repositories')} (source_id,repository_id,full_name,visibility,title) VALUES ($1,'42','acme/app','public','App')`,
        [source],
      );
      assert.deepEqual(await service.githubRepositories(w.id, w.userId), [
        { repositoryId: '42', fullName: 'acme/app' },
      ]);

      await service.save(w.id, w.userId, id, { revision, expectedRevision: null, definition });
      await service.sponsorship(w.id, w.userId, id, {
        sponsorMembershipId: w.membershipId,
        historyAudience: [w.membershipId],
      });
      await activate(service, w.id, w.userId, id, revision, true);
      assert.deepEqual(await subscriptions(), [{ repository_id: '42', event: 'star', actions: ['created'] }]);

      await star('d-deleted', 'deleted');
      await fanOut({ event: 'watch', deliveryId: 'd-watch', body: { action: 'started', repository: { id: 42 } } });
      await fanOut({
        event: 'star',
        deliveryId: 'd-other-repo',
        body: { action: 'created', repository: { id: 7 }, sender: { login: 'x' } },
      });
      assert.deepEqual(await events(), [], 'another action, event or repository does not reach the workflow');
      await star('d-1');
      await star('d-1');
      assert.deepEqual(await events(), [{ event_key: 'd-1', sender: 'octocat' }], 'a redelivery is queued once');
      await service.due(w.id);
      assert.deepEqual(
        (await service.history(w.id, w.userId, id).then(page => page.runs)).map(run => run.input.sender),
        ['octocat'],
      );

      await activate(service, w.id, w.userId, id, revision, false);
      for (let tries = 0; (await subscriptions()).length && tries < 50; tries++) await sleep(20);
      assert.deepEqual(await subscriptions(), [], 'disabling removes the subscription');
    } finally {
      await runtime?.close();
      await db.close();
    }
  },
);
