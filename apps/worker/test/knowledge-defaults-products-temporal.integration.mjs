import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { NativeConnection } from '@temporalio/worker';
import { Client, Connection } from '@temporalio/client';
import { knowledgeEmbeddingProfile as profile } from '@tulipfarm/config';
import { createGoogleWorkspaceService } from '@tulipfarm/google-workspace';
import {
  createDefaultKnowledgeGate,
  defaultKnowledgeFlagEnabled,
  recordDefaultKnowledgeIntent,
} from '@tulipfarm/knowledge';
import { createGoogleKnowledgeWorker } from '../dist/knowledge-google-composition.js';
import { createSlackKnowledgeWorker } from '../dist/knowledge-slack-composition.js';
import { createAtlassianKnowledgeWorker } from '../dist/knowledge-atlassian-composition.js';
import { createGitHubKnowledgeWorker } from '../dist/knowledge-github-composition.js';
import { createKnowledgeEmbeddingWorker } from '../dist/knowledge-embedding-composition.js';
import { createDefaultKnowledgeWorker } from '../dist/knowledge-defaults-composition.js';
import { knowledgeFixture } from '../../api/test/knowledge-fixture.mjs';
import { googleProviderFixture, connectGoogle } from '../../api/test/knowledge-google-provider-fixture.mjs';
import { slackProviderFixture } from '../../api/test/knowledge-slack-provider-fixture.mjs';
import { atlassianProviderFixture } from '../../api/test/knowledge-atlassian-provider-fixture.mjs';
import { githubProviderFixture } from '../../api/test/knowledge-github-provider-fixture.mjs';

async function eventually(operation, message) {
  const until = Date.now() + 90000;
  while (Date.now() < until) {
    if (await operation()) return;
    await delay(100);
  }
  assert.fail(message);
}

const automatic = { enabled: defaultKnowledgeFlagEnabled, record: recordDefaultKnowledgeIntent };

/**
 * Runs one product family through real Temporal: the API sweep dispatches the intent, the defaults worker
 * configures sources, provider workers publish and the embedding worker settles credits. No HTTP read opens Knowledge.
 */
async function journey(name, setup, body) {
  const priorQueue = process.env.TEMPORAL_TASK_QUEUE;
  const queue = `default-products-${name}-${randomUUID()}`;
  process.env.TEMPORAL_TASK_QUEUE = queue;
  const env = {
    TEMPORAL_TASK_QUEUE: queue,
    KNOWLEDGE_EMBEDDINGS_ENABLED: 'true',
    AZURE_FOUNDRY_ENDPOINT: 'https://example.services.ai.azure.com/',
    AZURE_FOUNDRY_API_KEY: 'fixture-only',
  };
  const embeddingCalls = [];
  const embed = async input => {
    embeddingCalls.push(input);
    return {
      dispatch: 'dispatched',
      requestId: randomUUID(),
      inputTokensUpperBound: 1,
      usage: { kind: 'known', inputTokens: 1, totalTokens: 1, exceedsUpperBound: false },
      result: {
        kind: 'success',
        model: profile.model,
        vectors: [Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0))],
      },
    };
  };
  const workers = [];
  let f, connection, clientConnection;
  try {
    const address = process.env.TEST_TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
    connection = await NativeConnection.connect({ address });
    clientConnection = await Connection.connect({ address });
    const client = new Client({ connection: clientConnection });
    const temporal = { connection: clientConnection, client };
    const options = await setup.fixture({ temporal, embeddings: { env, provider: embed } });
    f = await knowledgeFixture(options);
    await f.db.platform.query(
      `UPDATE ${f.table('tf_credit_account')} SET available=10000000000000,granted=10000000000000`,
    );
    const gate = createDefaultKnowledgeGate({ runtime: f.runtime });
    const start = async worker => {
      workers.push({ worker, running: worker.worker.run() });
      return worker;
    };
    const stop = async worker => {
      const index = workers.findIndex(item => item.worker === worker);
      const [item] = workers.splice(index, 1);
      item.worker.worker.shutdown();
      await item.running;
    };
    const engine = await start(await setup.engine({ f, connection, env, gate }));
    await start(
      await createKnowledgeEmbeddingWorker({
        runtime: f.runtime,
        connection,
        env,
        pool: f.signed.identity,
        gate,
        [setup.kind]: engine.service,
        provider: embed,
      }),
    );
    const defaults = (engines = { [setup.kind]: engine.service }) =>
      createDefaultKnowledgeWorker({ runtime: f.runtime, connection, env, engines });
    const q = async (sql, values = []) =>
      (
        await f.db.platform.query(
          sql.replaceAll(/\btf_\w+/g, name => f.table(name)),
          values,
        )
      ).rows;
    await body({ f, q, env, engine, defaults, start, stop, embeddingCalls, client });
  } finally {
    await f?.app.close();
    for (const item of workers.reverse()) {
      item.worker.worker.shutdown();
      await item.running;
    }
    await f?.close();
    await setup.close?.();
    await connection?.close();
    await clientConnection?.close();
    if (priorQueue === undefined) delete process.env.TEMPORAL_TASK_QUEUE;
    else process.env.TEMPORAL_TASK_QUEUE = priorQueue;
  }
}

