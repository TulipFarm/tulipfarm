import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeWhere,
  legacyWhere,
  normalizeQueryRequest,
  parseRsql,
  printRsql,
  queryCapabilities,
  queryLimits,
  simplifyWhere,
  TableQueryError,
  validateWhere,
} from '@tulipfarm/tables/query';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const option = (n, label, retired = false) => ({ id: id(100 + n), label, retired });
const fields = {
  subject: { id: id(1), label: 'Subject', kind: 'text', required: false, maxLength: 500 },
  status: {
    id: id(2),
    label: 'Status',
    kind: 'single-select',
    required: false,
    options: [option(1, 'Open'), option(2, 'Pending'), option(3, 'Closed')],
  },
  priority: {
    id: id(3),
    label: 'Priority',
    kind: 'single-select',
    required: false,
    options: [option(4, 'Low'), option(5, 'High'), option(6, 'Urgent')],
  },
  created: { id: id(4), label: 'Created at', kind: 'timestamp', required: false, timezone: 'UTC' },
  due: { id: id(5), label: 'Due date', kind: 'date', required: false },
  amount: { id: id(6), label: 'Amount', kind: 'numeric', required: false, precision: 12, scale: 2 },
  vip: { id: id(7), label: 'VIP', kind: 'boolean', required: false },
  tags: {
    id: id(8),
    label: 'Tags',
    kind: 'multi-select',
    required: false,
    options: [option(7, 'Billing'), option(8, 'Bug')],
  },
  customer: {
    id: id(9),
    label: 'Customer',
    kind: 'relationship',
    required: false,
    targetTableId: id(50),
    cardinality: 'one',
    inverseCardinality: 'many',
    reverse: null,
    onDelete: 'restrict',
  },
  files: {
    id: id(10),
    label: 'Attachments',
    kind: 'file',
    required: false,
    cardinality: 'many',
    access: 'independent',
  },
};
const definition = { fields: Object.values(fields) };
const rule = (field, op, ...values) => ({ kind: 'rule', fieldId: field.id, op, values });
const issueCodes = fn => {
  try {
    fn();
  } catch (error) {
    if (error instanceof TableQueryError) return error.issues.map(issue => issue.code);
    throw error;
  }
  assert.fail('expected a query error');
};

test('capabilities give readable unique aliases and stable selectors for every field', () => {
  const capabilities = queryCapabilities(definition);
  assert.deepEqual(capabilities.fields.map(field => field.selector).slice(0, 5), [
    'subject',
    'status',
    'priority',
    'created_at',
    'due_date',
  ]);
  assert.deepEqual(capabilities.fields.find(field => field.fieldId === fields.files.id).ops, ['empty', 'not-empty']);
  assert.equal(capabilities.fields.find(field => field.fieldId === fields.tags.id).sortable, false);
  assert.deepEqual(capabilities.fields.find(field => field.fieldId === fields.amount.id).metrics, [
    'sum',
    'avg',
    'min',
    'max',
  ]);
});

test('is me is a valueless typed condition, never a caller-supplied member alias', () => {
  const expected = rule(fields.customer, 'is-me');
  assert.deepEqual(parseRsql(definition, 'customer=isme=true'), expected);
  assert.equal(printRsql(definition, expected), 'customer=isme=true');
  assert.equal(describeWhere(definition, expected), 'Customer is me');
  assert.deepEqual(validateWhere(definition, expected, { [fields.customer.id]: { me: id(60) } }), expected);
  assert.deepEqual(
    issueCodes(() => validateWhere(definition, rule(fields.customer, 'is-me', id(60)))),
    ['invalid-value'],
  );
  assert.deepEqual(
    issueCodes(() => parseRsql(definition, 'customer=isme=false')),
    ['invalid-value'],
  );
  assert.deepEqual(
    issueCodes(() => parseRsql(definition, 'subject=isme=true')),
    ['unsupported-operator'],
  );
  assert.equal(
    queryCapabilities(definition)
      .fields.find(field => field.fieldId === fields.customer.id)
      .ops.includes('is-me'),
    false,
  );
  assert.equal(
    queryCapabilities(definition, fields.customer.targetTableId)
      .fields.find(field => field.fieldId === fields.customer.id)
      .ops.includes('is-me'),
    true,
  );
});
test('colliding, reserved, and digit-leading labels fall back to the f_ selector', () => {
  const a = { ...fields.subject, label: 'Name' },
    b = { ...fields.subject, id: id(20), label: 'name!' };
  const c = { ...fields.subject, id: id(21), label: 'and' },
    d = { ...fields.subject, id: id(22), label: '2nd line' };
  const capabilities = queryCapabilities({ fields: [a, b, c, d] });
  assert.deepEqual(
    capabilities.fields.map(field => field.alias),
    [null, null, null, null],
  );
  assert.equal(capabilities.fields[0].selector, `f_${a.id.replaceAll('-', '')}`);
  assert.deepEqual(
    issueCodes(() => parseRsql({ fields: [a, b] }, 'name==x')),
    ['unknown-field'],
  );
  assert.deepEqual(parseRsql({ fields: [a, b] }, `f_${b.id.replaceAll('-', '')}==x`), rule(b, 'eq', 'x'));
});

