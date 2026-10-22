import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture, connect } from '../../workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { createTableService } from '@tulipfarm/tables/service';
import {
  createGeneration,
  activateGeneration,
  activeGeneration,
  identity,
  readRecords,
  writeGenerationRecord,
} from '@tulipfarm/tables/store';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkflows } from '../src/service.ts';
import { activate } from './commands.fixture.mjs';

const pick = ({ enabled, disabledReason }) => ({ enabled, disabledReason });

test(
  'record-date triggers follow field edits, deletes, restores and DST, fire once per occurrence, and respect table access',
  { timeout: 120000 },
  async t => {
    const db = await fixture();
    const cleanup = [];
    t.after(async () => {
      for (const close of cleanup.reverse()) await close();
      await db.close();
    });
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const migrations = await workspaceTableMigrations();
    const w = await db.create(migrations);
    const table = name => qualified(w.names.schema, name);
    const runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
    });
    cleanup.push(() => runtime.close());
    const migration = await connect(db.login(w, 'migration'));
    cleanup.push(() => migration.end());

    const team = randomUUID(),
      bob = { userId: randomUUID(), membershipId: randomUUID() };
    await db.platform.query(`INSERT INTO ${table('tf_teams')}(id,name) VALUES($1,'Support')`, [team]);
    await db.platform.query(`INSERT INTO ${table('tf_memberships')}(id,user_id,role) VALUES($1,$2,'member')`, [
      bob.membershipId,
      bob.userId,
    ]);
    await db.platform.query(`INSERT INTO ${table('tf_member_teams')}(membership_id,team_id) VALUES($1,$2)`, [
      bob.membershipId,
      team,
    ]);
    const revision = '1'.repeat(40);
    const field = (kind, extra = {}) => ({ id: randomUUID(), label: kind, required: false, kind, ...extra });
    const open = { id: randomUUID(), label: 'Open', retired: false },
      closed = { id: randomUUID(), label: 'Closed', retired: false },
      legacy = { id: randomUUID(), label: 'Legacy', retired: true };
    const fields = {
      title: field('text', { maxLength: 200 }),
      due: field('date'),
      meeting: field('timestamp', { timezone: 'UTC' }),
      status: field('single-select', { options: [open, closed, legacy] }),
      urgent: field('boolean'),
      notes: field('text', { maxLength: 10000 }),
    };
    const tickets = {
      formatVersion: 2,
      id: randomUUID(),
      owningTeamId: team,
      label: 'Tickets',
      fields: Object.values(fields),
      uniqueKeys: [],
    };
    await inTransaction(migration, async client => {
      await client.query(`SET LOCAL ROLE "${w.names.customOwner}"`);
      const tx = { client, schema: w.names.schema };
      const generation = await createGeneration(tx, { definition: tickets, revision });
      await activateGeneration(tx, { generationId: generation.id, expectedActiveGenerationId: null });
    });
    const records = createTableService(
      runtime,
      { readableFiles: async (_tx, _actor, ids) => new Set(ids) },
      { minimum: migrations.length, maximum: migrations.length },
    );
    const values = ({ title = 'Ticket', due = null, meeting = null, status = null, urgent = null, notes = null }) => ({
      [fields.title.id]: { kind: 'text', value: title },
      [fields.due.id]: due && { kind: 'date', value: due },
      [fields.meeting.id]: meeting && { kind: 'timestamp', value: meeting },
      [fields.status.id]: status && { kind: 'single-select', optionId: status.id },
      [fields.urgent.id]: urgent === null ? null : { kind: 'boolean', value: urgent },
      [fields.notes.id]: notes && { kind: 'text', value: notes },
    });
    const create = input =>
      records.mutate(w.id, w.userId, {
        kind: 'create',
        tableId: tickets.id,
        revision,
        recordId: randomUUID(),
        values: values(input),
      });
    const update = (record, input) =>
      records.mutate(w.id, w.userId, {
        kind: 'update',
        tableId: tickets.id,
        revision,
        recordId: record.id,
        expectedToken: record.token,
        values: input,
      });
    const remove = record =>
      records.mutate(w.id, w.userId, {
        kind: 'delete',
        tableId: tickets.id,
        revision,
        recordId: record.id,
        expectedToken: record.token,
      });
    const restore = async deleted => {
      const entry = (await records.history(w.id, w.userId, { tableId: tickets.id, recordId: deleted.id })).find(
        item => item.operation === 'delete',
      );
      return records.mutate(w.id, w.userId, {
        kind: 'restore',
        tableId: tickets.id,
        revision,
        recordId: deleted.id,
        expectedToken: entry.token,
        historyId: entry.id,
        version: 'after',
      });
    };

    const service = createWorkflows(runtime);
    const steps = [
      {
        id: 'note',
        kind: 'transform',
        fields: {
          record: { kind: 'input', path: ['recordId'] },
          title: { kind: 'input', path: ['values', fields.title.id, 'value'] },
        },
      },
    ];
    const dateTrigger = {
      kind: 'record',
      tableId: tickets.id,
      field: {
        kind: 'date',
        fieldId: fields.due.id,
        offset: { direction: 'before', amount: 1, unit: 'days' },
        time: '09:00',
        timezone: 'America/New_York',
      },
    };
    const meetingTrigger = {
      kind: 'record',
      tableId: tickets.id,
      field: {
        kind: 'timestamp',
        fieldId: fields.meeting.id,
        offset: { direction: 'before', amount: 1, unit: 'hours' },
      },
    };
    const launch = async (who, trigger) => {
      const id = randomUUID(),
        workflowRevision = randomUUID();
      await service.save(w.id, who.userId, id, {
        revision: workflowRevision,
        expectedRevision: null,
        definition: { version: 1, name: 'Reminder', trigger, steps },
      });
      await service.sponsorship(w.id, who.userId, id, {
        sponsorMembershipId: who.membershipId,
        historyAudience: [who.membershipId],
      });
      await activate(service, w.id, who.userId, id, workflowRevision, true);
      return id;
    };
    const workflow = async (who, id) => (await service.list(w.id, who.userId)).find(item => item.id === id);
    const sweep = async id => {
      await db.databaseAdmin.query(
        `UPDATE ${table('tf_workflows')} SET next_run_at=clock_timestamp() WHERE id=$1 AND enabled`,
        [id],
      );
      await service.due(w.id);
    };
    const upcoming = async (id, who = w) => {
      await sweep(id);
      return Object.fromEntries((await workflow(who, id)).upcomingRecords.map(item => [item.recordId, item.dueAt]));
    };

    // America/New_York enters daylight time on March's second Sunday and leaves it on November's first, so 09:00 local moves between 14:00Z and 13:00Z.
    const year = new Date().getUTCFullYear() + 1;
    const sunday = (month, nth) => {
      const first = new Date(Date.UTC(year, month, 1));
      return new Date(Date.UTC(year, month, 1 + ((7 - first.getUTCDay()) % 7) + 7 * (nth - 1)));
    };
    const day = (date, offset = 0) => new Date(date.getTime() + offset * 86400000).toISOString().slice(0, 10);
    const springForward = sunday(2, 2),
      fallBack = sunday(10, 1);
    const winter = await create({ title: 'Winter', due: day(springForward) });
    const spring = await create({ title: 'Spring', due: day(springForward, 1) });
    const autumn = await create({ title: 'Autumn', due: day(fallBack, 1) });
    await create({ title: 'Undated' });
    const dated = await launch(w, dateTrigger);
    const before = {
      [winter.id]: `${day(springForward, -1)}T14:00:00.000Z`,
      [spring.id]: `${day(springForward)}T13:00:00.000Z`,
      [autumn.id]: `${day(fallBack)}T14:00:00.000Z`,
    };
    assert.deepEqual(await upcoming(dated), before);
    assert.equal(
      (await workflow(w, dated)).nextRunAt,
      before[winter.id],
      'the next run is the earliest record occurrence',
    );

    const moved = await update(winter, { [fields.due.id]: { kind: 'date', value: `${year}-01-20` } });
    await remove(autumn);
    assert.deepEqual(
      await upcoming(dated),
      { [moved.id]: `${year}-01-19T14:00:00.000Z`, [spring.id]: before[spring.id] },
      'an edited date reschedules and a deleted record drops out',
    );
    await restore(autumn);
    assert.deepEqual(
      await upcoming(dated),
      { [moved.id]: `${year}-01-19T14:00:00.000Z`, [spring.id]: before[spring.id], [autumn.id]: before[autumn.id] },
      'a restored record returns',
    );

    const meetings = await launch(w, meetingTrigger);
    const startsSoon = new Date(Date.now() + 3600000 + 1500).toISOString();
    const standup = await create({ title: 'Standup', meeting: startsSoon });
    assert.deepEqual(await upcoming(meetings), {
      [standup.id]: new Date(Date.parse(startsSoon) - 3600000).toISOString(),
    });
    await new Promise(resolve => setTimeout(resolve, 2000));
    await service.due(w.id);
    const runs = async () =>
      (await service.history(w.id, w.userId, meetings).then(page => page.runs)).map(run => ({
        source: run.source,
        input: run.input,
      }));
    const fired = await runs();
    assert.deepEqual(fired, [
      {
        source: 'record',
        input: {
          tableId: tickets.id,
          recordId: standup.id,
          token: standup.token,
          scheduledFor: new Date(Date.parse(startsSoon) - 3600000).toISOString(),
          values: values({ title: 'Standup', meeting: startsSoon }),
        },
      },
    ]);
    assert.deepEqual(await upcoming(meetings), {});

    const renamed = await update(standup, { [fields.title.id]: { kind: 'text', value: 'Daily standup' } });
    await remove(renamed);
    const restored = await restore(renamed);
    await upcoming(meetings);
    const later = await update(restored, {
      [fields.meeting.id]: { kind: 'timestamp', value: new Date(Date.parse(startsSoon) + 86400000).toISOString() },
    });
    assert.deepEqual(await upcoming(meetings), {
      [standup.id]: new Date(Date.parse(startsSoon) + 82800000).toISOString(),
    });
    await update(later, { [fields.meeting.id]: { kind: 'timestamp', value: startsSoon } });
    assert.deepEqual(await upcoming(meetings), {});
    assert.deepEqual(
      await runs(),
      fired,
      'edits, deletes, restores and a date set back never refire an occurrence that already ran',
    );

    const isOpen = { fieldId: fields.status.id, match: 'is', value: { kind: 'single-select', optionId: open.id } };
    const opened = await create({ title: 'Opened', due: day(springForward, 2), status: open });
    const shut = await create({ title: 'Shut', due: day(springForward, 2), status: closed });
    const unset = await create({ title: 'Unset', due: day(springForward, 2) });
    const filtered = await launch(w, { ...dateTrigger, filter: isOpen });
    const dueAfterSpring = `${day(springForward, 1)}T13:00:00.000Z`;
    assert.deepEqual(
      await upcoming(filtered),
      { [opened.id]: dueAfterSpring },
      'only records matching the filter are scheduled',
    );
    const reopened = await update(shut, { [fields.status.id]: { kind: 'single-select', optionId: open.id } });
    await update(opened, { [fields.status.id]: { kind: 'single-select', optionId: closed.id } });
    assert.deepEqual(
      await upcoming(filtered),
      { [reopened.id]: dueAfterSpring },
      'a record that starts matching is scheduled and one that stops matching drops out',
    );
    const notClosed = await launch(w, {
      ...dateTrigger,
      filter: { ...isOpen, match: 'is-not', value: { kind: 'single-select', optionId: closed.id } },
    });
    assert.deepEqual(
      await upcoming(notClosed),
      {
        [moved.id]: `${year}-01-19T14:00:00.000Z`,
        [spring.id]: before[spring.id],
        [autumn.id]: before[autumn.id],
        [reopened.id]: dueAfterSpring,
        [unset.id]: dueAfterSpring,
      },
      '"is not" keeps records without a value',
    );
    const titled = await launch(w, {
      ...dateTrigger,
      filter: { fieldId: fields.title.id, match: 'is', value: { kind: 'text', value: 'Unset' } },
    });
    assert.deepEqual(await upcoming(titled), { [unset.id]: dueAfterSpring }, 'a text filter matches the exact value');
    await assert.rejects(
      launch(w, { ...dateTrigger, filter: { ...isOpen, value: { kind: 'single-select', optionId: randomUUID() } } }),
      { message: 'record-field-unavailable' },
      'a filter on an option the field does not have is refused',
    );
    await assert.rejects(
      launch(w, { ...dateTrigger, filter: { ...isOpen, value: { kind: 'text', value: 'Open' } } }),
      { message: 'record-field-unavailable' },
      'a filter whose value kind differs from the field kind is refused',
    );
    await assert.rejects(
      launch(w, { ...dateTrigger, filter: { ...isOpen, value: { kind: 'single-select', optionId: legacy.id } } }),
      { message: 'record-field-unavailable' },
      'a filter on a retired option, which no record can hold, is refused',
    );

    const inTwoDays = new Date(Date.now() + 2 * 86400000).toISOString();
    const calm = await create({ title: 'Calm', meeting: inTwoDays, urgent: false });
    const unmarked = await create({ title: 'Unmarked', meeting: inTwoDays });
    await create({ title: 'Urgent', meeting: inTwoDays, urgent: true });
    const notUrgent = await launch(w, {
      ...meetingTrigger,
      filter: { fieldId: fields.urgent.id, match: 'is-not', value: { kind: 'boolean', value: true } },
    });
    const hourBefore = new Date(Date.parse(inTwoDays) - 3600000).toISOString();
    assert.deepEqual(
      await upcoming(notUrgent),
      { [calm.id]: hourBefore, [unmarked.id]: hourBefore },
      'a yes or no filter on a timestamp trigger keeps "no" and empty values',
    );

    await assert.rejects(
      launch(bob, dateTrigger),
      AccessDenied,
      'a member who cannot read the table cannot build a trigger on it',
    );
    await service.share(w.id, w.userId, dated, {
      principal: { kind: 'person', id: bob.membershipId },
      permissions: ['read', 'invoke'],
    });
    assert.equal(
      (await workflow(bob, dated)).upcomingRecords,
      null,
      'record dates stay hidden from a workflow reader who cannot read the table',
    );
    await assert.rejects(
      service.sponsorship(w.id, w.userId, dated, {
        sponsorMembershipId: bob.membershipId,
        historyAudience: [bob.membershipId],
      }),
      { message: 'record-source-denied' },
    );
    await assert.rejects(
      launch(w, { ...dateTrigger, field: { ...dateTrigger.field, timezone: 'Mars/Olympus_Mons' } }),
      { message: 'invalid-schedule' },
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_grants')}(team_id,asset_id,permission) VALUES($1,$2,'table.row.read')`,
      [team, tickets.id],
    );
    const bobs = await launch(bob, dateTrigger);
    assert.equal(Object.keys(await upcoming(bobs, bob)).length, 6);
    await db.platform.query(`DELETE FROM ${table('tf_grants')} WHERE team_id=$1`, [team]);
    await sweep(bobs);
    assert.deepEqual(
      pick(await workflow(bob, bobs)),
      { enabled: false, disabledReason: 'sponsor-access-lost' },
      'a sponsor who loses table access stops the trigger and the workflow says why',
    );

    await assert.rejects(launch(w, { ...dateTrigger, field: { ...dateTrigger.field, fieldId: fields.meeting.id } }), {
      message: 'record-field-unavailable',
    });

    // JSON escapes each control character as six bytes, so 10,000 of them outgrow the 32 KiB run input even after narrowing to the filter field.
    const noted = await launch(w, {
      ...meetingTrigger,
      filter: { fieldId: fields.notes.id, match: 'is-not', value: { kind: 'text', value: 'none' } },
    });
    const soon = new Date(Date.now() + 3600000 + 1500).toISOString(),
      firesAt = new Date(Date.parse(soon) - 3600000).toISOString();
    const oversized = await create({ title: 'Oversized', meeting: soon, notes: '\u0001'.repeat(10000) });
    await new Promise(resolve => setTimeout(resolve, 2000));
    await db.databaseAdmin.query(
      `UPDATE ${table('tf_workflows')} SET next_run_at=clock_timestamp() - CASE WHEN id=$1 THEN interval '1 second' ELSE interval '0' END WHERE id=ANY($2)`,
      [noted, [noted, meetings]],
    );
    await service.due(w.id);
    const oversizedRuns = async id =>
      (await service.history(w.id, w.userId, id).then(page => page.runs))
        .filter(run => run.input.recordId === oversized.id)
        .map(run => ({ status: run.status, error: run.error, input: run.input }));
    assert.deepEqual(
      await oversizedRuns(noted),
      [
        {
          status: 'skipped',
          error: 'record-values-too-large',
          input: { tableId: tickets.id, recordId: oversized.id, token: oversized.token, scheduledFor: firesAt },
        },
      ],
      'an occurrence too large to pass on is recorded as skipped with its reason',
    );
    assert.deepEqual(
      await oversizedRuns(meetings),
      [
        {
          status: 'queued',
          error: null,
          input: {
            tableId: tickets.id,
            recordId: oversized.id,
            token: oversized.token,
            scheduledFor: firesAt,
            values: { [fields.meeting.id]: { kind: 'timestamp', value: soon } },
            valuesTruncated: true,
          },
        },
      ],
      'other workflows in the same sweep still run',
    );
    assert.equal(
      oversized.id in (await upcoming(noted)),
      false,
      'the skipped occurrence does not retry on every sweep',
    );

    const capped = await launch(w, {
      ...meetingTrigger,
      filter: { fieldId: fields.title.id, match: 'is', value: { kind: 'text', value: 'Capped' } },
    });
    await upcoming(capped);
    const sponsorship = (
      await db.databaseAdmin.query(`SELECT sponsorship_id FROM ${table('tf_workflows')} WHERE id=$1`, [capped])
    ).rows[0].sponsorship_id;
    const blockers = Array.from({ length: 10 }, () => randomUUID());
    for (const id of blockers)
      await db.databaseAdmin.query(
        `INSERT INTO ${table('tf_workflow_runs')} (id,workflow_id,revision,request_key,membership_id,input,sponsorship_id) SELECT $1,id,active_revision,$2,$3,'null',$4 FROM ${table('tf_workflows')} WHERE id=$5`,
        [id, `manual:${id}`, w.membershipId, sponsorship, capped],
      );
    // The workflow last read the table three hours ago and has sat at its run cap since.
    await db.databaseAdmin.query(
      `UPDATE ${table('tf_workflows')} SET activated_at=activated_at - interval '5 hours',next_run_at=next_run_at - interval '3 hours' WHERE id=$1`,
      [capped],
    );
    const hoursAgo = hours => new Date(Date.now() - hours * 3600000).toISOString();
    const fellDueMeeting = hoursAgo(1),
      savedLateMeeting = hoursAgo(2.5);
    const fellDue = await create({ title: 'Capped', meeting: fellDueMeeting });
    const savedLate = await create({ title: 'Capped', meeting: savedLateMeeting });
    const expected = {
      [savedLate.id]: new Date(Date.parse(savedLateMeeting) - 3600000).toISOString(),
      [fellDue.id]: new Date(Date.parse(fellDueMeeting) - 3600000).toISOString(),
    };
    const cappedRuns = async () =>
      Object.fromEntries(
        (await service.history(w.id, w.userId, capped).then(page => page.runs))
          .filter(run => run.source === 'record')
          .map(run => [run.input.recordId, run.input.scheduledFor]),
      );
    await service.due(w.id);
    assert.deepEqual(await cappedRuns(), {}, 'a workflow at its run cap admits nothing');
    await db.databaseAdmin.query(`UPDATE ${table('tf_workflow_runs')} SET status='completed' WHERE id=$1`, [
      blockers[0],
    ]);
    await service.due(w.id);
    assert.deepEqual(
      await cappedRuns(),
      { [savedLate.id]: expected[savedLate.id] },
      'one freed slot admits the earliest occurrence, saved within an hour of its date as counted from the last table read',
    );
    await create({ title: 'Capped', meeting: hoursAgo(1) });
    await db.databaseAdmin.query(`UPDATE ${table('tf_workflow_runs')} SET status='completed' WHERE id=ANY($1)`, [
      blockers,
    ]);
    await service.due(w.id);
    assert.deepEqual(
      await cappedRuns(),
      expected,
      'an occurrence that fell due while the workflow sat at its cap for over an hour fires once the cap clears, and a record written after the last table read with a date over an hour before it is history',
    );
    await upcoming(capped);
    assert.deepEqual(await cappedRuns(), expected, 'late occurrences fire once');

    const stalled = await launch(w, {
      ...meetingTrigger,
      filter: { fieldId: fields.title.id, match: 'is', value: { kind: 'text', value: 'Stalled' } },
    });
    await upcoming(stalled);
    const stalledSponsorship = (
      await db.databaseAdmin.query(`SELECT sponsorship_id FROM ${table('tf_workflows')} WHERE id=$1`, [stalled])
    ).rows[0].sponsorship_id;
    const weekBlockers = Array.from({ length: 10 }, () => randomUUID());
    for (const id of weekBlockers)
      await db.databaseAdmin.query(
        `INSERT INTO ${table('tf_workflow_runs')} (id,workflow_id,revision,request_key,membership_id,input,sponsorship_id) SELECT $1,id,active_revision,$2,$3,'null',$4 FROM ${table('tf_workflows')} WHERE id=$5`,
        [id, `manual:${id}`, w.membershipId, stalledSponsorship, stalled],
      );
    // The workflow last read the table a week ago and has sat at its run cap since.
    await db.databaseAdmin.query(
      `UPDATE ${table('tf_workflows')} SET activated_at=activated_at - interval '8 days',next_run_at=clock_timestamp() - interval '7 days' WHERE id=$1`,
      [stalled],
    );
    const occurrenceAt = hours => new Date(Date.now() - hours * 3600000).toISOString();
    const meetingFor = at => new Date(Date.parse(at) + 3600000).toISOString();
    const sixDays = occurrenceAt(144),
      threeDays = occurrenceAt(72),
      yesterday = occurrenceAt(25),
      recent = occurrenceAt(2);
    for (const at of [sixDays, threeDays, yesterday]) await create({ title: 'Stalled', meeting: meetingFor(at) });
    const fresh = await create({ title: 'Stalled', meeting: meetingFor(recent) });
    const stalledRuns = async () =>
      (await service.history(w.id, w.userId, stalled).then(page => page.runs))
        .filter(run => run.source === 'record')
        .map(run => ({ status: run.status, error: run.error, input: run.input }))
        .map(({ input: { values: _values, ...input }, ...run }) => ({ ...run, input }));
    await service.due(w.id);
    assert.deepEqual(await stalledRuns(), [], 'a workflow at its run cap for a week admits nothing');
    await db.databaseAdmin.query(`UPDATE ${table('tf_workflow_runs')} SET status='completed' WHERE id=ANY($1)`, [
      weekBlockers,
    ]);
    await service.due(w.id);
    const caughtUp = [
      {
        status: 'queued',
        error: null,
        input: { tableId: tickets.id, recordId: fresh.id, token: fresh.token, scheduledFor: recent },
      },
      {
        status: 'skipped',
        error: 'missed-occurrences-coalesced',
        input: { tableId: tickets.id, scheduledFor: sixDays, missedThrough: yesterday, missedCount: 3 },
      },
    ];
    assert.deepEqual(
      await stalledRuns(),
      caughtUp,
      'after a week at its run cap, occurrences more than a day late are recorded as one missed skip and only the recent one runs',
    );
    assert.deepEqual(await upcoming(stalled), {}, 'missed occurrences leave nothing due');
    assert.deepEqual(await stalledRuns(), caughtUp, 'missed occurrences are recorded once and never fire');

    await inTransaction(migration, async client => {
      await client.query(`SET LOCAL ROLE "${w.names.customOwner}"`);
      const tx = { client, schema: w.names.schema };
      const current = await activeGeneration(tx, tickets.id);
      const next = await createGeneration(tx, {
        definition: { ...tickets, fields: tickets.fields.filter(item => item.id !== fields.status.id) },
        revision: '2'.repeat(40),
      });
      for (const record of await readRecords(tx, current)) {
        const { [fields.status.id]: _status, ...kept } = record.values;
        await writeGenerationRecord(tx, {
          generationId: next.id,
          recordId: record.id,
          token: (await identity(tx, tickets.id, record.id)).token,
          values: kept,
        });
      }
      await activateGeneration(tx, { generationId: next.id, expectedActiveGenerationId: current.id });
    });
    await sweep(filtered);
    assert.deepEqual(
      pick(await workflow(w, filtered)),
      { enabled: false, disabledReason: 'record-field-unavailable' },
      'removing the filter field stops the trigger and the workflow says why',
    );
  },
);