/** Every automatic source is owner-only, every document is lexically and vector published, and every ingestion credit attempt is settled against its source. */
async function published(q, kind, product) {
  const sources = await q(
    `SELECT s.source_id,ks.owner_membership_id FROM tf_knowledge_default_sources s JOIN tf_knowledge_default_intents i ON i.id=s.intent_id
    JOIN tf_knowledge_sources ks ON ks.id=s.source_id WHERE i.product=$1 AND s.state='created'`,
    [product],
  );
  if (!sources.length) return false;
  for (const source of sources) {
    const documents = await q(
      `SELECT lexical_publication_id,vector_publication_id FROM tf_knowledge_documents WHERE source_id=$1 AND tombstoned_at IS NULL`,
      [source.source_id],
    );
    if (!documents.length || documents.some(d => !d.lexical_publication_id || !d.vector_publication_id)) return false;
    const members = await q(`SELECT membership_id FROM tf_knowledge_${kind}_members WHERE source_id=$1`, [
      source.source_id,
    ]);
    assert.deepEqual(
      members.map(m => m.membership_id),
      [source.owner_membership_id],
      `${product} defaults to the connecting member only`,
    );
  }
  const ledger = await q(
    `SELECT attribution_id,state FROM tf_knowledge_credit_attempts WHERE purpose='ingestion' AND attribution_id=ANY($1::text[])`,
    [sources.map(s => s.source_id)],
  );
  return (
    ledger.length > 0 &&
    ledger.every(entry => entry.state === 'known') &&
    sources.every(s => ledger.some(entry => entry.attribution_id === s.source_id))
  );
}

/**
 * The account behind published automatic sources is reauthorized, so their old bindings fail. Automatic Retry through the API
 * must rebind the same sources to the current authorization; they publish again with no new source, credit attempt or paid call.
 */
async function recoversAfterReauthorization(
  { f, q, kind, products, embeddingCalls, fenced = true },
  reauthorize,
  current,
) {
  const ids = async () =>
    (
      await q(
        `SELECT s.source_id FROM tf_knowledge_default_sources s JOIN tf_knowledge_default_intents i ON i.id=s.intent_id
    WHERE i.product=ANY($1::text[]) AND s.state='created' ORDER BY s.source_id`,
        [products],
      )
    ).map(r => r.source_id);
  const sources = await ids();
  const states = async () =>
    q(
      `SELECT source_id,sync_state,failure,binding FROM tf_knowledge_${kind}_sources WHERE source_id=ANY($1::uuid[]) ORDER BY source_id`,
      [sources],
    );
  const receipts = async () =>
    q(`SELECT id,state FROM tf_knowledge_credit_attempts WHERE purpose='ingestion' ORDER BY id`);
  const before = {
    receipts: await receipts(),
    calls: embeddingCalls.length,
    sources: (await q(`SELECT id FROM tf_knowledge_sources ORDER BY id`)).map(r => r.id),
  };
  await reauthorize();
  if (fenced) {
    await q(
      `UPDATE tf_knowledge_${kind}_sources SET next_attempt_at=clock_timestamp() WHERE source_id=ANY($1::uuid[])`,
      [sources],
    );
    await eventually(
      async () => (await states()).every(s => s.sync_state === 'failed'),
      'the old bindings fail after reauthorization',
    );
    // Without a rebind, the provider's own backoff retries keep failing.
    await q(
      `UPDATE tf_knowledge_${kind}_sources SET next_attempt_at=clock_timestamp() WHERE source_id=ANY($1::uuid[])`,
      [sources],
    );
    await delay(2000);
  }
  assert.ok(
    (await states()).every(s => s.sync_state === 'failed'),
    fenced ? 'backoff alone does not recover' : 'the sources are failed before Retry',
  );
  for (const product of products) {
    const [intent] = await q(`SELECT id FROM tf_knowledge_default_intents WHERE product=$1`, [product]);
    const response = await f.call(`/v1/workspaces/${f.workspace.id}/knowledge/defaults/${intent.id}/manage`, {
      method: 'POST',
      body: { action: 'retry' },
    });
    assert.equal(response.status, 200, response.bytes.toString());
  }
  await eventually(
    async () =>
      (await states()).every(s => s.sync_state === 'ready') &&
      (await Promise.all(products.map(p => published(q, kind, p)))).every(Boolean),
    'automatic Retry rebinds and the same sources publish again',
  );
  for (const state of await states())
    assert.ok(await current(state.binding), `source ${state.source_id} is bound to the current authorization`);
  assert.deepEqual(await ids(), sources, 'the same automatic sources recover');
  assert.deepEqual(
    (await q(`SELECT id FROM tf_knowledge_sources ORDER BY id`)).map(r => r.id),
    before.sources,
    'Retry creates no source',
  );
  assert.deepEqual(await receipts(), before.receipts, 'unchanged content is not billed again');
  assert.equal(embeddingCalls.length, before.calls, 'no paid request for unchanged content');
}