test('AND binds tighter than OR and groups flatten', () => {
  assert.deepEqual(parseRsql(definition, 'status==Open and priority==High or vip==true'), {
    kind: 'any',
    nodes: [
      { kind: 'all', nodes: [rule(fields.status, 'eq', id(101)), rule(fields.priority, 'eq', id(105))] },
      rule(fields.vip, 'eq', 'true'),
    ],
  });
  assert.deepEqual(parseRsql(definition, 'status==Open;(priority==High,priority==Urgent)'), {
    kind: 'all',
    nodes: [
      rule(fields.status, 'eq', id(101)),
      { kind: 'any', nodes: [rule(fields.priority, 'eq', id(105)), rule(fields.priority, 'eq', id(106))] },
    ],
  });
  assert.deepEqual(parseRsql(definition, 'subject==a;subject==b;subject==c'), {
    kind: 'all',
    nodes: ['a', 'b', 'c'].map(value => rule(fields.subject, 'eq', value)),
  });
  assert.deepEqual(parseRsql(definition, '((subject==a))'), rule(fields.subject, 'eq', 'a'));
});

const accepted = [
  ['subject=="payment failed"', rule(fields.subject, 'eq', 'payment failed')],
  ["subject=='it\\'s'", rule(fields.subject, 'eq', "it's")],
  ['subject=contains="50%_off"', rule(fields.subject, 'contains', '50%_off')],
  ['subject==*', rule(fields.subject, 'eq', '*')],
  ['subject==null', rule(fields.subject, 'eq', 'null')],
  ['subject=="a;b,c"', rule(fields.subject, 'eq', 'a;b,c')],
  ['subject==Café', rule(fields.subject, 'eq', 'Café')],
  ['subject=="日本語"', rule(fields.subject, 'eq', '日本語')],
  ['subject=in=(a,"b c")', rule(fields.subject, 'in', 'a', 'b c')],
  ['subject=out=(a)', rule(fields.subject, 'out', 'a')],
  ['subject=isnull=true', rule(fields.subject, 'empty')],
  ['subject=isnull=FALSE', rule(fields.subject, 'not-empty')],
  ['status==open', rule(fields.status, 'eq', id(101))],
  [`status==${id(102)}`, rule(fields.status, 'eq', id(102))],
  ['status!=Closed', rule(fields.status, 'ne', id(103))],
  ['priority=in=(High,Urgent)', rule(fields.priority, 'in', id(105), id(106))],
  ['created_at>=2026-10-01T00:00:00Z', rule(fields.created, 'gte', '2026-10-01T00:00:00.000Z')],
  ['created_at<2026-10-01T02:00:00+02:00', rule(fields.created, 'lt', '2026-10-01T00:00:00.000Z')],
  ['created_at=ge=2026-10-01T00:00:00Z', rule(fields.created, 'gte', '2026-10-01T00:00:00.000Z')],
  ['due_date=le=2026-12-31', rule(fields.due, 'lte', '2026-12-31')],
  ['due_date=isnull=true', rule(fields.due, 'empty')],
  ['amount>-12.50', rule(fields.amount, 'gt', '-12.50')],
  ['amount=lt=100', rule(fields.amount, 'lt', '100')],
  ['amount=in=(1,2.5)', rule(fields.amount, 'in', '1', '2.5')],
  ['vip==TRUE', rule(fields.vip, 'eq', 'true')],
  ['tags=in=(Billing)', rule(fields.tags, 'in', id(107))],
  ['tags=out=(Bug,Billing)', rule(fields.tags, 'out', id(108), id(107))],
  ['tags=isnull=true', rule(fields.tags, 'empty')],
  [`customer=in=(${id(60)})`, rule(fields.customer, 'in', id(60))],
  [`customer=out=(${id(60).toUpperCase()})`, rule(fields.customer, 'out', id(60))],
  ['attachments=isnull=false', rule(fields.files, 'not-empty')],
  [`F_${fields.subject.id.replaceAll('-', '').toUpperCase()}==x`, rule(fields.subject, 'eq', 'x')],
  ['SUBJECT==x', rule(fields.subject, 'eq', 'x')],
];
for (const [text, expected] of accepted)
  test(`accepts ${text}`, () => assert.deepEqual(parseRsql(definition, text), expected));

