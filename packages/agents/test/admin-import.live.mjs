import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createGovernanceService } from '../../workspaces/dist/governance.js';
import { initializeSoul } from '@tulipfarm/workspaces/soul';
import { prepareSoulRevision } from '@tulipfarm/workspaces/soul-revisions';
import { createConversations } from '@tulipfarm/conversations';
import { createConversationExecutor } from '@tulipfarm/conversations/runtime';
import { createTableProposals, createTableProposalDecisions } from '@tulipfarm/tables/proposals';
import { createTablePublication, createTableExecution, executionCompatibility } from '@tulipfarm/tables/execution';
import { createTableService } from '@tulipfarm/tables/service';
import { createChatTools } from '../src/tools.ts';
import { tableProposalOptions } from '../src/table-proposals.ts';
import {
  requireTableSources,
  requireTableFiles,
  requireTableImportReference,
  bindTableSourceAuthorization,
} from '../src/table-sources.ts';

async function setup(t) {
  const db = await fixture();
  const cleanup = [() => db.close()];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
  });
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const migrations = await workspaceTableMigrations();
  const ws = await db.create(migrations),
    s = `"${ws.names.schema}"`;
  const runtime = createWorkspaceRuntime({
    resolveCredential: async () => ({ workspaceId: ws.id, generation: 1, connectionString: db.login(ws) }),
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 30,
  });
  cleanup.push(() => runtime.close());
  const objects = new Map();
  const server = createServer(async (request, response) => {
    const key = new URL(request.url, 'http://localhost').pathname;
    if (request.method === 'PUT') {
      if (objects.has(key)) {
        response.writeHead(412).end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      objects.set(key, {
        body: Buffer.concat(chunks),
        sha: request.headers['x-amz-meta-sha256'],
        command: request.headers['x-amz-meta-command-sha256'],
      });
      response.writeHead(200).end();
      return;
    }
    const object = objects.get(key);
    if (!object) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, {
        'content-length': object.body.length,
        'x-amz-meta-sha256': object.sha,
        ...(object.command ? { 'x-amz-meta-command-sha256': object.command } : {}),
      })
      .end(object.body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise(resolve => server.close(resolve)));
  const soul = {
    bucket: 'regression',
    client: new S3Client({
      region: 'auto',
      endpoint: `http://127.0.0.1:${server.address().port}`,
      forcePathStyle: true,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    }),
  };
  cleanup.push(async () => soul.client.destroy());
  const seed = { workspaceId: ws.id, createdBy: ws.userId, createdAt: new Date().toISOString() };
  const initial = await initializeSoul(soul, seed);
  await db.platform.query(`UPDATE ${s}.tf_soul_head SET revision=$1`, [initial.commit]);
  const team = randomUUID();
  await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Original owner')`, [team]);
  const actor = { kind: 'human', userId: ws.userId, membershipId: ws.membershipId };
  const conversations = createConversations(runtime);
  const options = tableProposalOptions(runtime);
  const proposals = createTableProposals(options);
  const decisions = createTableProposalDecisions({
    ...options,
    resolveConfirmationCredential: async () => db.login(ws, 'confirmation'),
  });
  const access = {
    requireSources: async (tx, actor, sources) => {
      try {
        return await requireTableSources(tx, actor, sources);
      } catch (error) {
        for (const source of sources)
          await requireTableSources(tx, actor, [source]).catch(e =>
            process.stdout.write(
              `DENIEDSOURCE ${JSON.stringify(source)} ${e?.stack?.split('\n').slice(0, 4).join(' | ')}\n`,
            ),
          );
        throw error;
      }
    },
    requireFiles: requireTableFiles,
    requireImportReference: requireTableImportReference,
    bindSourceAuthorization: bindTableSourceAuthorization,
  };
  const publish = createTablePublication({
    runtime,
    ...access,
    prepareRevision: input =>
      prepareSoulRevision(
        soul,
        seed,
        input.parent ? { ...input.parent, commit: input.expectedParentCommit, bucket: soul.bucket } : initial,
        {
          kind: 'table',
          commandId: input.commandId,
          expectedParentCommit: input.expectedParentCommit,
          createdAt: input.createdAt,
          definition: input.definition,
        },
      ),
  });
  const advance = createTableExecution({
    ...access,
    resolveMigrationCredential: async () => db.login(ws, 'migration'),
    batchRows: 2,
  });
  const tableService = createTableService(
    runtime,
    { readableFiles: async () => assert.fail('No files') },
    executionCompatibility,
  );
  const governance = createGovernanceService({ runtime, identity: db.platform, compatibility: executionCompatibility });
  const transaction = operation => runtime.transaction(ws.id, executionCompatibility, operation);
  const chatProposal = async (makePlan, requester = actor, discover = true) => {
    const discovery = discover === true ? { tool: 'tables.definitions', limit: 100 } : discover || null;
    const chat = randomUUID();
    await conversations.create(ws.id, requester.userId, { chatId: chat, commandId: randomUUID() });
    const sent = await conversations.send(ws.id, requester.userId, chat, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      parts: [{ kind: 'text', text: 'Review the requested table change' }],
    });
    let proposal,
      discovered,
      sources = [];
    const executor = createConversationExecutor(runtime, async ({ executeTool }) => {
      const invoke = async call => {
        const output = await executeTool(
          call.tool,
          false,
          context =>
            createChatTools(context.runtime).invokeWithSources(
              { ...context, origin: { ...context.origin, sources: [...context.origin.sources, ...sources] } },
              call,
            ),
          sources,
        );
        sources.push(...output.sources);
        return output.result;
      };
      if (discovery) discovered = await invoke(discovery);
      const plan = makePlan(discovered);
      proposal = await invoke({
        tool: 'tables.propose',
        input: JSON.stringify({ plans: Array.isArray(plan) ? plan : [plan] }),
      });
      return { text: 'Review this proposal.', sources };
    });
    assert.equal(
      await executor.process({ workspaceId: ws.id, conversationId: chat, turnId: sent.turnId, generation: 0 }),
      'completed',
    );
    assert.ok(proposal?.id, JSON.stringify(proposal));
    const manifest = (
      await db.platform.query(`SELECT manifest FROM ${s}.tf_table_proposals WHERE id=$1`, [proposal.id])
    ).rows[0].manifest;
    assert.ok(
      manifest.sources.some(source => source.kind === 'private-conversation' && source.conversationId === chat),
    );
    if (discovery) assert.ok(manifest.sources.some(source => source.tableId === manifest.plans[0].input.tableId));
    assert.deepEqual(
      (
        await db.platform.query(
          `SELECT tool,status FROM ${s}.tf_conversation_tool_calls WHERE turn_id=$1 ORDER BY sequence`,
          [sent.turnId],
        )
      ).rows,
      [...(discovery ? [discovery.tool] : []), 'tables.propose'].map(tool => ({ tool, status: 'completed' })),
    );
    return { ...proposal, chat, requester, sources, manifest, discovered };
  };
  const approve = p =>
    decisions.decide(ws.id, p.requester.userId, p.chat, p.id, {
      commandId: randomUUID(),
      decision: 'approve',
      digest: p.digest,
    });
  const finish = async p => {
    for (let i = 0; i < 30; i++) {
      // The worker retries an execution step that ran out of its time budget; a busy local database can hit it.
      const status = await advance(ws.id, p.id).catch(error => {
        if (
          error?.constructor?.name === 'ExecutionBudgetExceeded' ||
          ['25P03', '25P04', '57014'].includes(String(error?.code))
        )
          return 'retry';
        throw error;
      });
      if (status === 'completed' || status === 'blocked') return status;
      if (status === 'publish') await publish(ws.id, p.id);
    }
    assert.fail('Execution did not converge');
  };
  // Table titles are fixed after creation, so each schema change adds a field labelled with the change.
  const schema = (item, change) => ({
    kind: 'schema',
    tableId: item.id,
    expectedRevision: item.revision,
    dependsOn: [],
    target:
      change === item.definition.label
        ? item.definition
        : {
            ...item.definition,
            fields: [
              ...item.definition.fields,
              { id: randomUUID(), label: change, kind: 'text', required: false, maxLength: 1000 },
            ],
          },
    transforms: { outputs: [] },
  });
  const create = async () => {
    const definition = {
      formatVersion: 2,
      id: randomUUID(),
      owningTeamId: team,
      label: 'Tickets',
      fields: [{ id: randomUUID(), label: 'Title', kind: 'text', required: false, maxLength: 1000 }],
      uniqueKeys: [],
    };
    const p = await chatProposal(
      () => ({ ...schema({ id: definition.id, revision: null, definition }, definition.label) }),
      actor,
      false,
    );
    await approve(p);
    assert.equal(await finish(p), 'completed');
    return (await tableService.definitions(ws.id, actor)).tables.find(item => item.id === definition.id);
  };
  return {
    db,
    ws,
    s,
    team,
    actor,
    runtime,
    transaction,
    governance,
    tableService,
    create,
    schema,
    chatProposal,
    approve,
    finish,
    publish,
    advance,
    soul,
    proposals,
    decisions,
  };
}