test(
  'real Temporal turns a new Google authorization into published owner-only Drive and Gmail Knowledge',
  { timeout: 240000 },
  async () => {
    const google = await googleProviderFixture();
    google.state.mailDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    await journey(
      'google',
      {
        kind: 'google',
        fixture: async extra => ({ googleOptions: { ...google.options, defaultKnowledge: automatic }, ...extra }),
        engine: ({ f, integration, env, gate }) =>
          createGoogleKnowledgeWorker({
            runtime: f.runtime,
            integration,
            env,
            gate,
            googleService: createGoogleWorkspaceService({ runtime: f.runtime, ...google.options }),
            providerFetch: google.providerFetch,
          }),
        close: google.close,
      },
      async ({ f, q, defaults, start, embeddingCalls }) => {
        await start(await defaults());
        await connectGoogle(f);
        assert.deepEqual(
          (await q(`SELECT product,account_key FROM tf_knowledge_default_intents ORDER BY product`)).map(r => [
            r.product,
            r.account_key,
          ]),
          [
            ['gmail', 'owner-account'],
            ['google-drive', 'owner-account'],
          ],
          'one consent records both products for the connected account',
        );
        await eventually(
          async () => (await published(q, 'google', 'google-drive')) && (await published(q, 'google', 'gmail')),
          'Drive and Gmail defaults publish, embed and settle credits without opening Knowledge',
        );
        const selections = await q(
          `SELECT s.selection FROM tf_knowledge_google_sources s JOIN tf_knowledge_default_sources d ON d.source_id=s.source_id ORDER BY s.selection->>'kind'`,
        );
        assert.deepEqual(
          selections.map(r => r.selection.kind),
          ['drive-all', 'gmail'],
        );
        assert.deepEqual(
          [selections[1].selection.window, selections[1].selection.labelId, selections[1].selection.excludeSpamTrash],
          ['rolling-90d', null, true],
          'whole mailbox, rolling 90 days, without Spam or Trash',
        );
        assert.ok(embeddingCalls.length > 0);
      },
    );
  },
);

test(
  'real Temporal turns Slack member consent into published owner-only channel Knowledge',
  { timeout: 240000 },
  async () => {
    const slack = slackProviderFixture();
    await journey(
      'slack',
      {
        kind: 'slack',
        fixture: async extra => ({ slackCorpus: slack.provider, ...extra }),
        engine: ({ f, integration, env, gate }) =>
          createSlackKnowledgeWorker({
            runtime: f.runtime,
            integration,
            env,
            gate,
            slackCorpus: slack.provider(f.runtime),
          }),
      },
      async ({ f, q, defaults, start }) => {
        await start(await defaults());
        await slack.link(f, f.signed.owner, f.workspace.membershipId, 'UOWNER');
        // Fixture linking writes the identity directly; this is the record call member consent makes in the same transaction.
        await f.runtime.transaction(f.workspace.id, { minimum: 1, maximum: 1 }, tx =>
          recordDefaultKnowledgeIntent(tx, {
            product: 'slack',
            membershipId: f.workspace.membershipId,
            accountKey: 'TFIXTURE:UOWNER',
            accountLabel: '@UOWNER',
          }),
        );
        await eventually(
          async () => await published(q, 'slack', 'slack'),
          'Slack defaults publish, embed and settle credits without opening Knowledge',
        );
        const [source] = await q(
          `SELECT s.selection FROM tf_knowledge_slack_sources s JOIN tf_knowledge_default_sources d ON d.source_id=s.source_id`,
        );
        assert.deepEqual(
          [...source.selection.conversationIds].sort(),
          ['CGENERAL', 'GPRIVATE'],
          'public and private channels the member is in; no DMs',
        );
        assert.equal(source.selection.window, 'rolling-90d');
      },
    );
  },
);

