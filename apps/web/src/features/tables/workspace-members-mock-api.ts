import { z } from 'zod';
import {
  definitionSchema,
  valuesSchema,
  type TableDefinition,
  type TableValue,
  type TableValues,
} from '@tulipfarm/tables/definition';
import { normalizeQueryRequest, queryCapabilities, type QueryNode } from '@tulipfarm/tables/query';
import {
  addedMemberReferences,
  manualWorkspaceMemberValues,
  workspaceMemberRestoredValues,
  workspaceMembersDefinition,
  workspaceMemberFields as fields,
  workspaceMemberAccess as access,
  workspaceMemberStateSchema,
} from '@tulipfarm/tables/workspace-members';
import type { RecordHistoryEntry } from './api';

const id = (n: number) => `87654321-4321-4321-8321-${String(n).padStart(12, '0')}`;
const revision = 'b'.repeat(40);
const date = '2026-10-14T00:00:00Z';
type Row = { id: string; token: string; values: Record<string, TableValue> };
type MockTable = { definition: TableDefinition; records: Row[]; systemKind?: 'workspace-members' };
const writeSchema = z.object({
  kind: z.enum(['create', 'update', 'delete', 'restore', 'member-photo', 'member-repair']),
  requestId: z.uuid(),
  tableId: z.uuid(),
  revision: z.string(),
  recordId: z.uuid(),
  expectedToken: z.uuid().optional(),
  values: valuesSchema.optional(),
  image: z.string().nullable().optional(),
  historyId: z.uuid().optional(),
  version: z.enum(['before', 'after']).default('after'),
});