const rejected = [
  ['status==', 'syntax'],
  ['status==Open and', 'syntax'],
  ['(status==Open', 'syntax'],
  ['status=Open', 'syntax'],
  ['status==Open;;', 'syntax'],
  ['unknown==1', 'unknown-field'],
  ['customer.name==Acme', 'unknown-field'],
  ['subject=like=x', 'unsupported-operator'],
  ['subject=regex=".*"', 'unsupported-operator'],
  ['subject>a', 'unsupported-operator'],
  ['status>Open', 'unsupported-operator'],
  ['vip<true', 'unsupported-operator'],
  ['tags==Billing', 'unsupported-operator'],
  ['attachments==x', 'unsupported-operator'],
  ['customer==Acme', 'unsupported-operator'],
  ['status==Escalated', 'unknown-option'],
  ['amount==ten', 'invalid-value'],
  ['amount==1.123', 'invalid-value'],
  ['amount==0012', 'invalid-value'],
  ['due_date==2026-02-30', 'invalid-value'],
  ['created_at>=2026-10-01', 'invalid-value'],
  ['vip==yes', 'invalid-value'],
  ['subject=isnull=maybe', 'invalid-value'],
  ['subject==(a,b)', 'invalid-value'],
  ['customer=in=(Acme)', 'unresolved-reference'],
  [`subject=in=(${Array.from({ length: 51 }, (_, i) => `v${i}`).join(',')})`, 'too-many-values'],
  [Array.from({ length: 33 }, (_, i) => `subject==v${i}`).join(';'), 'too-many-rules'],
  ['(((((subject==a,subject==b);subject==c),subject==d);subject==e),subject==f);subject==g', 'too-deep'],
  [`subject=="${'x'.repeat(1001)}"`, 'invalid-value'],
  ['x'.repeat(queryLimits.rsqlCharacters + 1), 'too-large'],
];
for (const [text, code] of rejected)
  test(`rejects ${text.slice(0, 60)} as ${code}`, () =>
    assert.ok(issueCodes(() => parseRsql(definition, text)).includes(code)));

test('ambiguous and UUID-shaped option labels never guess', () => {
  const duplicate = { ...fields.status, options: [option(1, 'Open'), option(2, 'open')] };
  assert.deepEqual(
    issueCodes(() => parseRsql({ fields: [duplicate] }, 'status==Open')),
    ['ambiguous-option'],
  );
  const confusing = { ...fields.status, options: [option(1, id(102)), option(2, 'Other')] };
  assert.deepEqual(
    issueCodes(() => parseRsql({ fields: [confusing] }, `status==${id(102)}`)),
    ['ambiguous-option'],
  );
  assert.equal(printRsql({ fields: [confusing] }, rule(confusing, 'eq', id(101))), `status==${id(101)}`);
});

test('linked-row names resolve only through the supplied authorized lookup', () => {
  const references = { [fields.customer.id]: { acme: id(60) } };
  assert.deepEqual(parseRsql(definition, 'customer=in=(Acme)', references), rule(fields.customer, 'in', id(60)));
  assert.deepEqual(
    issueCodes(() => parseRsql(definition, 'customer=in=(Globex)', references)),
    ['unresolved-reference'],
  );
});

test('deeply nested input fails with a limit error, not a stack overflow', () => {
  const deep = `${'('.repeat(3000)}subject==a${')'.repeat(3000)}`;
  assert.deepEqual(parseRsql(definition, deep), rule(fields.subject, 'eq', 'a'));
  let alternating = 'subject==a';
  for (let i = 0; i < 400; i += 1) alternating = `subject==b${i % 2 ? ';' : ','}(${alternating})`;
  assert.ok(
    issueCodes(() => parseRsql(definition, alternating.slice(0, queryLimits.rsqlCharacters))).some(code =>
      ['too-deep', 'too-many-rules', 'syntax'].includes(code),
    ),
  );
});

test('printing round-trips every supported operation to the same tree', () => {
  for (const [text, expected] of accepted) {
    const printed = printRsql(definition, expected);
    assert.deepEqual(parseRsql(definition, printed), expected, `${text} printed as ${printed}`);
  }
  const tree = parseRsql(
    definition,
    'status==Open and (priority==High or priority==Urgent) and subject=contains="payment failed"',
  );
  assert.equal(
    printRsql(definition, tree),
    'status==Open and (priority==High or priority==Urgent) and subject=contains="payment failed"',
  );
});