test(
  'real Temporal turns Atlassian consent into published owner-only Jira and Confluence Knowledge',
  { timeout: 240000 },
  async () => {
    const atlassian = atlassianProviderFixture();
    await journey(
      'atlassian',
      {
        kind: 'atlassian',
        fixture: async extra => ({ atlassianCorpus: atlassian.provider, ...extra }),
        engine: ({ f, integration, env, gate }) =>
          createAtlassianKnowledgeWorker({
            runtime: f.runtime,
            integration,
            env,
            gate,
            atlassianCorpus: atlassian.provider(f.runtime),
          }),
      },
      async ({ f, q, defaults, start }) => {
        await start(await defaults());
        const owner = await atlassian.link(f, f.workspace.membershipId, 'owner-aaid');
        // Fixture linking writes the account directly; these are the record calls consent makes for each granted product.
        for (const product of ['jira', 'confluence'])
          await f.runtime.transaction(f.workspace.id, { minimum: 1, maximum: 1 }, tx =>
            recordDefaultKnowledgeIntent(tx, {
              product,
              membershipId: f.workspace.membershipId,
              accountKey: owner.accountId,
              accountLabel: 'owner-aaid',
            }),
          );
        await eventually(
          async () => (await published(q, 'atlassian', 'jira')) && (await published(q, 'atlassian', 'confluence')),
          'Jira and Confluence defaults publish, embed and settle credits without opening Knowledge',
        );
        const selections = await q(
          `SELECT s.selection FROM tf_knowledge_atlassian_sources s JOIN tf_knowledge_default_sources d ON d.source_id=s.source_id ORDER BY s.selection->>'product'`,
        );
        assert.deepEqual(
          selections.map(r => [r.selection.product, r.selection.cloudId]),
          [
            ['confluence', atlassian.cloudId],
            ['jira', atlassian.cloudId],
          ],
        );
      },
    );
  },
);