export function createMemberTablesMock(
  workspaceId: string,
  scenario?: string | null,
  extraMembers: { name: string; contactEmail: string }[] = [],
) {
  const memberTableId = id(10),
    ticketTableId = id(11),
    me = id(20);
  const custom = id(12),
    title = id(13),
    assignee = id(14),
    reviewers = id(15);
  const memberDefinition = definitionSchema.parse({
    ...workspaceMembersDefinition(memberTableId, id(2)),
    fields: [
      ...workspaceMembersDefinition(memberTableId, id(2)).fields,
      { id: custom, label: 'Workday ID', kind: 'text', required: false, maxLength: 80 },
    ],
  });
  const names = ['Mira Patel', 'Sam Lee', 'Maya Rao', 'Alex Morgan', 'Theo Park'];
  const memberRows = names.map((name, index): Row => ({
    id: id(20 + index),
    token: crypto.randomUUID(),
    values: valuesSchema.parse({
      ...manualWorkspaceMemberValues({ name, contactEmail: `${name.toLowerCase().replace(' ', '.')}@example.test` }),
      [custom]: { kind: 'text', value: `WD-${101 + index}` },
      ...(index < 2
        ? {
            [fields.accountEmail]: { kind: 'text', value: `${name.toLowerCase().replace(' ', '.')}@example.test` },
            [fields.access]: { kind: 'single-select', optionId: access.active },
          }
        : {}),
      ...(index === 4 ? { [fields.active]: { kind: 'boolean', value: false } } : {}),
    }),
  }));
  const readOnly = scenario === 'reader';
  const states = new Map(
    memberRows.map((row, index) => [
      row.id,
      workspaceMemberStateSchema.parse({
        id: row.id,
        token: row.token,
        materialized: true,
        accountLinked: index < 2,
        profile: index === 1 ? 'failed' : index === 0 ? 'current' : 'manual',
        canRetry: index < 2 && (!readOnly || index === 0),
        canRepair: false,
        canEditProfile: index >= 2 && !readOnly,
      }),
    ]),
  );
  for (const [offset, profile] of [
    [25, 'pending'],
    [26, 'repair-required'],
  ] as const) {
    states.set(
      id(offset),
      workspaceMemberStateSchema.parse({
        id: id(offset),
        token: crypto.randomUUID(),
        materialized: false,
        accountLinked: profile === 'pending',
        profile,
        canRetry: profile === 'pending' && !readOnly,
        canRepair: profile === 'repair-required' && !readOnly,
        canEditProfile: false,
      }),
    );
  }
  for (const [index, profile] of extraMembers.entries()) {
    const row = { id: id(100 + index), token: crypto.randomUUID(), values: manualWorkspaceMemberValues(profile) };
    memberRows.push(row);
    states.set(
      row.id,
      workspaceMemberStateSchema.parse({
        id: row.id,
        token: row.token,
        materialized: true,
        accountLinked: false,
        profile: 'manual',
        canRetry: false,
        canRepair: false,
        canEditProfile: !readOnly,
      }),
    );
  }
  const tickets = definitionSchema.parse({
    formatVersion: 2,
    id: ticketTableId,
    owningTeamId: id(2),
    label: 'Tickets',
    uniqueKeys: [],
    fields: [
      { id: title, label: 'Title', kind: 'text', required: true, maxLength: 255 },
      ...[
        [assignee, 'Assignee', 'one'],
        [reviewers, 'Reviewers', 'many'],
      ].map(([fieldId, label, cardinality]) => ({
        id: fieldId,
        label,
        cardinality,
        kind: 'relationship',
        required: false,
        targetTableId: memberTableId,
        inverseCardinality: 'many',
        reverse: null,
        onDelete: 'restrict',
      })),
    ],
  });
  const tables = new Map<string, MockTable>([
    [memberTableId, { definition: memberDefinition, records: memberRows, systemKind: 'workspace-members' }],
    [
      ticketTableId,
      {
        definition: tickets,
        records: ['Review the October rota', 'Replace the front-desk tablet', 'Update the welcome pack'].map(
          (name, index) => ({
            id: id(40 + index),
            token: crypto.randomUUID(),
            values: valuesSchema.parse({
              [title]: { kind: 'text', value: name },
              [assignee]: { kind: 'relationship', tableId: memberTableId, recordIds: [index === 0 ? me : id(22)] },
              [reviewers]: { kind: 'relationship', tableId: memberTableId, recordIds: [me, id(21)] },
            }),
          }),
        ),
      },
    ],
  ]);
  const receipts = new Map<
    string,
    { input: string; result: { kind: 'available'; id: string; token: string; values: TableValues | null } }
  >();
  const images = new Map<string, string>();
  const histories = new Map<string, RecordHistoryEntry[]>();
  function recordHistory(
    tableId: string,
    previous: Row | undefined,
    next: Row,
    operation: RecordHistoryEntry['operation'],
    actor: unknown = { kind: 'human', userId: id(3) },
  ) {
    const key = `${tableId}/${next.id}`;
    const values = operation === 'delete' ? (previous?.values ?? null) : next.values;
    const entry: RecordHistoryEntry = {
      id: crypto.randomUUID(),
      token: next.token,
      actor,
      operation,
      outcome: 'applied',
      created_at: new Date().toISOString(),
      recoverable_until: new Date(Date.now() + 30 * 86400000).toISOString(),
      field_ids: [...new Set([...Object.keys(previous?.values ?? {}), ...Object.keys(next.values)])].filter(
        fieldId =>
          operation === 'delete' || JSON.stringify(previous?.values[fieldId]) !== JSON.stringify(next.values[fieldId]),
      ),
      values: structuredClone(values),
      before_values: structuredClone(previous?.values ?? null),
      unavailable_file_ids: [],
    };
    histories.set(key, [entry, ...(histories.get(key) ?? [])]);
  }
  const currentMe = memberRows[0]!;
  const oldImage = 'a'.repeat(64);
  images.set(
    oldImage,
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTH0AAAAASUVORK5CYII=',
  );
  const oldMe: Row = {
    ...currentMe,
    values: {
      ...currentMe.values,
      [fields.name]: { kind: 'text', value: 'Mira Sharma' },
      [fields.photo]: {
        kind: 'text',
        value: `/v1/workspaces/${workspaceId}/workspace-members/${me}/photos/${oldImage}`,
      },
      [fields.accountEmail]: { kind: 'text', value: 'mira.sharma@example.test' },
      [fields.access]: { kind: 'single-select', optionId: access.none },
      [custom]: { kind: 'text', value: 'WD-001' },
    },
  };
  const editedMe: Row = { ...oldMe, values: { ...oldMe.values, [custom]: currentMe.values[custom] ?? null } };
  recordHistory(memberTableId, oldMe, editedMe, 'update');
  recordHistory(memberTableId, editedMe, currentMe, 'update', {
    kind: 'system',
    operation: 'workspace-member-profile',
  });
  let readsFailed = 0;
  const scalar = (row: Row, fieldId: string) => {
    const value = row.values[fieldId];
    return value && 'value' in value ? String(value.value) : value?.kind === 'single-select' ? value.optionId : '';
  };
  const matches = (row: Row, where: QueryNode | null): boolean => {
    if (!where) return true;
    if (where.kind !== 'rule')
      return where.kind === 'all'
        ? where.nodes.every(node => matches(row, node))
        : where.nodes.some(node => matches(row, node));
    const value = row.values[where.fieldId],
      plain = scalar(row, where.fieldId);
    const choices = value?.kind === 'relationship' ? value.recordIds : [plain];
    if (where.op === 'is-me')
      return value?.kind === 'relationship' && value.recordIds.some(memberId => memberId === me);
    if (where.op === 'empty') return value == null;
    if (where.op === 'not-empty') return value != null;
    if (where.op === 'contains') return plain.toLowerCase().includes((where.values[0] ?? '').toLowerCase());
    const contains = where.values.some(item => choices.some(choice => choice === item));
    return where.op === 'out' || where.op === 'ne' ? !contains : contains;
  };
  const updateState = (row: Row) => {
    const old = states.get(row.id);
    states.set(
      row.id,
      workspaceMemberStateSchema.parse(
        old
          ? { ...old, token: row.token, materialized: true }
          : {
              id: row.id,
              token: row.token,
              materialized: true,
              accountLinked: false,
              profile: 'manual',
              canRetry: false,
              canRepair: false,
              canEditProfile: !readOnly,
            },
      ),
    );
  };
  const root = `/v1/workspaces/${workspaceId}`;
  async function handle(url: URL, method: string, body: unknown): Promise<Response | null> {
    const path = url.pathname;
    if (path === `${root}/workspace-members` && method === 'GET') {
      if (scenario === 'status-error' && readsFailed++ === 0)
        return Response.json({ error: 'member-unavailable' }, { status: 503 });
      const all = [...states.values()];
      const wanted = url.searchParams.get('ids')?.split(',');
      const attention = url.searchParams.get('attention') === 'true';
      const members = all.filter(
        member =>
          (!wanted || wanted.includes(member.id)) &&
          (!attention || ['pending', 'failed', 'repair-required'].includes(member.profile)),
      );
      return Response.json({
        tableId: memberTableId,
        revision,
        members,
        nextCursor: null,
        sync: {
          pending: all.filter(member => member.profile === 'pending').length,
          failed: all.filter(member => member.profile === 'failed').length,
          repairRequired: all.filter(member => member.profile === 'repair-required').length,
        },
      });
    }
    const profile = new RegExp(`^${root}/workspace-members/([^/]+)(/profile-sync/retry|/photos/([a-f0-9]{64}))?$`).exec(
      path,
    );
    if (profile?.[2] === '/profile-sync/retry' && method === 'POST') {
      const state = states.get(profile[1]!);
      if (!state?.canRetry) return Response.json({ error: 'member-not-found' }, { status: 404 });
      state.profile = 'pending';
      globalThis.setTimeout(() => {
        if (!state.materialized) {
          const row = {
            id: state.id,
            token: crypto.randomUUID(),
            values: manualWorkspaceMemberValues({ name: 'New colleague' }),
          };
          row.values[fields.access] = { kind: 'single-select', optionId: access.active };
          memberRows.push(row);
          state.token = row.token;
          state.materialized = true;
        }
        state.profile = 'current';
      }, 700);
      return Response.json({ status: 'pending' });
    }
    if (profile?.[3] && method === 'GET') {
      const image = images.get(profile[3]);
      if (!image) return Response.json({ error: 'member-not-found' }, { status: 404 });
      const [header, bytes] = image.split(',');
      return new Response(
        Uint8Array.from(atob(bytes!), character => character.charCodeAt(0)),
        { headers: { 'Content-Type': header!.slice(5, header!.indexOf(';')), 'Cache-Control': 'private, no-store' } },
      );
    }
    if (path === `${root}/tables` && method === 'GET')
      return Response.json({
        tables: [...tables].map(([tableId, table]) => ({
          id: tableId,
          revision,
          definition: table.definition,
          systemKind: table.systemKind,
          appliedAt: date,
          recordCount: String(table.records.length),
        })),
        nextCursor: null,
      });
    const route = new RegExp(`^${root}/tables/([^/]+)(.*)$`).exec(path);
    const table = tables.get(route?.[1] ?? (profile ? memberTableId : ''));
    if (!table) return null;
    const tableId = table.definition.id,
      suffix = route?.[2];
    if (method === 'POST' && (suffix === '/rows' || (profile && !profile[2]))) {
      if (readOnly) return Response.json({ error: 'member-not-found' }, { status: 404 });
      const input = writeSchema.parse(body),
        serialized = JSON.stringify(body),
        receipt = receipts.get(input.requestId);
      if (receipt)
        return receipt.input === serialized
          ? Response.json(receipt.result)
          : Response.json({ error: 'request-mismatch' }, { status: 409 });
      const index = table.records.findIndex(row => row.id === input.recordId),
        previous = table.records[index];
      if (input.kind !== 'create' && input.expectedToken !== (previous?.token ?? states.get(input.recordId)?.token))
        return Response.json({ error: 'stale-record' }, { status: 409 });
      let values = valuesSchema.parse({ ...previous?.values, ...input.values });
      if (input.kind === 'restore') {
        const entry = histories.get(`${tableId}/${input.recordId}`)?.find(entry => entry.id === input.historyId);
        const historical = input.version === 'before' ? entry?.before_values : entry?.values;
        if (!entry || !historical || Date.parse(entry.recoverable_until) <= Date.now())
          return Response.json({ error: 'recovery-expired' }, { status: 409 });
        values = valuesSchema.parse(
          tableId === memberTableId
            ? workspaceMemberRestoredValues(
                historical,
                previous?.values ?? null,
                states.get(input.recordId)?.accountLinked ?? false,
              )
            : historical,
        );
      }
      if (input.kind === 'member-photo') {
        if (!states.get(input.recordId)?.canEditProfile)
          return Response.json({ error: 'member-field-protected' }, { status: 409 });
        const digest = crypto.randomUUID().replaceAll('-', '').repeat(2);
        if (input.image) images.set(digest, input.image);
        values[fields.photo] = input.image
          ? { kind: 'text', value: `${root}/workspace-members/${input.recordId}/photos/${digest}` }
          : null;
      }
      if (input.kind === 'member-repair') {
        if (!states.get(input.recordId)?.canRepair)
          return Response.json({ error: 'member-link-conflict' }, { status: 409 });
        states.delete(input.recordId);
      }
      const additions = addedMemberReferences(
        memberTableId,
        previous?.values ?? null,
        input.kind === 'delete' ? null : values,
      );
      if (
        additions.some(link => {
          const active = memberRows.find(row => row.id === link.memberId)?.values[fields.active];
          return active?.kind !== 'boolean' || !active.value;
        })
      )
        return Response.json({ error: 'member-inactive' }, { status: 409 });
      const next = { id: input.recordId, token: crypto.randomUUID(), values };
      recordHistory(
        tableId,
        previous,
        next,
        input.kind === 'member-photo' ? 'update' : input.kind === 'member-repair' ? 'create' : input.kind,
      );
      if (input.kind === 'delete') {
        if (index >= 0) table.records.splice(index, 1);
        states.delete(next.id);
      } else {
        if (previous) table.records[index] = next;
        else table.records.push(next);
        if (tableId === memberTableId) updateState(next);
      }
      const result = {
        kind: 'available' as const,
        id: next.id,
        token: next.token,
        values: input.kind === 'delete' ? null : next.values,
      };
      receipts.set(input.requestId, { input: serialized, result });
      return Response.json(result);
    }
    if (suffix?.startsWith('/requests/')) {
      const receipt = receipts.get(suffix.slice('/requests/'.length));
      return Response.json(receipt ? { status: 'applied', result: receipt.result } : { status: 'unknown' });
    }
    if (!suffix && method === 'GET')
      return Response.json({
        id: tableId,
        systemKind: table.systemKind,
        saved: null,
        applied: { revision, definition: table.definition, appliedAt: date },
        rowPermissions: { create: !readOnly, update: !readOnly, delete: !readOnly },
      });
    if (suffix === '/query-capabilities')
      return Response.json({ tableId, revision, ...queryCapabilities(table.definition, memberTableId) });
    if ((suffix === '/query' || suffix === '/query/validate') && method === 'POST') {
      if (scenario === 'rows-error' && readsFailed++ === 0)
        return Response.json({ error: 'workspace-unavailable' }, { status: 503 });
      if (scenario === 'loading') await new Promise(resolve => globalThis.setTimeout(resolve, 1500));
      const request = z.object({ request: z.unknown() }).parse(body).request;
      const normalized = normalizeQueryRequest(table.definition, request);
      const references = Object.fromEntries(
        memberRows.map(row => {
          const name = row.values[fields.name];
          return [row.id, name?.kind === 'text' ? name.value : 'Member'];
        }),
      );
      if (suffix === '/query/validate') return Response.json({ ...normalized, references });
      const query = normalized.query;
      const matching = table.records.filter(
        row =>
          matches(row, query.where) &&
          (!query.search ||
            Object.values(row.values).some(
              value => value?.kind === 'text' && value.value.toLowerCase().includes(query.search!.toLowerCase()),
            )),
      );
      if (query.mode === 'summary') {
        const groups = new Map<string, { keys: (string | null)[]; count: number }>();
        if (!query.groupBy.length) groups.set('[]', { keys: [], count: 0 });
        for (const row of matching) {
          const keys = query.groupBy.map(fieldId => scalar(row, fieldId) || null),
            key = JSON.stringify(keys);
          const group = groups.get(key) ?? { keys, count: 0 };
          group.count++;
          groups.set(key, group);
        }
        return Response.json({
          ...normalized,
          references,
          mode: 'summary',
          groups: [...groups.values()].map(group => ({
            keys: group.keys,
            values: query.metrics.map(() => String(group.count)),
          })),
          groupCount: String(groups.size),
          nextCursor: null,
        });
      }
      const first = query.sort[0];
      if (first)
        matching.sort(
          (left, right) =>
            scalar(left, first.fieldId).localeCompare(scalar(right, first.fieldId)) *
            (first.direction === 'desc' ? -1 : 1),
        );
      const offset = Number(query.after ?? 0),
        records = matching.slice(offset, offset + query.limit);
      return Response.json({
        ...normalized,
        references,
        mode: 'rows',
        records,
        total: String(matching.length),
        nextCursor: offset + records.length < matching.length ? String(offset + records.length) : null,
      });
    }
    if (suffix === '/rows' && method === 'GET') {
      const ids = url.searchParams.get('ids')?.split(',');
      return Response.json(table.records.filter(row => !ids || ids.includes(row.id)));
    }
    if (suffix === '/rows/page') {
      const search = url.searchParams.get('search')?.toLowerCase();
      const activeOnly = url.searchParams.has('filters');
      const records = table.records.filter(row => {
        const active = row.values[fields.active];
        return (
          (!search ||
            Object.values(row.values).some(
              value => value?.kind === 'text' && value.value.toLowerCase().includes(search),
            )) &&
          (!activeOnly || (active?.kind === 'boolean' && active.value))
        );
      });
      return Response.json({ records, total: String(records.length), nextCursor: null });
    }
    if (suffix === '/schema-history') return Response.json({ entries: [], nextCursor: null });
    if (suffix === '/deleted-rows') return Response.json({ records: [], nextCursor: null });
    if (suffix?.endsWith('/reverse-fields')) return Response.json({ fields: [], nextCursor: null });
    const rowPath = /^\/rows\/([^/]+)(\/history)?$/.exec(suffix ?? '');
    if (rowPath && method === 'GET') {
      if (!rowPath[2]) return Response.json(table.records.find(row => row.id === rowPath[1]) ?? null);
      const entries = histories.get(`${tableId}/${rowPath[1]}`) ?? [],
        after = url.searchParams.get('after');
      const offset = after ? entries.findIndex(entry => entry.id === after) + 1 : 0;
      if (after && offset === 0) return Response.json({ error: 'invalid-cursor' }, { status: 400 });
      return Response.json(entries.slice(offset, offset + 50));
    }
    return null;
  }
  return { handle, tables, memberTableId, ticketTableId };
}

