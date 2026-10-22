import { z } from 'zod';
import {
  definitionSchema,
  fieldIdSchema,
  optionIdSchema,
  recordIdSchema,
  revisionSchema,
  tableIdSchema,
  valuesSchema,
  type TableDefinition,
  type TableValues,
} from './definition.ts';

export const workspaceMemberFields = {
  name: fieldIdSchema.parse('4de907c4-8590-49f1-9c45-694e9fc36101'),
  photo: fieldIdSchema.parse('4de907c4-8590-49f1-9c45-694e9fc36102'),
  contactEmail: fieldIdSchema.parse('4de907c4-8590-49f1-9c45-694e9fc36103'),
  accountEmail: fieldIdSchema.parse('4de907c4-8590-49f1-9c45-694e9fc36104'),
  active: fieldIdSchema.parse('4de907c4-8590-49f1-9c45-694e9fc36105'),
  access: fieldIdSchema.parse('4de907c4-8590-49f1-9c45-694e9fc36106'),
} as const;

export const workspaceMemberAccess = {
  none: optionIdSchema.parse('9670894c-cb62-45ab-8171-4e118c5cce01'),
  invited: optionIdSchema.parse('9670894c-cb62-45ab-8171-4e118c5cce02'),
  active: optionIdSchema.parse('9670894c-cb62-45ab-8171-4e118c5cce03'),
} as const;

export const workspaceMemberIdSchema = recordIdSchema.brand<'WorkspaceMemberId'>();
export type WorkspaceMemberId = z.infer<typeof workspaceMemberIdSchema>;

type MemberLabelValues = Readonly<Record<string, { kind: string; value?: string | boolean } | null | undefined>>;
export function workspaceMemberLabel(values: MemberLabelValues): string {
  const fields = [workspaceMemberFields.name, workspaceMemberFields.contactEmail, workspaceMemberFields.accountEmail];
  const name = fields
    .map(id => values[id])
    .find(value => value?.kind === 'text' && typeof value.value === 'string' && value.value.trim());
  const active = values[workspaceMemberFields.active];
  return `${name?.value ?? 'Unnamed member'}${active?.kind === 'boolean' && active.value === false ? ' (inactive)' : ''}`;
}

export function workspaceMemberPreservedFields(accountLinked: boolean) {
  return accountLinked
    ? [
        workspaceMemberFields.accountEmail,
        workspaceMemberFields.access,
        workspaceMemberFields.name,
        workspaceMemberFields.photo,
      ]
    : [workspaceMemberFields.accountEmail, workspaceMemberFields.access];
}

export function workspaceMemberRestoredValues<Value>(
  historical: Readonly<Record<string, Value>>,
  current: Readonly<Record<string, Value>> | null,
  accountLinked: boolean,
) {
  const values: Record<string, Value | null | { kind: 'single-select'; optionId: typeof workspaceMemberAccess.none }> =
    { ...historical };
  for (const id of workspaceMemberPreservedFields(accountLinked)) {
    values[id] =
      current?.[id] ??
      (id === workspaceMemberFields.access ? { kind: 'single-select', optionId: workspaceMemberAccess.none } : null);
  }
  return values;
}

export const memberProfileSchema = z.strictObject({
  id: z.string().min(1),
  revision: z.string().regex(/^[1-9][0-9]{0,18}$/),
  name: z.string().max(10000),
  email: z.email().max(320),
  image: z
    .string()
    .max(45000)
    .regex(/^(?:https:\/\/\S{1,2000}|data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2})$/)
    .nullable(),
});
export type MemberProfile = z.infer<typeof memberProfileSchema>;

export const workspaceMembersRegistrationSchema = z.strictObject({
  kind: z.literal('workspace-members'),
  coreDefinition: definitionSchema,
});
export type WorkspaceMembersRegistration = z.infer<typeof workspaceMembersRegistrationSchema>;

export const workspaceMemberErrorCodeSchema = z.enum([
  'member-table-protected',
  'member-field-protected',
  'member-inactive',
  'member-unavailable',
  'member-link-conflict',
  'member-selection-required',
  'member-profile-pending',
  'member-profile-failed',
]);
export class WorkspaceMemberError extends Error {
  readonly code: z.infer<typeof workspaceMemberErrorCodeSchema>;
  readonly status: 409 | 503;
  constructor(code: z.infer<typeof workspaceMemberErrorCodeSchema>) {
    super(code);
    this.code = code;
    this.name = 'WorkspaceMemberError';
    this.status = ['member-profile-pending', 'member-profile-failed', 'member-unavailable'].includes(code) ? 503 : 409;
  }
}