test('structured trees validate like RSQL and resolve option labels', () => {
  assert.deepEqual(
    validateWhere(definition, { kind: 'all', nodes: [rule(fields.status, 'eq', 'Open'), { kind: 'any', nodes: [] }] }),
    rule(fields.status, 'eq', id(101)),
  );
  assert.deepEqual(
    issueCodes(() => validateWhere(definition, rule(fields.status, 'in'))),
    ['invalid-value'],
  );
  assert.deepEqual(
    issueCodes(() => validateWhere(definition, rule(fields.subject, 'empty', 'x'))),
    ['invalid-value'],
  );
  assert.deepEqual(
    issueCodes(() => validateWhere(definition, rule(fields.subject, 'eq', 'a', 'b'))),
    ['invalid-value'],
  );
  assert.deepEqual(
    issueCodes(() => validateWhere(definition, rule({ id: id(99) }, 'eq', 'a'))),
    ['unknown-field'],
  );
  assert.equal(simplifyWhere({ kind: 'any', nodes: [{ kind: 'all', nodes: [] }] }), null);
});

test('requests accept RSQL or a structured query, never both, and check options', () => {
  const viaRsql = normalizeQueryRequest(definition, {
    rsql: 'status==Open',
    options: { version: 2, mode: 'rows', sort: [{ fieldId: fields.created.id, direction: 'desc' }] },
  });
  const viaTree = normalizeQueryRequest(definition, {
    query: {
      version: 2,
      mode: 'rows',
      where: rule(fields.status, 'eq', 'Open'),
      sort: [{ fieldId: fields.created.id, direction: 'desc' }],
    },
  });
  assert.deepEqual(viaRsql, viaTree);
  assert.equal(viaRsql.rsql, 'status==Open');
  assert.throws(() => normalizeQueryRequest(definition, { rsql: 'status==Open', query: { version: 2, mode: 'rows' } }));
  assert.deepEqual(
    issueCodes(() =>
      normalizeQueryRequest(definition, {
        rsql: '',
        options: { version: 2, mode: 'rows', sort: [{ fieldId: fields.tags.id }] },
      }),
    ),
    ['invalid-option'],
  );
  assert.deepEqual(
    issueCodes(() =>
      normalizeQueryRequest(definition, {
        rsql: '',
        options: { version: 2, mode: 'summary', groupBy: [fields.customer.id] },
      }),
    ),
    ['invalid-option'],
  );
  assert.deepEqual(
    issueCodes(() =>
      normalizeQueryRequest(definition, {
        rsql: '',
        options: { version: 2, mode: 'summary', metrics: [{ fn: 'sum', fieldId: fields.subject.id }] },
      }),
    ),
    ['invalid-option'],
  );
  assert.deepEqual(
    issueCodes(() =>
      normalizeQueryRequest(definition, {
        rsql: '',
        options: {
          version: 2,
          mode: 'summary',
          metrics: [{ fn: 'count' }],
          order: { kind: 'metric', index: 2, direction: 'desc' },
        },
      }),
    ),
    ['invalid-option'],
  );
  assert.throws(() =>
    normalizeQueryRequest(definition, {
      rsql: '',
      options: { version: 2, mode: 'rows', sort: [1, 2, 3, 4].map(n => ({ fieldId: id(n) })) },
    }),
  );
  const summary = normalizeQueryRequest(definition, {
    rsql: '',
    options: {
      version: 2,
      mode: 'summary',
      groupBy: [fields.status.id],
      metrics: [{ fn: 'count' }, { fn: 'sum', fieldId: fields.amount.id }],
    },
  });
  assert.equal(summary.query.mode, 'summary');
  assert.equal(summary.query.where, null);
});

test('legacy flat filters keep their AND meaning', () => {
  assert.deepEqual(
    legacyWhere([
      { fieldId: fields.subject.id, op: 'eq', value: 'a' },
      { fieldId: fields.due.id, op: 'is-null' },
      { fieldId: fields.vip.id, op: 'eq', value: true },
    ]),
    {
      kind: 'all',
      nodes: [rule(fields.subject, 'eq', 'a'), rule(fields.due, 'empty'), rule(fields.vip, 'eq', 'true')],
    },
  );
  assert.equal(legacyWhere([]), null);
});

test('descriptions use labels for people', () => {
  const tree = parseRsql(definition, `status==Open and (priority=in=(High,Urgent) or customer=in=(${id(60)}))`);
  assert.equal(
    describeWhere(definition, tree, { [id(60)]: 'Acme' }),
    'Status is Open and (Priority is any of High, Urgent or Customer is any of Acme)',
  );
  assert.equal(describeWhere(definition, null), 'All rows');
});