import { createHash } from 'node:crypto';
import { createAttachments } from '../../conversations/src/attachments.ts';
import { modelEnvironment } from '../src/model-environment.ts';

const family = process.env.TABLE_QA_MODEL;
const credentials = Boolean(
  process.env.AZURE_FOUNDRY_API_KEY && process.env.AZURE_FOUNDRY_ENDPOINT && process.env.TEST_ADMIN_DATABASE_URL,
);
test(
  'live: an Admin imports a CSV into an existing typed table after another listed table changed',
  {
    skip:
      !family || !credentials
        ? 'set TABLE_QA_MODEL, AZURE_FOUNDRY_API_KEY, AZURE_FOUNDRY_ENDPOINT and TEST_ADMIN_DATABASE_URL to run'
        : false,
    timeout: 1800000,
  },
  async t => {
    const configured = modelEnvironment()?.route(family);
    assert.ok(configured, 'route');
    const h = await setup(t);
    const { ws, actor, runtime, schema, chatProposal, approve, finish, tableService } = h;
    const make = async definition => {
      const p = await chatProposal(
        () => schema({ id: definition.id, revision: null, definition }, definition.label),
        actor,
        false,
      );
      await approve(p);
      assert.equal(await finish(p), 'completed');
      return (await tableService.definitions(ws.id, actor)).tables.find(item => item.id === definition.id);
    };
    const f = (label, kind, extra = {}) => ({ id: randomUUID(), label, kind, required: false, ...extra });
    const orderId = f('Order ID', 'text', { maxLength: 1000 });
    const orders = await make({
      formatVersion: 2,
      id: randomUUID(),
      owningTeamId: h.team,
      label: 'qa-orders',
      fields: [
        orderId,
        f('Customer', 'text', { maxLength: 1000 }),
        f('Status', 'single-select', {
          options: ['New', 'Paid', 'Shipped'].map(label => ({ id: randomUUID(), label, retired: false })),
        }),
        f('Amount', 'numeric', { precision: 12, scale: 2 }),
        f('Order date', 'date'),
      ],
      uniqueKeys: [{ id: randomUUID(), fieldIds: [orderId.id], nulls: 'distinct' }],
    });
    const contacts = await make({
      formatVersion: 2,
      id: randomUUID(),
      owningTeamId: h.team,
      label: 'qa-contacts',
      fields: [f('Name', 'text', { maxLength: 1000 })],
      uniqueKeys: [],
    });
    const bytes = new Map();
    const store = {
      putIfAbsent: async (key, body) => void (bytes.has(key) || bytes.set(key, Buffer.from(body))),
      read: async key => bytes.get(key),
      remove: async key => void bytes.delete(key),
    };
    const conversations = createConversations(runtime);
    const attachments = createAttachments(runtime, store);
    const chatId = randomUUID();
    await conversations.create(ws.id, actor.userId, { chatId, commandId: randomUUID() });
    // The staging deployment has a small tokens-per-minute quota shared with other runs, so provider 429s are retried
    // here and the turn lease is kept alive meanwhile. Production capacity does not need this.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      for (let attempt = 0; ; attempt++) {
        const response = await realFetch(input, init);
        if (response.status !== 429 || attempt >= 15) return response;
        const wait = Number(response.headers.get('retry-after') ?? 10);
        await response.arrayBuffer().catch(() => {});
        await new Promise(resolve => setTimeout(resolve, Math.max(wait, 5) * 1000 + 2000));
      }
    };
    const renew = setInterval(() => {
      h.db.platform
        .query(
          `UPDATE ${h.s}.tf_conversation_turns SET lease_until=clock_timestamp()+interval '2 minutes' WHERE conversation_id=$1 AND status='processing'`,
          [chatId],
        )
        .catch(() => {});
    }, 15000);
    t.after(() => {
      clearInterval(renew);
      globalThis.fetch = realFetch;
    });
    // The production chat worker answers each turn: its platform prompt, attachment context, tool guard and tools.
    const { createConversationActivities } = await import('../../../apps/worker/src/conversation-activities.ts');
    const worker = createConversationActivities(runtime, undefined, { attachments: store, snapshots: store });
    const steps = async () =>
      (
        await h.db.platform.query(
          `SELECT c.tool, c.status, s.call, s.output FROM ${h.s}.tf_conversation_tool_calls c LEFT JOIN ${h.s}.tf_conversation_execution_steps s ON s.call_id=c.id AND s.turn_id=c.turn_id WHERE c.conversation_id=$1 ORDER BY c.created_at, c.sequence, c.id`,
          [chatId],
        )
      ).rows;
    const turn = async (parts, label) => {
      const sent = await conversations.send(ws.id, actor.userId, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        model: family,
        parts,
      });
      let status;
      for (let i = 0; i < 12; i++) {
        status = await worker.processConversationReply({
          workspaceId: ws.id,
          conversationId: chatId,
          turnId: sent.turnId,
          generation: 0,
        });
        if (status !== 'retry') break;
        await new Promise(resolve => setTimeout(resolve, 20000));
      }
      process.stdout.write(`TURN ${label} ${status}\n`);
      assert.equal(status, 'completed', `${label} turn`);
    };
    await turn([{ kind: 'text', text: 'List my tables and show the fields of qa-orders and qa-contacts.' }], 'list');
    // Another listed table changes between turns, which pinned a stale revision before the fix.
    const change = await chatProposal(() => schema(contacts, 'Email'), actor, false);
    await approve(change);
    assert.equal(await finish(change), 'completed');
    const csv = Buffer.from(
      'Order ID;Customer;Status;Amount;Order date\nRV-311;Hooli;New;12.75;2026-11-05\nRV-312;Stark;Paid;99.99;2026-11-06\n',
    );
    const attachmentId = randomUUID();
    await attachments.reserve(ws.id, actor.userId, chatId, attachmentId, {
      filename: 'qa-semicolon.csv',
      mediaType: 'text/csv',
      size: csv.length,
      sha256: createHash('sha256').update(csv).digest('hex'),
    });
    await attachments.upload(ws.id, actor.userId, chatId, attachmentId, csv);
    const before = (await steps()).length;
    await turn(
      [
        { kind: 'attachment', attachmentId },
        {
          kind: 'text',
          text: 'Import the attached CSV file into the existing table qa-orders, matching on the unique key Order ID. Map columns by name. Show me the review first.',
        },
      ],
      'import',
    ).catch(error => process.stdout.write(`TURNERROR ${error.message}\n`));
    const all = await steps();
    for (const row of all)
      process.stdout.write(
        `STEP ${row.tool} ${row.status} ${JSON.stringify(row.call).slice(0, 3000)} => ${JSON.stringify(row.output).slice(0, 3000)}\n`,
      );
    const results = all.map(row => ({ ...row, result: row.output?.result ?? row.output }));
    const denied = results.filter(row => row.status === 'blocked' || row.result?.error === 'access-denied').length;
    const proposals = results.filter(row => row.tool === 'tables.propose' && row.result?.status === 'pending');
    const pending = proposals.length;
    const proposal = proposals.at(-1)?.result;
    const calls = results
      .slice(before)
      .map(row => `${row.tool}:${row.result?.error ?? row.result?.status ?? row.status}`);
    const replies = (
      await h.db.platform.query(
        `SELECT p.text FROM ${h.s}.tf_conversation_parts p JOIN ${h.s}.tf_conversation_messages m ON m.id=p.message_id WHERE m.conversation_id=$1 AND m.author_kind<>'human' AND p.text IS NOT NULL`,
        [chatId],
      )
    ).rows
      .map(r => r.text)
      .join('\n');
    const askAdmin = /ask (a|your) (workspace )?admin/i.test(replies);
    // Any wording that tells an Admin they lack access or need a permission or role.
    const permission =
      /permission|\b(lack|missing|need|grant|request|require)\w*\b[^.\n]{0,40}\b(access|role)s?\b|access (is |was )?denied|not (allowed|permitted)/i.test(
        replies,
      );
    process.stdout.write(`REPLIES ${JSON.stringify(replies)}\n`);
    process.stdout.write(
      `LIVE ${family} calls=${calls.join(',')} denied=${denied} pending=${pending} askAdmin=${askAdmin} permission=${permission}\n`,
    );
    assert.ok(pending >= 1, 'review card');
    await approve({ ...proposal, chat: chatId, requester: actor });
    const executed = await finish({ ...proposal, chat: chatId, requester: actor });
    const current = (await tableService.definitions(ws.id, actor)).tables.find(item => item.id === orders.id);
    const listed = await tableService.list(ws.id, actor, { tableId: orders.id, revision: current.revision, limit: 50 });
    const rows = (Array.isArray(listed) ? listed : listed.records).map(r => r.values ?? r);
    process.stdout.write(`JOURNEY ${family} execution=${executed} rows=${rows.length} ${JSON.stringify(rows)}\n`);
    if (executed !== 'completed') {
      const why = await h.db.platform.query(
        `SELECT phase,error_code FROM ${h.s}.tf_table_executions WHERE proposal_id=$1`,
        [proposal.id],
      );
      const report = await h.db.platform
        .query(`SELECT * FROM ${h.s}.tf_table_blocked_reports WHERE proposal_id=$1`, [proposal.id])
        .catch(e => ({ rows: [String(e)] }));
      process.stdout.write(`BLOCKED ${JSON.stringify(why.rows)} ${JSON.stringify(report.rows).slice(0, 2000)}\n`);
    }
    assert.equal(executed, 'completed');
    assert.equal(rows.length, 2);
    const text = JSON.stringify(rows);
    const status = orders.definition.fields.find(field => field.label === 'Status');
    const label = id => status.options.find(option => option.id === id)?.label;
    assert.deepEqual(rows.map(row => label(row[status.id]?.optionId)).sort(), ['New', 'Paid']);
    for (const expected of ['RV-311', 'RV-312', 'Hooli', 'Stark', '12.75', '99.99', '2026-11-05', '2026-11-06'])
      assert.ok(text.includes(expected), expected);
    assert.equal(denied, 0);
    assert.equal(askAdmin, false);
    assert.equal(permission, false);
  },
);