export const workspaceMemberStateSchema = z.strictObject({
  id: workspaceMemberIdSchema,
  token: z.uuid(),
  materialized: z.boolean(),
  accountLinked: z.boolean(),
  profile: z.enum(['manual', 'current', 'pending', 'failed', 'repair-required']),
  canRetry: z.boolean(),
  canRepair: z.boolean(),
  canEditProfile: z.boolean(),
});
export const workspaceMembersStateSchema = z.strictObject({
  tableId: tableIdSchema,
  revision: z.string(),
  sync: z.strictObject({
    pending: z.int().nonnegative(),
    failed: z.int().nonnegative(),
    repairRequired: z.int().nonnegative(),
  }),
  members: z.array(workspaceMemberStateSchema),
  nextCursor: workspaceMemberIdSchema.nullable(),
});

const memberMutationBase = z.object({
  tableId: tableIdSchema,
  recordId: workspaceMemberIdSchema,
  revision: revisionSchema,
  expectedToken: z.uuid(),
});
export const workspaceMemberMutationSchema = z.discriminatedUnion('kind', [
  memberMutationBase
    .extend({
      kind: z.literal('member-photo'),
      image: memberProfileSchema.shape.image.refine(image => image === null || image.startsWith('data:')),
    })
    .strict(),
  memberMutationBase.extend({ kind: z.literal('member-repair'), values: valuesSchema }).strict(),
]);

export function workspaceMembersDefinition(tableId: string, owningTeamId: string): TableDefinition {
  return definitionSchema.parse({
    formatVersion: 2,
    id: tableId,
    owningTeamId,
    label: 'Workspace members',
    fields: [
      { id: workspaceMemberFields.name, label: 'Name', kind: 'text', required: true, maxLength: 10000 },
      { id: workspaceMemberFields.photo, label: 'Photo', kind: 'text', required: false, maxLength: 2048 },
      { id: workspaceMemberFields.contactEmail, label: 'Contact email', kind: 'text', required: false, maxLength: 320 },
      { id: workspaceMemberFields.accountEmail, label: 'Account email', kind: 'text', required: false, maxLength: 320 },
      { id: workspaceMemberFields.active, label: 'Active', kind: 'boolean', required: true },
      {
        id: workspaceMemberFields.access,
        label: 'Workspace access',
        kind: 'single-select',
        required: true,
        options: [
          { id: workspaceMemberAccess.none, label: 'No access', retired: false },
          { id: workspaceMemberAccess.invited, label: 'Invited', retired: false },
          { id: workspaceMemberAccess.active, label: 'Has access', retired: false },
        ],
      },
    ],
    uniqueKeys: [],
  });
}

export function requireWorkspaceMembersDefinition(registration: WorkspaceMembersRegistration, input: TableDefinition) {
  const core = definitionSchema.parse(registration.coreDefinition);
  const next = definitionSchema.parse(input);
  if (core.id !== next.id || core.owningTeamId !== next.owningTeamId || core.label !== next.label) {
    throw new WorkspaceMemberError('member-table-protected');
  }
  for (const field of core.fields) {
    if (JSON.stringify(field) !== JSON.stringify(next.fields.find(candidate => candidate.id === field.id))) {
      throw new WorkspaceMemberError('member-field-protected');
    }
  }
  // A custom uniqueness rule must not prevent account-owned profile updates.
  const protectedIds = new Set(core.fields.map(field => field.id));
  if (next.uniqueKeys.some(key => key.fieldIds.some(id => protectedIds.has(id)))) {
    throw new WorkspaceMemberError('member-field-protected');
  }
}

export function manualWorkspaceMemberValues(input: { name: string; contactEmail?: string | null }): TableValues {
  const name = z.string().trim().min(1).max(10000).parse(input.name);
  const email = z
    .email()
    .max(320)
    .nullable()
    .parse(input.contactEmail ?? null);
  return {
    [workspaceMemberFields.name]: { kind: 'text', value: name },
    [workspaceMemberFields.photo]: null,
    [workspaceMemberFields.contactEmail]: email === null ? null : { kind: 'text', value: email },
    [workspaceMemberFields.accountEmail]: null,
    [workspaceMemberFields.active]: { kind: 'boolean', value: true },
    [workspaceMemberFields.access]: { kind: 'single-select', optionId: workspaceMemberAccess.none },
  };
}

export function addedMemberReferences(memberTableId: string, before: TableValues | null, after: TableValues | null) {
  const tableId = tableIdSchema.parse(memberTableId);
  return Object.entries(after ?? {}).flatMap(([fieldId, value]) => {
    if (value?.kind !== 'relationship' || value.tableId !== tableId) return [];
    const previous = before?.[fieldIdSchema.parse(fieldId)];
    const existing = new Set(
      previous?.kind === 'relationship' && previous.tableId === tableId ? previous.recordIds : [],
    );
    return value.recordIds
      .filter(id => !existing.has(id))
      .map(id => ({
        fieldId: fieldIdSchema.parse(fieldId),
        tableId,
        memberId: workspaceMemberIdSchema.parse(id),
      }));
  });
}