test(
  'real Temporal publishes the unaffected Atlassian site when another refuses configuration, then recovers the refused site once',
  { timeout: 240000 },
  async () => {
    const atlassian = atlassianProviderFixture({ secondSite: true });
    let refused = true;
    // Discovery lists both sites; the second refuses the per-project inspection that configuration runs.
    atlassian.state.failure = (_user, path, cloudId) =>
      refused && cloudId === atlassian.secondCloudId && /^\/rest\/api\/3\/project\/\d+$/.test(path)
        ? new Response('{}', { status: 403 })
        : null;
    await journey(
      'atlassian-site',
      {
        kind: 'atlassian',
        fixture: async extra => ({ atlassianCorpus: atlassian.provider, ...extra }),
        engine: ({ f, integration, env, gate }) =>
          createAtlassianKnowledgeWorker({
            runtime: f.runtime,
            integration,
            env,
            gate,
            atlassianCorpus: atlassian.provider(f.runtime),
          }),
      },
      async ({ f, q, defaults, start }) => {
        await start(await defaults());
        const owner = await atlassian.link(f, f.workspace.membershipId, 'owner-aaid');
        await f.runtime.transaction(f.workspace.id, { minimum: 1, maximum: 1 }, tx =>
          recordDefaultKnowledgeIntent(tx, {
            product: 'jira',
            membershipId: f.workspace.membershipId,
            accountKey: owner.accountId,
            accountLabel: 'owner-aaid',
          }),
        );
        await eventually(
          async () =>
            (await published(q, 'atlassian', 'jira')) &&
            (await q(`SELECT 1 FROM tf_knowledge_default_sources WHERE state='failed' AND failure='forbidden'`))
              .length === 1,
          'the unaffected site publishes while the refused one is recorded',
        );
        const sites = async () =>
          (
            await q(
              `SELECT s.selection->>'cloudId' AS cloud FROM tf_knowledge_atlassian_sources s JOIN tf_knowledge_default_sources d ON d.source_id=s.source_id ORDER BY 1`,
            )
          ).map(r => r.cloud);
        assert.deepEqual(await sites(), [atlassian.cloudId]);
        const [intent] = await q(`SELECT sync_state,group_failures FROM tf_knowledge_default_intents`);
        assert.equal(intent.sync_state, 'ready', 'one refused site does not fail the account');
        assert.deepEqual(intent.group_failures, [{ title: 'beta', failure: 'forbidden' }]);

        refused = false;
        // Skip the hourly rediscovery wait.
        await q(`UPDATE tf_knowledge_default_intents SET next_attempt_at=clock_timestamp()`);
        // Both sites hold the same fixture content, so the second site may reuse embeddings instead of opening a new credit attempt; publication is the recovery proof.
        const searchable = async () =>
          (
            await q(`SELECT d.source_id FROM tf_knowledge_documents d JOIN tf_knowledge_default_sources s ON s.source_id=d.source_id
      WHERE s.state='created' AND d.tombstoned_at IS NULL AND d.lexical_publication_id IS NOT NULL AND d.vector_publication_id IS NOT NULL GROUP BY d.source_id`)
          ).length;
        await eventually(
          async () => (await sites()).length === 2 && (await searchable()) === 2,
          'the refused site is created and published once access returns',
        );
        assert.deepEqual(await sites(), [atlassian.cloudId, atlassian.secondCloudId].sort());
        assert.deepEqual((await q(`SELECT group_failures FROM tf_knowledge_default_intents`))[0].group_failures, []);
        assert.equal((await q(`SELECT count(*)::int AS n FROM tf_knowledge_sources`))[0].n, 2, 'no duplicate sources');
      },
    );
  },
);

test(
  'a configure that commits but loses its acknowledgement converges after a worker restart on one source, one publication and unchanged billing',
  { timeout: 240000 },
  async () => {
    const slack = slackProviderFixture();
    await journey(
      'restart',
      {
        kind: 'slack',
        fixture: async extra => ({ slackCorpus: slack.provider, ...extra }),
        engine: ({ f, integration, env, gate }) =>
          createSlackKnowledgeWorker({
            runtime: f.runtime,
            integration,
            env,
            gate,
            slackCorpus: slack.provider(f.runtime),
          }),
      },
      async ({ f, q, engine, defaults, start, stop, embeddingCalls }) => {
        let lost = 0;
        // The source commit succeeds, then the worker dies before the defaults service learns the result.
        const crashing = await start(
          await defaults({
            slack: {
              ...engine.service,
              configure: async (...args) => {
                await engine.service.configure(...args);
                lost++;
                throw new Error('worker lost before acknowledgement');
              },
            },
          }),
        );
        await slack.link(f, f.signed.owner, f.workspace.membershipId, 'UOWNER');
        await f.runtime.transaction(f.workspace.id, { minimum: 1, maximum: 1 }, tx =>
          recordDefaultKnowledgeIntent(tx, {
            product: 'slack',
            membershipId: f.workspace.membershipId,
            accountKey: 'TFIXTURE:UOWNER',
            accountLabel: '@UOWNER',
          }),
        );
        await eventually(async () => lost > 0, 'the first configure commits');
        await stop(crashing);
        const [planned] = await q(`SELECT source_id,state FROM tf_knowledge_default_sources`);
        assert.equal(planned.state, 'planned', 'the lost acknowledgement leaves the planned row');
        assert.equal(
          (await q(`SELECT id FROM tf_knowledge_sources WHERE id=$1`, [planned.source_id])).length,
          1,
          'the source committed before the crash',
        );
        // The restarted worker retries after backoff; skip the wait.
        await q(`UPDATE tf_knowledge_default_intents SET next_attempt_at=clock_timestamp()`);
        await start(await defaults());
        await eventually(
          async () =>
            (await q(`SELECT state FROM tf_knowledge_default_sources`)).every(r => r.state === 'created') &&
            (await published(q, 'slack', 'slack')),
          'replay converges and publishes',
        );
        const sources = await q(`SELECT id FROM tf_knowledge_sources`);
        assert.deepEqual(
          sources.map(s => s.id),
          [planned.source_id],
          'replay used the same deterministic command, so one source exists',
        );
        const documents = async () =>
          await q(
            `SELECT id,lexical_publication_id,vector_publication_id FROM tf_knowledge_documents WHERE source_id=$1 ORDER BY id`,
            [planned.source_id],
          );
        const receipts = async () =>
          await q(`SELECT id,state FROM tf_knowledge_credit_attempts WHERE purpose='ingestion' ORDER BY id`);
        const before = { documents: await documents(), receipts: await receipts(), calls: embeddingCalls.length };
        assert.ok(
          before.documents.every(d => d.lexical_publication_id && d.vector_publication_id),
          'each document has one lexical and one vector publication',
        );
        // A second replay of the same configuration changes nothing and bills nothing.
        await q(`UPDATE tf_knowledge_default_intents SET next_attempt_at=clock_timestamp()`);
        await q(`UPDATE tf_knowledge_default_sources SET state='planned'`);
        await eventually(
          async () => (await q(`SELECT state FROM tf_knowledge_default_sources`)).every(r => r.state === 'created'),
          'second replay acknowledges',
        );
        await delay(3000);
        assert.deepEqual(await documents(), before.documents);
        assert.deepEqual(await receipts(), before.receipts, 'billing is unchanged on replay');
        assert.equal(embeddingCalls.length, before.calls, 'no paid request on replay');
        assert.equal(lost, 1);
      },
    );
  },
);

