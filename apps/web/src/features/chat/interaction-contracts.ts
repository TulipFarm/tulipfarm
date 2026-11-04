import { z } from 'zod';

const identity = {
  id: z.uuid(),
  turnId: z.uuid(),
  revision: z.number().int().positive(),
  prompt: z.string(),
  expiresAt: z.iso.datetime({ offset: true }),
};
export const answerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('choices'), choiceIds: z.array(z.string()) }),
]);
const secretsAnswerSchema = z.object({
  kind: z.literal('secrets'),
  status: z.enum(['provided', 'declined']),
  references: z.array(z.object({ referenceId: z.uuid(), fieldId: z.string(), name: z.string(), kind: z.string() })),
  reason: z.string().nullable(),
});
export const informationSchema = z.object({
  ...identity,
  answerSchema: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('text') }),
    z.object({ kind: z.literal('secrets'), secretRequestId: z.uuid() }),
    z.object({
      kind: z.literal('choices'),
      multiple: z.boolean(),
      allowText: z.boolean().optional(),
      choices: z
        .array(z.object({ id: z.string(), label: z.string() }))
        .min(1)
        .max(32),
    }),
  ]),
  status: z.enum(['pending', 'answered', 'expired', 'cancelled']),
  response: z
    .object({
      id: z.uuid(),
      answer: z.discriminatedUnion('kind', [...answerSchema.options, secretsAnswerSchema]),
      createdAt: z.string(),
    })
    .nullable(),
});
export const requestOutcomeSchema = z.object({
  requestId: z.uuid(),
  revision: z.number().int().positive(),
  status: z.enum(['answered', 'expired', 'cancelled']),
  responseId: z.uuid().nullable(),
});
export const approvalOutcomeSchema = z.object({
  requestId: z.uuid(),
  revision: z.number().int().positive(),
  status: z.enum(['approved', 'rejected', 'expired', 'cancelled']),
  confirmationId: z.uuid().nullable(),
});
export const approvalSchema = z.object({
  ...identity,
  action: z.object({
    kind: z.literal('table-migration'),
    migrationId: z.uuid(),
    tableId: z.uuid(),
    planDigest: z.string(),
    expectedAppliedRevision: z.string().nullable(),
    effect: z.unknown(),
  }),
  resolution: approvalOutcomeSchema.nullable(),
});
export type InformationRequest = z.infer<typeof informationSchema>;
/** A question the member answers in the chat itself, as opposed to a secrets request with its own form. */
export type QuestionRequest = Omit<InformationRequest, 'answerSchema'> & {
  answerSchema: Exclude<InformationRequest['answerSchema'], { kind: 'secrets' }>;
};
export function isQuestion(request: InformationRequest): request is QuestionRequest {
  return request.answerSchema.kind !== 'secrets';
}
export type ApprovalRequest = z.infer<typeof approvalSchema>;
export type Interaction =
  | { kind: 'information'; request: InformationRequest }
  | { kind: 'approval'; request: ApprovalRequest };
export type InteractionReference =
  | { kind: 'request'; requestId: string }
  | { kind: 'approval' | 'approval-resolution'; approvalId: string };
export type InteractionCommand =
  | {
      kind: 'answer';
      chatId: string;
      requestId: string;
      commandId: string;
      responseId: string;
      expectedRevision: number;
      answer: z.infer<typeof answerSchema>;
    }
  | { kind: 'cancel-request'; chatId: string; requestId: string; commandId: string; expectedRevision: number }
  | {
      kind: 'decide';
      chatId: string;
      requestId: string;
      commandId: string;
      expectedRevision: number;
      decision: 'approve' | 'reject' | 'cancel';
    };

export function interactionPending(value: Interaction) {
  return value.kind === 'information' ? value.request.status === 'pending' : value.request.resolution === null;
}

export const effectSchema = z.object({
  kind: z.enum(['convert', 'drop-field', 'delete-resource']),
  tableId: z.uuid(),
  fieldId: z.uuid().nullable(),
  rowCount: z.number().int().nonnegative(),
});
export function approvalDetails(request: ApprovalRequest) {
  const effect = effectSchema.safeParse(request.action.effect);
  return [
    { label: 'Action', value: 'Change table schema' },
    { label: 'Table', value: request.action.tableId },
    { label: 'Proposal', value: request.action.migrationId },
    { label: 'Plan digest', value: request.action.planDigest },
    { label: 'Applied revision', value: request.action.expectedAppliedRevision ?? 'No applied revision' },
    ...(effect.success
      ? [
          {
            label: 'Effect',
            value:
              effect.data.kind === 'drop-field'
                ? 'Remove field values'
                : effect.data.kind === 'convert'
                  ? 'Convert field values'
                  : 'Remove table rows',
          },
          { label: 'Affected rows', value: String(effect.data.rowCount) },
          ...(effect.data.fieldId ? [{ label: 'Field', value: effect.data.fieldId }] : []),
        ]
      : [{ label: 'Effect', value: 'Effect details unavailable. Do not approve an action you cannot verify.' }]),
  ];
}
