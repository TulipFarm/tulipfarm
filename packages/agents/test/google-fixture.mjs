import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { googleFixture } from '../../google-workspace/test/fixture.mjs';
import { createGoogleWorkspaceService } from '@tulipfarm/google-workspace';
import { createGoogleOperations } from '@tulipfarm/google-workspace/operations';
import { createGoogleApproval } from '@tulipfarm/google-workspace/operation-approval';
import { createAgentAuthoring } from '../src/authoring.ts';
import { createAgentExecutor } from '../src/executor.ts';

export async function googleRuntimeFixture() {
  const f = await googleFixture();
  const calls = [];
  let failWrite = false;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    calls.push({ url: request.url, method: request.method, authorization: request.headers.authorization, body });
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST' && failWrite) {
      request.socket.destroy();
      return;
    }
    response.end(
      JSON.stringify(
        request.method === 'POST'
          ? { documentId: 'created-doc', title: 'Owner approved' }
          : { documentId: 'private-doc', title: 'Private document', body: { content: [] } },
      ),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const fetcher = (url, init) => {
    assert.equal(new URL(url).origin, 'https://docs.googleapis.com');
    return fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, init);
  };
  const factory = runtime =>
    createGoogleOperations({
      runtime,
      integrations: createGoogleWorkspaceService({ ...f.serviceOptions, runtime }),
      fetcher,
    });
  const approve = createGoogleApproval({
    runtime: f.runtime,
    resolveConfirmationCredential: async () => f.db.login(f.workspace, 'confirmation'),
  });
  const executor = createAgentExecutor({ runtime: f.runtime, google: factory });
  const integration = await f.connect();
  const teamId = randomUUID();
  await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'Google invokers')`, [teamId]);
  await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
    f.member.membershipId,
    teamId,
  ]);
  async function saveAgent(tools = ['google.read', 'google.propose', 'google.status', 'google.execute']) {
    const agentId = randomUUID();
    const commands = createAgentAuthoring(f.runtime);
    const head = 'a'.repeat(40);
    await f.db.platform.query(`UPDATE ${f.table('tf_soul_head')} SET revision=$1 WHERE id=1 AND revision IS NULL`, [
      head,
    ]);
    const parent = (await f.db.platform.query(`SELECT revision FROM ${f.table('tf_soul_head')} WHERE id=1`)).rows[0]
      .revision;
    const command = await commands.save(f.workspace.id, f.admin, agentId, {
      requestId: randomUUID(),
      expectedSoulRevision: parent,
      expectedSavedRevision: null,
      owningTeamId: null,
      definition: { name: 'Google assistant', instructions: 'Only use the owner integration.', tools },
    });
    const commit = createHash('sha1').update(command.commandId).digest('hex');
    const worker = commands.withWriter(async input => ({
      parentCommit: input.expectedParentCommit,
      commit,
      bundle: { key: 'synthetic-bundle', sha256: 'b'.repeat(64) },
      projection: {
        workspaceId: f.workspace.id,
        commit,
        kind: 'agent',
        id: agentId,
        path: `agents/${agentId}.json`,
        bucket: 'synthetic',
        key: 'synthetic-projection',
        sha256: createHash('sha256')
          .update(`${JSON.stringify(input.definition, null, 2)}\n`)
          .digest('hex'),
      },
    }));
    assert.equal((await worker.prepare(f.workspace.id, command.commandId)).status, 'accepted');
    const revision = (
      await f.db.platform.query(
        `SELECT definition_revision FROM ${f.table('tf_agent_saved_revisions')} WHERE agent_id=$1`,
        [agentId],
      )
    ).rows[0].definition_revision;
    const scope = [{ assetId: integration.integrationId, permissions: ['integration.read', 'integration.use'] }];
    // The fixture seeds enrollment because the admin creator does not manage the invoker team.
    await f.db.platform.query(`INSERT INTO ${f.table('tf_agent_teams')} (agent_id,team_id) VALUES ($1,$2)`, [
      agentId,
      teamId,
    ]);
    await executor.configure(f.workspace.id, f.admin, {
      agentId,
      version: 0,
      enabled: true,
      teamIds: [teamId],
      limits: scope,
    });
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_agent_grants')} (agent_id,team_id,permission) VALUES ($1,$2,'invoke')`,
      [agentId, teamId],
    );
    const activation = await executor.activate(f.workspace.id, f.admin, { agentId, revision, scope });
    return { agentId, scope, activationId: activation.activationId };
  }
  return {
    ...f,
    calls,
    fetcher,
    factory,
    approve,
    executor,
    integration,
    saveAgent,
    failWrite() {
      failWrite = true;
    },
    async close() {
      await new Promise(resolve => server.close(resolve));
      await f.close();
    },
  };
}