test(
  'real Temporal: after GitHub reconnects the same account, automatic Retry rebinds the source and it publishes again',
  { timeout: 240000 },
  async () => {
    const gh = githubProviderFixture();
    await journey(
      'github-reconnect',
      {
        kind: 'github',
        fixture: async extra => ({ githubCorpus: gh.provider, ...extra }),
        engine: ({ f, integration, env, gate }) =>
          createGitHubKnowledgeWorker({
            runtime: f.runtime,
            integration,
            env,
            gate,
            githubCorpus: gh.provider(f.runtime),
          }),
      },
      async ({ f, q, defaults, start, embeddingCalls }) => {
        await start(await defaults());
        const owner = await gh.connect(f, f.signed.owner, 101, 'owner', undefined, automatic);
        await eventually(async () => await published(q, 'github', 'github'), 'GitHub defaults publish');
        const account = async () =>
          (await q(`SELECT generation FROM tf_github_accounts WHERE id=$1`, [owner.accountId]))[0].generation;
        const first = await account();
        await recoversAfterReauthorization(
          { f, q, kind: 'github', products: ['github'], embeddingCalls },
          () => gh.connect(f, f.signed.owner, 101, 'owner', owner.accountId, automatic),
          async binding =>
            binding.accountId === owner.accountId &&
            binding.accountGeneration === (await account()) &&
            binding.accountGeneration > first,
        );
      },
    );
  },
);

test(
  'real Temporal: after Google consent is renewed, automatic Retry rebinds Drive and Gmail and they publish again',
  { timeout: 240000 },
  async () => {
    const google = await googleProviderFixture();
    google.state.mailDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    await journey(
      'google-reconnect',
      {
        kind: 'google',
        fixture: async extra => ({ googleOptions: { ...google.options, defaultKnowledge: automatic }, ...extra }),
        engine: ({ f, integration, env, gate }) =>
          createGoogleKnowledgeWorker({
            runtime: f.runtime,
            integration,
            env,
            gate,
            googleService: createGoogleWorkspaceService({ runtime: f.runtime, ...google.options }),
            providerFetch: google.providerFetch,
          }),
        close: google.close,
      },
      async ({ f, q, defaults, start, embeddingCalls }) => {
        await start(await defaults());
        await connectGoogle(f);
        await eventually(
          async () => (await published(q, 'google', 'google-drive')) && (await published(q, 'google', 'gmail')),
          'Drive and Gmail defaults publish',
        );
        const integration = async () =>
          (
            await q(`SELECT account_id,generation FROM tf_google_integrations WHERE membership_id=$1`, [
              f.workspace.membershipId,
            ])
          )[0];
        const first = await integration();
        await recoversAfterReauthorization(
          { f, q, kind: 'google', products: ['google-drive', 'gmail'], embeddingCalls },
          async () => {
            // The stored grant expires, as the service records it, and the owner consents again with the same Google account.
            await q(
              `UPDATE tf_google_integrations SET status='reconnect-required',credential=NULL,generation=generation+1 WHERE membership_id=$1`,
              [f.workspace.membershipId],
            );
            await connectGoogle(f);
          },
          async binding => {
            const now = await integration();
            return (
              binding.accountId === first.account_id &&
              binding.generation === now.generation &&
              now.generation > first.generation
            );
          },
        );
      },
    );
  },
);

