import assert from 'node:assert/strict';
import { githubChatFixture } from './github-read-fixture.mjs';
import { projectProviderFixture } from '../../../packages/github/test/project-provider-fixture.mjs';
import { createGitHubAccounts } from '@tulipfarm/github';
import { createGitHubBatches } from '@tulipfarm/github/batches';
import { createGitHubBatchDecision } from '@tulipfarm/github/batch-approval';
import { requireDraftSources } from '@tulipfarm/agents/draft-sources';

export async function githubProjectFixture(configuration) {
  const nativeFetch = globalThis.fetch,
    f = await githubChatFixture({ ...configuration, scopes: ['repo', 'read:user', 'project'] });
  const accountId = await f.connect(123);
  let chatId = await f.chat();
  await f.reads.select(f.one.id, f.member.userId, chatId, { accountId, expectedVersion: 0 });
  const provider = await projectProviderFixture(nativeFetch);
  f.setProvider(provider.fetcher);
  const accounts = createGitHubAccounts({ runtime: f.runtime, configuration: f.configuration, keyring: f.keyring });
  const options = { runtime: f.runtime, accounts, requireSources: requireDraftSources };
  const batches = createGitHubBatches(options),
    decide = createGitHubBatchDecision({
      ...options,
      resolveConfirmationCredential: async () => f.db.login(f.one, 'confirmation'),
    });
  const args = batch => [f.one.id, f.member.userId, chatId, batch.snapshot.id];
  return {
    ...f,
    ...provider,
    accountId,
    chatId,
    options,
    batches,
    async freshChat() {
      chatId = await f.chat();
      await f.reads.select(f.one.id, f.member.userId, chatId, { accountId, expectedVersion: 0 });
      this.chatId = chatId;
    },
    async propose(actions, sources = []) {
      f.decide(
        [
          ...sources.map(operation => ({ tool: 'github.personal.read', operation })),
          { tool: 'github.personal.propose', actions },
        ],
        'Review the exact Projects changes.',
      );
      assert.equal((await f.send(chatId, `Prepare Projects ${Date.now()}.`)).status, 'completed');
      const batch = (await batches.list(f.one.id, f.member.userId, chatId)).batches[0];
      assert.ok(batch?.snapshot);
      return batch;
    },
    approve: batch => decide(...args(batch), { digest: batch.digest, decision: 'approve' }),
    reject: batch => decide(...args(batch), { digest: batch.digest, decision: 'reject' }),
    execute: batch => batches.execute(...args(batch)),
    read: batch => batches.read(...args(batch)),
    status: batch => batches.status(...args(batch)),
    reconcile: batch => batches.reconcile(...args(batch)),
    reconcileStatus: batch => batches.reconcileStatus(...args(batch)),
    async worker(batch) {
      f.decide(
        [{ tool: 'github.personal.execute', batchId: batch.snapshot.id }],
        'Checked the approved Projects changes.',
      );
      return f.send(chatId, `Execute Projects ${Date.now()}.`);
    },
    async close() {
      await provider.close();
      await f.close();
    },
  };
}