export function createWorkspaceMembersMock(scenario?: string) {
  const workspaceId = id(1);
  const workspace = {
    id: workspaceId,
    slug: 'members-table-mock',
    name: 'People operations (local mock)',
    status: 'ready',
    createdAt: date,
    soulCommit: revision,
  };
  const mock = createMemberTablesMock(workspaceId, scenario);
  const user = { id: id(3), name: 'Mira Patel', email: 'mira.patel@example.test', image: null };
  const root = `/v1/workspaces/${workspaceId}`;
  async function handle(url: URL, method: string, body: unknown) {
    const result = await mock.handle(url, method, body);
    if (result) return result;
    const path = url.pathname;
    if (path === '/v1/user/visit') return Response.json({ firstSession: false });
    if (path === '/v1/workspaces/members-table-mock/last-used' && method === 'PUT')
      return new Response(null, { status: 204 });
    if (method === 'GET') {
      if (path === `${root}/personal-memory`) return Response.json({ content: '', revision: 0 });
      if (path === '/v1/google-workspace/availability') return Response.json({ configured: false });
      if (path === `${root}/google-workspace`) return Response.json({ status: 'disconnected' });
      if (path === `${root}/slack/status`)
        return Response.json({ state: 'disconnected', teamId: null, canManage: false, linked: false, scopes: [] });
      if (path === `${root}/github/accounts`) return Response.json({ configured: false, accounts: [] });
      if (path === `${root}/atlassian/accounts`) return Response.json({ accounts: [], providers: [] });
      if (path === `${root}/bud`)
        return Response.json({
          conversationId: null,
          onboarding: 'ineligible',
          bubblesEnabled: false,
          snoozedUntil: null,
          nudge: null,
          preferences: [],
        });
      if (path === `${root}/workspace-mcp/capabilities`) return Response.json({ enabled: false });
      if (path === `${root}/credits`)
        return Response.json({ available: 0, granted: 0, used: 0, held: 0, days: [], breakdown: [], series: [] });
    }
    if (path === '/v1/auth/get-session')
      return Response.json({ session: { id: 'members-table-mock', userId: user.id }, user });
    if (path === '/v1/workspaces') return Response.json([workspace]);
    if (path === '/v1/workspaces/members-table-mock') return Response.json(workspace);
    if (path.endsWith('/governance/me'))
      return Response.json({
        membershipId: id(4),
        role: scenario === 'reader' ? 'member' : 'admin',
        teams: [],
        capabilities: { manageGovernance: scenario !== 'reader', canLeave: false },
      });
    if (path === '/v1/account/sign-in-methods') return Response.json({ methods: ['email-link', 'google'] });
    if (path.endsWith('/governance'))
      return Response.json({
        actorMembershipId: id(4),
        members: [{ ...user, id: id(4), userId: user.id, role: 'admin' }],
        directory: [{ ...user, id: id(4) }],
        teams: [],
        tables: [],
        grants: [],
        tableTeamIds: [],
      });
    if (path.endsWith('/governance/invitations')) return Response.json({ items: [], nextCursor: null });
    return Response.json({ error: 'not-available-in-member-table-mock' }, { status: 404 });
  }
  return { handle, workspaceId, memberTableId: mock.memberTableId };
}
