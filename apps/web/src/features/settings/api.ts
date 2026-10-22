import { z } from 'zod';
import {
  workspaceSettingsSchema,
  renameWorkspaceSchema,
  setWorkspaceIconSchema,
  deleteWorkspaceSchema,
  renameWorkspaceReceiptSchema,
  setWorkspaceIconReceiptSchema,
  deleteWorkspaceReceiptSchema,
} from '@tulipfarm/workspaces/settings-contracts';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { TableRequestError } from '@/features/tables/request-state';

export const settingsCommandSchema = z.discriminatedUnion('kind', [
  renameWorkspaceSchema.extend({ kind: z.literal('rename') }),
  setWorkspaceIconSchema.extend({ kind: z.literal('icon') }),
  deleteWorkspaceSchema.extend({ kind: z.literal('delete') }),
]);
export type Settings = z.infer<typeof workspaceSettingsSchema>;
export type SettingsCommand = z.infer<typeof settingsCommandSchema>;
export type SettingsReceipt =
  | z.infer<typeof renameWorkspaceReceiptSchema>
  | z.infer<typeof setWorkspaceIconReceiptSchema>
  | z.infer<typeof deleteWorkspaceReceiptSchema>;

export async function settingsRequest(path: string, signal: AbortSignal, method = 'GET', input?: unknown) {
  const response = await jsonResponse(`${apiOrigin}/v1${path}`, { method, cache: 'no-store', signal, body: input });
  const value = await readJson(response, true);
  if (!response.ok) {
    const code = responseError(value, 'settings-request-failed');
    throw new TableRequestError(
      response.status,
      code,
      response.status === 400
        ? 'The server rejected these values. Review your input and try again.'
        : 'Could not complete the settings request. Your input is retained.',
    );
  }
  return value;
}

export function settingsApi(workspaceId: string) {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/settings`;
  function receipt(value: unknown, command: SettingsCommand): SettingsReceipt {
    if (command.kind === 'rename') {
      const result = renameWorkspaceReceiptSchema.parse(value);
      if (
        result.requestId !== command.requestId ||
        result.name !== command.name ||
        result.revision !== command.expectedRevision + 1
      )
        throw new Error('Unconfirmed rename receipt');
      return result;
    }
    if (command.kind === 'icon') {
      const result = setWorkspaceIconReceiptSchema.parse(value);
      if (
        result.requestId !== command.requestId ||
        result.icon !== command.icon ||
        result.revision !== command.expectedRevision + 1
      )
        throw new Error('Unconfirmed icon receipt');
      return result;
    }
    const result = deleteWorkspaceReceiptSchema.parse(value);
    if (result.requestId !== command.requestId || result.workspaceId !== workspaceId)
      throw new Error('Unconfirmed deletion receipt');
    return result;
  }
  return {
    read: async (signal: AbortSignal) => {
      const settings = workspaceSettingsSchema.parse(await settingsRequest(base, signal));
      if (settings.workspaceId !== workspaceId) throw new Error('Unexpected workspace settings');
      return settings;
    },
    save: async (command: SettingsCommand, signal: AbortSignal) => {
      const { kind, ...input } = settingsCommandSchema.parse(command);
      return receipt(
        await settingsRequest(
          `${base}/${kind === 'rename' ? 'name' : kind === 'icon' ? 'icon' : 'delete'}`,
          signal,
          kind === 'delete' ? 'POST' : 'PUT',
          input,
        ),
        command,
      );
    },
    receipt: async (command: SettingsCommand, signal: AbortSignal) =>
      receipt(
        await settingsRequest(
          `/workspace-settings/${encodeURIComponent(workspaceId)}/commands/${encodeURIComponent(command.requestId)}`,
          signal,
        ),
        command,
      ),
  };
}