test(
  'real Temporal: after a Slack reinstall and relink of the same member, automatic Retry rebinds the source and it publishes again',
  { timeout: 240000 },
  async () => {
    const slack = slackProviderFixture();
    await journey(
      'slack-reconnect',
      {
        kind: 'slack',
        fixture: async extra => ({ slackCorpus: slack.provider, ...extra }),
        engine: ({ f, integration, env, gate }) =>
          createSlackKnowledgeWorker({
            runtime: f.runtime,
            integration,
            env,
            gate,
            slackCorpus: slack.provider(f.runtime),
          }),
      },
      async ({ f, q, defaults, start, embeddingCalls }) => {
        await start(await defaults());
        await slack.link(f, f.signed.owner, f.workspace.membershipId, 'UOWNER');
        await f.runtime.transaction(f.workspace.id, { minimum: 1, maximum: 1 }, tx =>
          recordDefaultKnowledgeIntent(tx, {
            product: 'slack',
            membershipId: f.workspace.membershipId,
            accountKey: 'TFIXTURE:UOWNER',
            accountLabel: '@UOWNER',
          }),
        );
        await eventually(async () => await published(q, 'slack', 'slack'), 'Slack defaults publish');
        let relinked;
        await recoversAfterReauthorization(
          { f, q, kind: 'slack', products: ['slack'], embeddingCalls },
          async () => {
            await q(`UPDATE tf_slack_installations SET generation=2 WHERE id=$1`, [slack.installationId]);
            relinked = await slack.link(f, f.signed.owner, f.workspace.membershipId, 'UOWNER', { generation: 2 });
          },
          async binding =>
            binding.identityId === relinked.identityId &&
            binding.installationGeneration === 2 &&
            binding.slackUserId === 'UOWNER',
        );
      },
    );
  },
);

test(
  'real Temporal: after the Atlassian account is reauthorized, automatic Retry restores the Jira source and it publishes again',
  { timeout: 240000 },
  async () => {
    const atlassian = atlassianProviderFixture();
    await journey(
      'atlassian-reconnect',
      {
        kind: 'atlassian',
        fixture: async extra => ({ atlassianCorpus: atlassian.provider, ...extra }),
        engine: ({ f, integration, env, gate }) =>
          createAtlassianKnowledgeWorker({
            runtime: f.runtime,
            integration,
            env,
            gate,
            atlassianCorpus: atlassian.provider(f.runtime),
          }),
      },
      async ({ f, q, defaults, start, embeddingCalls }) => {
        await start(await defaults());
        const owner = await atlassian.link(f, f.workspace.membershipId, 'owner-aaid');
        await f.runtime.transaction(f.workspace.id, { minimum: 1, maximum: 1 }, tx =>
          recordDefaultKnowledgeIntent(tx, {
            product: 'jira',
            membershipId: f.workspace.membershipId,
            accountKey: owner.accountId,
            accountLabel: 'owner-aaid',
          }),
        );
        await eventually(async () => await published(q, 'atlassian', 'jira'), 'Jira defaults publish');
        // An Atlassian binding names the account, not its generation, so the failure comes from the revoked token before the reconnect.
        await recoversAfterReauthorization(
          { f, q, kind: 'atlassian', products: ['jira'], embeddingCalls, fenced: false },
          async () => {
            atlassian.revoke(owner.token);
            await q(`UPDATE tf_knowledge_atlassian_sources SET next_attempt_at=clock_timestamp()`);
            await eventually(
              async () =>
                (await q(`SELECT sync_state FROM tf_knowledge_atlassian_sources`)).every(
                  s => s.sync_state === 'failed',
                ),
              'the revoked token fails the source',
            );
            await atlassian.reauthorize(f, owner.accountId, 'owner-aaid');
          },
          async binding => binding.accountId === owner.accountId && binding.atlassianAccountId === 'owner-aaid',
        );
      },
    );
  },
);
