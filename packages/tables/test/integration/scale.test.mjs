/* oxlint-disable tulipfarm/product-copy -- Internal measurement labels, not application copy. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fixture, connect } from '../../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '../../../workspaces/src/table-migrations.ts';
import { requireTableSources } from '../../../agents/src/table-sources.ts';
import { createTableProposals, createTableProposalDecisions } from '../../../tables/dist/proposals.js';
import {
  createTableExecution,
  createTablePublication,
  executionCompatibility,
} from '../../../tables/dist/execution.js';
import { tableProposalOptions } from '../../../agents/src/table-proposals.ts';
import { importObjectFixture } from '../import-object-fixture.mjs';
import { createTableService } from '../../../tables/dist/service.js';

test(
  '100000 records migrate with exact approval, refresh and available concurrent reads/writes',
  { timeout: 900000 },
  async t => {
    const count = 100000;
    const measurements = { rows: count, stream: executionCompatibility.maximum, phases: {}, probes: {}, batches: 0 };
    const report = (event, data) => process.stdout.write(`${JSON.stringify({ event, ...data })}\n`);
    const timed = async (name, action) => {
      const start = performance.now();
      try {
        return await action();
      } finally {
        measurements.phases[name] = Math.round(performance.now() - start);
        report('scale-phase', { phase: name, ms: measurements.phases[name] });
      }
    };
    const db = await fixture();
    let runtime,
      observer,
      stopped = false,
      writer,
      monitor;
    let writes = 0,
      reads = 0,
      writerFailure;
    t.after(async () => {
      stopped = true;
      await writer;
      await monitor;
      await observer?.end();
      await runtime?.close();
      await db.close();
    });
    for (const name of ['execution', 'proposals', 'store', 'service']) {
      const bytes = await readFile(new URL(`../../dist/${name}.js`, import.meta.url));
      report('scale-source', { name, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const migrations = await workspaceTableMigrations();
    measurements.stream = migrations.length;
    report('scale-composition', {
      proposalAdapter: 'tableProposalOptions',
      imports: 'createTableImports',
      provisionedStream: migrations.length,
      publication: 'deterministic receipt',
    });
    assert.equal(migrations.length, 4);
    assert.deepEqual(executionCompatibility, commonCompatibility);
    const ws = await timed('provision', () => db.create(migrations));
    const s = `"${ws.names.schema}"`;
    assert.deepEqual(
      (await db.platform.query(`SELECT name FROM ${s}.tf_common_migrations ORDER BY name`)).rows.map(row => row.name),
      migrations.map(item => item.name),
    );
    observer = await connect(db.connectionString);
    runtime = createWorkspaceRuntime({
      resolveCredential: async () => ({ workspaceId: ws.id, generation: 1, connectionString: db.login(ws) }),
      connectionsPerPool: 3,
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
    });
    const actor = { kind: 'human', userId: ws.userId, membershipId: ws.membershipId };
    const chat = randomUUID(),
      turn = randomUUID(),
      message = randomUUID(),
      team = randomUUID();
    await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Scale fixture')`, [team]);
    await db.platform.query(
      `INSERT INTO ${s}.tf_conversations(id,owner_user_id,owner_membership_id) VALUES($1,$2,$3)`,
      [chat, ws.userId, ws.membershipId],
    );
    await db.platform.query(
      `INSERT INTO ${s}.tf_conversation_messages(id,conversation_id,sequence,author_kind,membership_id) VALUES($1,$2,1,'human',$3)`,
      [message, chat, ws.membershipId],
    );
    await db.platform.query(
      `INSERT INTO ${s}.tf_conversation_turns(id,conversation_id,source_message_id,accepted_sequence) VALUES($1,$2,$3,1)`,
      [turn, chat, message],
    );
    await db.platform.query(`UPDATE ${s}.tf_soul_head SET revision=$1`, ['a'.repeat(40)]);
    const access = { requireSources: requireTableSources };
    const importObjects = importObjectFixture();
    const options = tableProposalOptions(runtime, importObjects);
    assert.ok(options.imports, 'Production import adapter is composed');
    const proposals = createTableProposals(options);
    const decisions = createTableProposalDecisions({
      ...options,
      resolveConfirmationCredential: async () => db.login(ws, 'confirmation'),
    });
    const advance = createTableExecution({
      ...access,
      resolveMigrationCredential: async () => db.login(ws, 'migration'),
    });
    let revisions = 0;
    const publish = createTablePublication({
      runtime,
      ...access,
      prepareRevision: async input => ({
        commit: (++revisions).toString(16).padStart(40, '0'),
        parentCommit: input.expectedParentCommit,
        bundle: { key: `scale/${input.commandId}`, sha256: 'b'.repeat(64) },
        projection: { definition: input.definition },
      }),
    });
    const service = createTableService(
      runtime,
      {
        readableFiles: async () => {
          assert.fail('No file values in scale fixture');
        },
      },
      executionCompatibility,
    );
    const origin = {
      conversationId: chat,
      turnId: turn,
      sources: [{ kind: 'private-conversation', conversationId: chat }],
    };
    await timed('import-capture-100000', async () => {
      const content = Buffer.from(
        `number,title\n${Array.from({ length: count }, (_, index) => `${String(index + 1).padStart(6, '0')},Ticket ${index + 1}\n`).join('')}`,
      );
      const attachmentId = randomUUID(),
        objectKey = randomUUID();
      const contentDigest = createHash('sha256').update(content).digest('hex');
      await importObjects.attachments.putIfAbsent(`${ws.id}/${objectKey}`, content);
      await db.platform.query(
        `INSERT INTO ${s}.tf_conversation_attachments(id,conversation_id,membership_id,object_key,filename,media_type,size,sha256,state,message_id) VALUES($1,$2,$3,$4,'scale.csv','text/csv',$5,$6,'bound',$7)`,
        [attachmentId, chat, actor.membershipId, objectKey, content.length, contentDigest, message],
      );
      await db.platform.query(
        `INSERT INTO ${s}.tf_conversation_parts(message_id,conversation_id,ordinal,kind,attachment_id) VALUES($1,$2,0,'attachment',$3)`,
        [message, chat, attachmentId],
      );
      const reference = { kind: 'file', attachmentId, contentDigest };
      await options.imports.prepareFile(runtime, ws.id, actor, origin, reference, {
        format: 'csv',
        delimiter: ',',
        header: { kind: 'row', row: 1 },
        conversions: {},
        empty: 'null',
      });
      const snapshot = await runtime.transaction(ws.id, executionCompatibility, tx =>
        options.imports.readSnapshot(tx, actor, origin, reference),
      );
      assert.equal(snapshot.rows.length, count);
      assert.deepEqual(snapshot.rows[0], {
        number: { kind: 'text', value: '000001' },
        title: { kind: 'text', value: 'Ticket 1' },
      });
      assert.deepEqual(snapshot.rows.at(-1), {
        number: { kind: 'text', value: '100000' },
        title: { kind: 'text', value: 'Ticket 100000' },
      });
      assert.deepEqual(snapshot.sources, origin.sources);
      measurements.importSnapshotRows = snapshot.rows.length;
    });
    const propose = plan => proposals.propose(ws.id, actor, randomUUID(), origin, { plans: [plan] });
    const approve = proposal =>
      decisions.decide(ws.id, ws.userId, chat, proposal.id, {
        digest: proposal.digest,
        commandId: randomUUID(),
        decision: 'approve',
      });
    const finish = async proposal => {
      for (let step = 0; step < 1200; step++) {
        const phase = (
          await db.platform.query(`SELECT phase FROM ${s}.tf_table_executions WHERE proposal_id=$1`, [proposal.id])
        ).rows[0]?.phase;
        const start = performance.now();
        const result = await advance(ws.id, proposal.id);
        const ms = Math.round(performance.now() - start);
        measurements.maxBatchMs = Math.max(measurements.maxBatchMs ?? 0, ms);
        if (phase === 'reconciling') report('scale-reconciliation', { ms, status: result });
        measurements.batches++;
        if (step % 100 === 0) report('scale-progress', { step, status: result });
        if (result === 'completed' || result === 'blocked') return result;
        if (result === 'publish') await publish(ws.id, proposal.id);
      }
      assert.fail('100000-row execution did not converge within 1200 batches');
    };
    const title = randomUUID(),
      notes = randomUUID(),
      table = randomUUID();
    const definition = {
      formatVersion: 2,
      id: table,
      owningTeamId: team,
      label: 'Scale tickets',
      fields: [title, notes].map(id => ({
        id,
        label: id === title ? 'Title' : 'Notes',
        kind: 'text',
        required: false,
        maxLength: 1000,
      })),
      uniqueKeys: [],
    };
    const plan = (expectedRevision, transforms = { outputs: [] }) => ({
      kind: 'schema',
      tableId: table,
      dependsOn: [],
      expectedRevision,
      target: definition,
      transforms,
    });
    const creation = await propose(plan(null));
    await approve(creation);
    assert.equal(await finish(creation), 'completed');
    const active = async () =>
      (await db.platform.query(`SELECT * FROM ${s}.tf_table_generations WHERE table_id=$1 AND state='active'`, [table]))
        .rows[0];
    const source = await active();
    const titleColumn = `"f_${title.replaceAll('-', '')}"`,
      notesColumn = `"f_${notes.replaceAll('-', '')}"`;
    await timed('seed-100000', async () => {
      await db.platform.query(
        `INSERT INTO ${s}."${source.physical_table}"(id,token,${titleColumn},${notesColumn}) SELECT ('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,gen_random_uuid(),'  fixture  ','initial' FROM generate_series(1,$1) i`,
        [count],
      );
      await db.platform.query(
        `INSERT INTO ${s}.tf_table_identities(table_id,row_id,token,incarnation,field_versions,live) SELECT $1,id,token,token,jsonb_build_object($2::text,token,$3::text,token),true FROM ${s}."${source.physical_table}"`,
        [table, title, notes],
      );
      await db.platform.query(`ANALYZE ${s}."${source.physical_table}"; ANALYZE ${s}.tf_table_identities`);
    });
    assert.equal(
      (await db.platform.query(`SELECT count(*)::int n FROM ${s}."${source.physical_table}"`)).rows[0].n,
      count,
    );
    const first = '00000000-0000-4000-8000-000000000001';
    const last = '00000000-0000-4000-8000-000000100000';
    const read = id => service.read(ws.id, ws.userId, { tableId: table, revision: source.revision, recordId: id });
    const write = async (id, field, value) => {
      const row = await read(id);
      return service.mutate(ws.id, ws.userId, {
        kind: 'update',
        tableId: table,
        revision: source.revision,
        recordId: id,
        expectedToken: row.token,
        values: { [field]: { kind: 'text', value } },
      });
    };
    const probe = async (name, action) => {
      const start = performance.now();
      try {
        await action();
        measurements.probes[name] = { ok: true, ms: Math.round(performance.now() - start) };
      } catch (error) {
        measurements.probes[name] = {
          ok: false,
          code: String(error.code ?? error.name),
          ms: Math.round(performance.now() - start),
        };
      }
    };
    const underPreview = async (name, action) => {
      const before = await read(last);
      let done = false,
        result,
        failure;
      const pending = action()
        .then(
          value => {
            result = value;
          },
          error => {
            failure = error;
          },
        )
        .finally(() => {
          done = true;
        });
      let exclusive = false;
      while (!done) {
        const key = `${ws.names.schema}/${table}`;
        const locked = (
          await observer.query('SELECT pg_try_advisory_lock_shared(hashtextextended($1,7701)) acquired', [key])
        ).rows[0].acquired;
        if (locked) await observer.query('SELECT pg_advisory_unlock_shared(hashtextextended($1,7701))', [key]);
        else {
          exclusive = true;
          break;
        }
        await delay(5);
      }
      if (exclusive)
        await Promise.all([
          probe(`${name}-read`, () => read(last)),
          probe(`${name}-unrelated-write`, () =>
            service.mutate(ws.id, ws.userId, {
              kind: 'update',
              tableId: table,
              revision: source.revision,
              recordId: last,
              expectedToken: before.token,
              values: { [notes]: { kind: 'text', value: name } },
            }),
          ),
        ]);
      await pending;
      report('scale-lock', { phase: name, exclusiveObserved: exclusive, probes: measurements.probes });
      if (failure) throw failure;
      return result;
    };
    const transforms = {
      outputs: [{ fieldId: title, expression: { op: 'trim', input: { op: 'field', fieldId: title } } }],
    };
    try {
      const stale = await timed('preview-100000', () =>
        underPreview('preview', () => propose(plan(source.revision, transforms))),
      );
      const exact = (await db.platform.query(`SELECT manifest FROM ${s}.tf_table_proposals WHERE id=$1`, [stale.id]))
        .rows[0].manifest;
      assert.equal(exact.plans[0].effectCount, count);
      assert.deepEqual(
        (
          await db.platform.query(
            `SELECT (SELECT count(*)::int FROM ${s}.tf_table_proposal_effects WHERE proposal_id=$1) effects,(SELECT count(*)::int FROM ${s}.tf_table_proposal_freshness WHERE proposal_id=$1) freshness`,
            [stale.id],
          )
        ).rows[0],
        { effects: count, freshness: count },
      );
      await timed('approval-100000', () => underPreview('approval', () => approve(stale)));
      await publish(ws.id, stale.id);
      await timed('stale-start-100000', () => advance(ws.id, stale.id));
      await write(first, title, '  changed  ');
      assert.equal(await timed('reject-relevant-change', () => finish(stale)), 'blocked');
      const staleStatus = await proposals.status(ws.id, ws.userId, chat, stale.id);
      assert.equal(staleStatus.plans[0].receipt.code, 'proposal-stale');
      assert.equal((await active()).id, source.id);
      assert.equal((await read(first)).values[title].value, '  changed  ');
      measurements.relevantChangeRequiresRefresh = true;

      const refreshed = await timed('refresh-100000', () => propose(plan(source.revision, transforms)));
      await timed('refresh-approval-100000', () => approve(refreshed));
      await publish(ws.id, refreshed.id);
      await timed('start-100000', () => advance(ws.id, refreshed.id));
      await db.platform.query(`ANALYZE ${s}.tf_table_proposal_effects; ANALYZE ${s}.tf_table_proposal_freshness`);
      const explain = (
        await db.platform.query(
          `EXPLAIN (ANALYZE,FORMAT JSON) SELECT effect FROM ${s}.tf_table_proposal_effects WHERE proposal_id=$1 AND table_id=$2 AND effect->>'recordId'=$3`,
          [refreshed.id, table, last],
        )
      ).rows[0]['QUERY PLAN'][0];
      report('scale-effect-lookup', {
        node: explain.Plan['Node Type'],
        index: explain.Plan['Index Name'],
        actualRows: explain.Plan['Actual Rows'],
        executionMs: explain['Execution Time'],
      });
      writer = (async () => {
        while (!stopped) {
          try {
            await write(last, notes, `concurrent-${writes + 1}`);
            writes++;
            await read(first);
            reads++;
          } catch (error) {
            if (error.code === 'stale-generation') break;
            writerFailure = String(error.code ?? error.name);
            break;
          }
          await delay(25);
        }
      })();
      monitor = (async () => {
        measurements.executorSamples = {};
        while (!stopped) {
          const samples = (
            await db.databaseAdmin.query(
              `SELECT CASE
          WHEN query LIKE '%tf_table_row_history_data%' THEN 'history'
          WHEN query LIKE '%tf_table_unique_values%' THEN 'unique-values'
          WHEN query LIKE '%tf_table_proposal_effects%' THEN 'effects'
          WHEN query LIKE '%tf_table_execution_checks%' THEN 'checks'
          WHEN query LIKE '%tf_table_execution_dirty%' THEN 'dirty'
          WHEN query LIKE '%tf_table_generations%' THEN 'generations'
          WHEN query LIKE '%tf_table_identities%' THEN 'identities'
          ELSE 'other' END category,wait_event_type,extract(epoch FROM clock_timestamp()-xact_start)*1000 elapsed
          FROM pg_stat_activity WHERE datname=current_database() AND usename=$1 AND state='active'`,
              [ws.names.migration],
            )
          ).rows;
          for (const sample of samples) {
            const key = `${sample.category}/${sample.wait_event_type ?? 'cpu'}`;
            measurements.executorSamples[key] = (measurements.executorSamples[key] ?? 0) + 1;
            if (Number(sample.elapsed) > (measurements.longestSampleMs ?? 0)) {
              measurements.longestSampleMs = Math.round(Number(sample.elapsed));
              measurements.longestSampleCategory = key;
            }
          }
          await delay(50);
        }
      })();
      assert.equal(await timed('copy-and-activate-100000', () => finish(refreshed)), 'completed');
      stopped = true;
      await writer;
      await monitor;
      measurements.concurrentWrites = writes;
      measurements.concurrentReads = reads;
      assert.equal(writerFailure, undefined, 'Concurrent service operations failed');
      assert.ok(writes > 0 && reads > 0);
      const target = await active();
      assert.notEqual(target.id, source.id);
      const totals = (
        await db.platform.query(
          `SELECT count(*)::int n,count(*) FILTER(WHERE ${titleColumn}=btrim(${titleColumn}))::int trimmed FROM ${s}."${target.physical_table}"`,
        )
      ).rows[0];
      assert.deepEqual(totals, { n: count, trimmed: count });
      const exactValues = (
        await db.platform.query(
          `SELECT count(*)::int n FROM ${s}."${target.physical_table}" WHERE ${titleColumn}=CASE WHEN id=$1 THEN 'changed' ELSE 'fixture' END`,
          [first],
        )
      ).rows[0].n;
      assert.equal(exactValues, count);
      const preserved = await service.read(ws.id, ws.userId, {
        tableId: table,
        revision: target.revision,
        recordId: last,
      });
      assert.equal(preserved.values[notes].value, `concurrent-${writes}`);
      measurements.unrelatedWritesPreserved = true;
      assert.equal(
        (
          await db.platform.query(
            `SELECT count(*)::int n FROM ${s}.tf_table_row_history WHERE generation_id=$1 AND operation='transform'`,
            [target.id],
          )
        ).rows[0].n,
        count,
      );
      assert.equal(
        (
          await db.platform.query(
            `SELECT count(*)::int n FROM ${s}.tf_table_proposal_receipts WHERE proposal_id=$1 AND receipt->>'status'='completed'`,
            [refreshed.id],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(await advance(ws.id, refreshed.id), 'completed');
      measurements.migrationCompleted = true;
      const job = (
        await db.platform.query(`SELECT id FROM ${s}.tf_table_executions WHERE proposal_id=$1`, [refreshed.id])
      ).rows[0];
      await db.platform.query(`ANALYZE ${s}.tf_table_execution_checks`);
      const checks = (
        await db.platform.query(
          `EXPLAIN (ANALYZE,FORMAT JSON) SELECT has_effect,has_freshness FROM ${s}.tf_table_execution_checks WHERE execution_id=$1 AND row_id=$2`,
          [job.id, last],
        )
      ).rows[0]['QUERY PLAN'][0];
      report('scale-check-lookup', {
        node: checks.Plan['Node Type'],
        index: checks.Plan['Index Name'],
        actualRows: checks.Plan['Actual Rows'],
        executionMs: checks['Execution Time'],
      });
      assert.ok(
        Object.values(measurements.probes).every(result => result.ok),
        'Preview/approval prevented concurrent reads or unrelated writes; see sanitized measurements',
      );
    } catch (error) {
      measurements.failure = { code: String(error.code ?? error.name) };
      stopped = true;
      await writer;
      const current = await active();
      const preserved = await service.read(ws.id, ws.userId, {
        tableId: table,
        revision: current.revision,
        recordId: last,
      });
      measurements.concurrentWrites = writes;
      measurements.concurrentReads = reads;
      measurements.writerFailure = writerFailure ?? null;
      measurements.unrelatedWritesPreserved = !writes || preserved.values[notes].value === `concurrent-${writes}`;
      const jobs = (
        await db.platform.query(
          `SELECT phase,error_code,checked_effects,checked_freshness,expected_freshness FROM ${s}.tf_table_executions ORDER BY created_at`,
        )
      ).rows;
      report('scale-failure', { ...measurements.failure, jobs });
      const indexes = (
        await db.platform.query(
          `SELECT tablename,indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename IN ('tf_table_unique_values','tf_table_proposal_effects','tf_table_row_history_data','tf_table_execution_dirty') ORDER BY tablename,indexname`,
          [ws.names.schema],
        )
      ).rows;
      report('scale-indexes', {
        indexes: indexes.map(row => ({
          table: row.tablename,
          definition: row.indexdef.replaceAll(ws.names.schema, 'workspace'),
        })),
      });
      throw new Error(
        `100000-record acceptance failed (${measurements.failure.code}); see sanitized scale measurements`,
      );
    } finally {
      stopped = true;
      await writer;
      await monitor;
      report('scale-result', measurements);
    }
  },
);
