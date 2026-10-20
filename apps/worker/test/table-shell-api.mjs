import { getWorkspace, listWorkspaces } from '@tulipfarm/workspaces/store';
import { registerGovernance } from '../../api/dist/governance.js';
import { registerCredits } from '../../api/dist/credits.js';
import { registerModelCatalog } from '../../api/dist/model-catalog.js';
import { registerGoogleOperations } from '../../api/dist/google-operations.js';
import { createGoogleWorkspaceService } from '@tulipfarm/google-workspace';
import { createGoogleOperations } from '@tulipfarm/google-workspace/operations';
import { createGoogleApproval } from '@tulipfarm/google-workspace/operation-approval';
import { registerGitHubAccounts } from '../../api/dist/github-accounts.js';
import { createGitHubAccounts } from '@tulipfarm/github';
import { createGitHubReads } from '@tulipfarm/github/reads';
import { createGitHubBatches } from '@tulipfarm/github/batches';
import { createGitHubBatchDecision } from '@tulipfarm/github/batch-approval';
import { requireDraftSources } from '@tulipfarm/agents/draft-sources';
import { registerGitHubBatches } from '../../api/dist/github-batches.js';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

export async function registerTableShellApi({ app, auth, pool, runtime, db, ws, workspaceId, userId, soulCommit }) {
  await db.platform.query(
    "UPDATE app.workspaces SET name='Acceptance support',slug='acceptance',created_by=$2,soul_commit=$3,soul_bucket='local-fixture',soul_key='unused',ready_at=clock_timestamp() WHERE id=$1",
    [workspaceId, userId, soulCommit],
  );
  app.get('/auth/get-session', async (request, reply) => {
    const session = await auth.api.getSession({ headers: new Headers(request.headers) });
    reply.header('Cache-Control', 'no-store');
    return session;
  });
  const store = { pool, runtime };
  app.get('/workspaces', async (request, reply) => {
    const session = await auth.api.getSession({ headers: new Headers(request.headers) });
    if (!session) return reply.code(401).send({ error: 'sign-in-required' });
    return listWorkspaces(store, session.user.id);
  });
  app.get('/workspaces/:slug', async (request, reply) => {
    const session = await auth.api.getSession({ headers: new Headers(request.headers) });
    if (!session) return reply.code(401).send({ error: 'sign-in-required' });
    return (
      (await getWorkspace(store, session.user.id, request.params.slug)) ??
      reply.code(404).send({ error: 'workspace-not-found' })
    );
  });
  registerGovernance(app, { auth, runtime, identity: pool, compatibility: commonCompatibility });
  registerCredits(app, { auth, runtime });
  registerModelCatalog(app, { auth, runtime, compatibility: commonCompatibility });
  const github = createGitHubAccounts({ runtime, configuration: null, keyring: null });
  registerGitHubAccounts(app, auth, github, createGitHubReads({ runtime, accounts: github }));
  const batchOptions = { runtime, accounts: github, requireSources: requireDraftSources };
  registerGitHubBatches(app, {
    auth,
    batches: createGitHubBatches(batchOptions),
    decide: createGitHubBatchDecision({
      ...batchOptions,
      resolveConfirmationCredential: async () => db.login(ws, 'confirmation'),
    }),
  });
  const integrations = createGoogleWorkspaceService({
    runtime,
    keyring: { activeKeyId: 'fixture', keys: { fixture: 'a'.repeat(64) } },
  });
  registerGoogleOperations(app, {
    auth,
    runtime,
    operations: createGoogleOperations({ runtime, integrations }),
    approve: createGoogleApproval({ runtime, resolveConfirmationCredential: async () => db.login(ws, 'confirmation') }),
  });
}
