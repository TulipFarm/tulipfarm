import { z } from 'zod';
import { avatarImageSchema } from './contracts.ts';

export const workspaceSettingsSchema = z.object({
  workspaceId: z.uuid(),
  name: z.string(),
  slug: z.string(),
  icon: avatarImageSchema.nullable().default(null),
  revision: z.number().int().nonnegative(),
  canManage: z.boolean(),
});
const commandFields = { requestId: z.uuid(), expectedRevision: z.number().int().nonnegative() };
export const renameWorkspaceSchema = z.strictObject({ ...commandFields, name: z.string().trim().min(1).max(80) });
export const setWorkspaceIconSchema = z.strictObject({ ...commandFields, icon: avatarImageSchema.nullable() });
export const deleteWorkspaceSchema = z.strictObject({
  ...commandFields,
  confirmationName: z.string().min(1).max(80),
  acknowledgeRetainedData: z.literal(true),
});
export const renameWorkspaceReceiptSchema = z.object({
  requestId: z.uuid(),
  name: z.string(),
  revision: z.number().int().min(1),
});
export const setWorkspaceIconReceiptSchema = z.object({
  requestId: z.uuid(),
  icon: avatarImageSchema.nullable(),
  revision: z.number().int().min(1),
});
export const deleteWorkspaceReceiptSchema = z.object({
  requestId: z.uuid(),
  workspaceId: z.uuid(),
  status: z.literal('deleted'),
  dataDisposition: z.literal('retained'),
});
export const workspaceSettingsReceiptSchema = z.discriminatedUnion('kind', [
  renameWorkspaceReceiptSchema.extend({ kind: z.literal('rename') }),
  setWorkspaceIconReceiptSchema.extend({ kind: z.literal('icon') }),
  deleteWorkspaceReceiptSchema.extend({ kind: z.literal('delete') }),
]);
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;
export type RenameWorkspace = z.infer<typeof renameWorkspaceSchema>;
export type DeleteWorkspace = z.infer<typeof deleteWorkspaceSchema>;
export type WorkspaceSettingsReceipt = z.infer<typeof workspaceSettingsReceiptSchema>;
