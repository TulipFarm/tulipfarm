import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import ExcelJS from '../../../packages/tables/node_modules/exceljs/excel.js';
import { setTimeout as delay } from 'node:timers/promises';

export async function proveSupportJourney({
  app,
  headers,
  workspaceId,
  chatBase,
  team,
  propose,
  complete,
  chatTools,
  member,
  pauseExecution,
}) {
  const id = randomUUID;
  const customers = id(),
    tickets = id(),
    assignments = id();
  const name = id(),
    code = id(),
    title = id(),
    customer = id(),
    status = id(),
    cost = id(),
    urgent = id(),
    due = id(),
    opened = id(),
    tags = id(),
    ticket = id(),
    assignee = id();
  const open = id(),
    closed = id(),
    priority = id();
  const text = (id, label, required = false) => ({ id, label, kind: 'text', required, maxLength: 1000 });
  const relationship = (id, label, targetTableId) => ({
    id,
    label,
    kind: 'relationship',
    required: false,
    targetTableId,
    cardinality: 'one',
    inverseCardinality: 'many',
    reverse: null,
    onDelete: 'restrict',
  });
  const definition = (id, label, fields, uniqueKeys = []) => ({
    formatVersion: 2,
    id,
    owningTeamId: team,
    label,
    fields,
    uniqueKeys,
  });
  const customerDefinition = definition(customers, 'Customers', [text(name, 'Customer name', true)]);
  const ticketDefinition = definition(
    tickets,
    'Tickets',
    [
      text(code, 'Ticket number', true),
      text(title, 'Title'),
      relationship(customer, 'Customer', customers),
      {
        id: status,
        label: 'Status',
        kind: 'single-select',
        required: false,
        options: [
          { id: open, label: 'Open', retired: false },
          { id: closed, label: 'Closed', retired: false },
        ],
      },
      { id: cost, label: 'Cost', kind: 'numeric', required: false, precision: 12, scale: 2 },
      { id: urgent, label: 'Urgent', kind: 'boolean', required: false },
      { id: due, label: 'Due date', kind: 'date', required: false },
      { id: opened, label: 'Opened at', kind: 'timestamp', required: false, timezone: 'UTC' },
      {
        id: tags,
        label: 'Tags',
        kind: 'multi-select',
        required: false,
        options: [{ id: priority, label: 'Priority', retired: false }],
      },
    ],
    [{ id: id(), fieldIds: [code], nulls: 'distinct' }],
  );
  const assignmentDefinition = definition(assignments, 'Assignments', [
    relationship(ticket, 'Ticket', tickets),
    text(assignee, 'Assignee'),
  ]);
  const schema = (target, expectedRevision = null, transforms = { outputs: [] }) => ({
    kind: 'schema',
    tableId: target.id,
    dependsOn: [],
    expectedRevision,
    target,
    transforms,
  });
  const revisions = new Map();
  for (const target of [customerDefinition, ticketDefinition, assignmentDefinition])
    revisions.set(
      target.id,
      await complete(await propose([schema(target)], `Create the ${target.label} table for our support operation.`)),
    );
  const customerId = id(),
    ticketId = id(),
    assignmentId = id();
  const values = {
    [code]: { kind: 'text', value: '001' },
    [title]: { kind: 'text', value: '  Printer unavailable  ' },
    [customer]: { kind: 'relationship', tableId: customers, recordIds: [customerId] },
    [status]: { kind: 'single-select', optionId: open },
    [cost]: { kind: 'numeric', value: '12.50' },
    [urgent]: { kind: 'boolean', value: true },
    [due]: { kind: 'date', value: '2026-10-15' },
    [opened]: { kind: 'timestamp', value: '2026-10-01T12:00:00.000Z' },
    [tags]: { kind: 'multi-select', optionIds: [priority] },
  };
  for (const [tableId, recordId, recordValues] of [
    [customers, customerId, { [name]: { kind: 'text', value: 'Acme' } }],
    [tickets, ticketId, values],
    [
      assignments,
      assignmentId,
      {
        [ticket]: { kind: 'relationship', tableId: tickets, recordIds: [ticketId] },
        [assignee]: { kind: 'text', value: 'Support operator' },
      },
    ],
  ]) {
    await complete(
      await propose(
        [
          {
            kind: 'records',
            tableId,
            expectedRevision: revisions.get(tableId),
            dependsOn: [],
            changes: [{ kind: 'create', recordId, values: recordValues }],
          },
        ],
        `Create the linked support record in ${tableId}.`,
      ),
    );
  }
  const base = tableId => `/workspaces/${workspaceId}/tables/${tableId}`;
  const records = async tableId => {
    const response = await app.inject({ url: `${base(tableId)}/rows?revision=${revisions.get(tableId)}`, headers });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  assert.deepEqual((await records(tickets))[0].values, values);
  assert.deepEqual((await records(assignments))[0].values[ticket].recordIds, [ticketId]);
  const governance = `/workspaces/${workspaceId}/governance`;
  const grant = async (person, granted) => {
    const response = await app.inject({
      method: 'PUT',
      url: `${governance}/${person ? 'person-grants' : 'grants'}`,
      headers,
      payload: {
        ...(person ? { membershipId: member.membershipId } : { teamId: team }),
        target: { kind: 'table', id: tickets, permission: 'table.row.read' },
        granted,
      },
    });
    assert.equal(response.statusCode, 200, response.body);
  };
  const memberRead = () =>
    app.inject({
      url: `${base(tickets)}/rows?revision=${revisions.get(tickets)}`,
      headers: { ...headers, cookie: member.cookie },
    });
  assert.equal((await memberRead()).statusCode, 404);
  await grant(false, true);
  assert.equal((await memberRead()).statusCode, 200, 'Team read grant works');
  await grant(true, true);
  await grant(false, false);
  assert.equal((await memberRead()).statusCode, 200, 'Direct read grant survives team revocation');
  const memberWrite = await app.inject({
    method: 'POST',
    url: `${base(tickets)}/rows`,
    headers: { ...headers, cookie: member.cookie },
    payload: {
      requestId: id(),
      kind: 'create',
      tableId: tickets,
      revision: revisions.get(tickets),
      recordId: id(),
      values: { [code]: { kind: 'text', value: 'denied' } },
    },
  });
  assert.equal(memberWrite.statusCode, 404, 'Read grant does not grant create');
  await grant(true, false);
  const denied = await memberRead();
  assert.equal(denied.statusCode, 404);
  assert.equal(denied.body.includes('Printer'), false);
  const duplicate = await app.inject({
    method: 'POST',
    url: `${base(tickets)}/rows`,
    headers,
    payload: {
      requestId: id(),
      kind: 'create',
      tableId: tickets,
      revision: revisions.get(tickets),
      recordId: id(),
      values,
    },
  });
  assert.equal(duplicate.statusCode, 409, duplicate.body);

  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Tickets').addRows([
    ['number', 'title'],
    ['002', 'Spreadsheet corrected'],
    ['003', 'Spreadsheet new'],
  ]);
  for (const [format, bytes, mediaType, selection] of [
    [
      'csv',
      Buffer.from('number,title\n001,CSV corrected\n002,CSV new\n'),
      'text/csv',
      { format: 'csv', delimiter: ',' },
    ],
    [
      'xlsx',
      Buffer.from(await workbook.xlsx.writeBuffer()),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      { format: 'xlsx', sheet: 'Tickets' },
    ],
  ]) {
    const attachmentId = id(),
      contentDigest = createHash('sha256').update(bytes).digest('hex');
    const upload = `${chatBase}/uploads/${attachmentId}`;
    const reserved = await app.inject({
      method: 'PUT',
      url: upload,
      headers,
      payload: { filename: `tickets.${format}`, mediaType, size: bytes.length, sha256: contentDigest },
    });
    assert.equal(reserved.statusCode, 200, reserved.body);
    const uploaded = await app.inject({
      method: 'PUT',
      url: `${upload}/content`,
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: bytes,
    });
    assert.equal(uploaded.statusCode, 200, uploaded.body);
    const results = await chatTools(
      [
        { tool: 'tables.import.attachments' },
        {
          tool: 'tables.import.file',
          attachmentId,
          contentDigest,
          selection: JSON.stringify({ ...selection, header: { kind: 'row', row: 1 }, conversions: {}, empty: 'null' }),
        },
        () => ({
          tool: 'tables.propose',
          input: JSON.stringify({
            plans: [
              {
                kind: 'import',
                tableId: tickets,
                expectedRevision: revisions.get(tickets),
                dependsOn: [],
                reference: { kind: 'file', attachmentId, contentDigest },
                matchFieldIds: [code],
                mappings: [
                  { sourceColumn: 'number', fieldId: code },
                  { sourceColumn: 'title', fieldId: title },
                ],
              },
            ],
          }),
        }),
      ],
      `Import the attached ${format.toUpperCase()} tickets by Ticket number. Preserve fields not mapped in the import.`,
      [attachmentId],
    );
    await complete(results.at(-1));
  }
  const imported = await records(tickets);
  assert.deepEqual(imported.map(row => [row.values[code].value, row.values[title].value]).sort(), [
    ['001', 'CSV corrected'],
    ['002', 'Spreadsheet corrected'],
    ['003', 'Spreadsheet new'],
  ]);
  assert.deepEqual(imported.find(row => row.id === ticketId).values[customer], values[customer]);
  const transformed = {
    ...ticketDefinition,
    fields: ticketDefinition.fields.map(field => (field.id === customer ? { ...field, cardinality: 'many' } : field)),
  };
  const migration = await propose(
    [
      schema(transformed, revisions.get(tickets), {
        outputs: [
          { fieldId: status, expression: { op: 'literal', value: { kind: 'single-select', optionId: closed } } },
        ],
      }),
    ],
    'Close imported tickets and allow each ticket to link multiple customers.',
  );
  const gate = pauseExecution(migration.id);
  const completion = complete(migration);
  try {
    await Promise.race([
      gate.entered.promise,
      completion.then(() => assert.fail('Migration completed before the checkpoint')),
      delay(20000).then(() => assert.fail('Migration did not reach its checkpoint')),
    ]);
    const current = (await records(tickets)).find(row => row.id === ticketId);
    const edit = await app.inject({
      method: 'POST',
      url: `${base(tickets)}/rows`,
      headers,
      payload: {
        requestId: id(),
        kind: 'update',
        tableId: tickets,
        revision: revisions.get(tickets),
        recordId: ticketId,
        expectedToken: current.token,
        values: { [cost]: { kind: 'numeric', value: '18.75' } },
      },
    });
    assert.equal(edit.statusCode, 200, edit.body);
  } finally {
    gate.release.resolve();
  }
  revisions.set(tickets, await completion);
  const migrated = await records(tickets);
  assert.ok(migrated.every(row => row.values[status].optionId === closed));
  assert.deepEqual(migrated.find(row => row.id === ticketId).values[customer], values[customer]);
  assert.equal(
    migrated.find(row => row.id === ticketId).values[cost].value,
    '18.75',
    'Unrelated edit during migration survives activation',
  );
  const history = await app.inject({ url: `${base(tickets)}/rows/${ticketId}/history`, headers });
  assert.equal(history.statusCode, 200, history.body);
  assert.ok(history.json().some(entry => entry.operation === 'transform'));
  process.stdout.write(
    `${JSON.stringify({ event: 'q29-support-journey', tables: 3, imports: ['csv', 'xlsx'], ticketRows: migrated.length, fields: ['text', 'numeric', 'boolean', 'date', 'timestamp', 'single-select', 'multi-select', 'relationship'], result: 'passed' })}\n`,
  );
}
