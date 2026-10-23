import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  lockAuthorization,
  requireCurrentActor,
  type HumanActor,
  type AuthorizationTransaction,
} from '@tulipfarm/access';
import { GoogleOperationError, type GoogleOperation } from '@tulipfarm/google-workspace/operation-contracts';
import {
  OfficeSpecError,
  googleConversions,
  officeFormats,
  officeImageIds,
  renderOfficeDocument,
} from '@tulipfarm/conversations/office-documents';
import { GoogleLifecycleError, type createGoogleOperations } from '@tulipfarm/google-workspace/operations';
import { GoogleWorkspaceError, googleAppScopes, type GoogleApp } from '@tulipfarm/google-workspace/contracts';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import type { createFiles } from '@tulipfarm/files';
import { readOfficeImages } from '@tulipfarm/conversations/file-outputs';

import type { AgentStorage } from './store.ts';
import {
  googleToolResultSchema,
  googleToolErrorSchema,
  type GoogleToolCall,
  type googleDocumentSchema,
} from './google-tool-contracts.ts';
type Runtime = AgentStorage;
export type GoogleOperationsFactory = (runtime: Runtime) => ReturnType<typeof createGoogleOperations>;
const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, name);
const scope = z.array(z.object({ assetId: z.uuid(), permissions: z.array(z.string()) }));

const unguardedUpdateMessage =
  'Google cannot confirm that an existing spreadsheet range or Drive file still matches what the owner reviews, so in-place updates to Google originals are refused. ' +
  'Ask the person before replacing an edit with a copy. If they agree, create it with drive.files.copy, sheets.spreadsheets.create, or drive.files.upload without fileId. After that copy succeeds, sheets.values.update, sheets.values.batchUpdate, sheets.values.clear, and sheets.spreadsheets.batchUpdate are allowed on the same copy for later edits. sheets.values.append is still allowed on the original.';

const appNames: Record<GoogleApp, string> = {
  gmail: 'Gmail',
  calendar: 'Google Calendar',
  drive: 'Google Drive',
  sheets: 'Google Sheets',
  docs: 'Google Docs',
  slides: 'Google Slides',
};
function missingAccessMessage(missingScopes: readonly string[]) {
  const apps = (Object.keys(appNames) as GoogleApp[]).filter(app =>
    googleAppScopes[app].some(scope => missingScopes.includes(scope)),
  );
  if (!apps.length) return undefined;
  const names = apps.map(app => appNames[app]).join(' and ');
  return (
    `The task owner has not granted ${names} access. Ask them to open Integrations, choose ${names}, and select Grant access, then propose again.` +
    (apps.includes('drive')
      ? ' Sheets edits on a created or copied spreadsheet read its Drive version first, so they need Google Drive access too.'
      : '')
  );
}

/** The Drive upload a document proposal reviews; contentBase64 is empty when only the operation kind matters. */
export function documentUpload(document: z.infer<typeof googleDocumentSchema>, contentBase64 = ''): GoogleOperation {
  return {
    kind: 'drive.files.upload',
    mimeType: officeFormats[document.format],
    contentBase64,
    file: {
      name: document.name,
      mimeType: googleConversions[document.format],
      ...(document.folderId ? { parents: [document.folderId] } : {}),
    },
  };
}

const invalidProposal = (message: string) =>
  googleToolErrorSchema.parse({ provider: 'google-workspace', untrusted: true, error: 'invalid-operation', message });
const maximumUploadBytes = 1_048_576;

/** A rendered upload stays out of model context; the review card offers the file itself. */
function withoutUploadContent(data: unknown): unknown {
  const parsed = z
    .object({ operation: z.object({ contentBase64: z.string() }).loose() })
    .loose()
    .safeParse(data);
  if (!parsed.success) return data;
  const { contentBase64, ...operation } = parsed.data.operation;
  return { ...parsed.data, operation: { ...operation, contentBytes: Buffer.byteLength(contentBase64, 'base64') } };
}

export function googleToolError(error: unknown) {
  if (
    !(error instanceof GoogleLifecycleError) &&
    !(error instanceof GoogleWorkspaceError) &&
    !(error instanceof GoogleOperationError)
  )
    return null;
  const message =
    error.code === 'operation-unguarded-update'
      ? unguardedUpdateMessage
      : error instanceof GoogleWorkspaceError && error.code === 'insufficient-scope'
        ? missingAccessMessage(error.missingScopes)
        : undefined;
  return googleToolErrorSchema.parse({
    provider: 'google-workspace',
    untrusted: true,
    error: error.code,
    ...(message ? { message } : {}),
  });
}

export async function requireGoogleAgentOwner(
  tx: AuthorizationTransaction,
  runId: string,
  availability: 'required' | 'optional' = 'required',
): Promise<HumanActor> {
  await requireCurrentActor(tx, { kind: 'agent', runId });
  const run = z
    .object({
      kind: z.literal('delegated'),
      user_id: z.string(),
      membership_id: z.uuid(),
      scope,
      activation_scope: scope,
      limit_scope: scope,
    })
    .safeParse(
      (
        await tx.client.query(
          `SELECT r.*, a.scope AS activation_scope, l.scope AS limit_scope FROM ${table(tx, 'tf_agent_runs')} r JOIN ${table(tx, 'tf_agent_activations')} a ON a.id=r.activation_id JOIN ${table(tx, 'tf_agent_limits')} l ON l.agent_id=r.agent_id WHERE r.id=$1`,
          [runId],
        )
      ).rows[0],
    );
  if (!run.success) throw new AccessDenied();
  const actor: HumanActor = { kind: 'human', userId: run.data.user_id, membershipId: run.data.membership_id };
  await currentMember(tx, actor);
  if (
    !(
      await tx.client.query(
        `SELECT 1 FROM ${table(tx, 'tf_agent_runs')} r JOIN ${table(tx, 'tf_agent_teams')} a ON a.agent_id=r.agent_id JOIN ${table(tx, 'tf_member_teams')} m ON m.team_id=a.team_id WHERE r.id=$1 AND m.membership_id=$2`,
        [runId, actor.membershipId],
      )
    ).rowCount
  )
    throw new AccessDenied();
  const integration = z
    .object({ id: z.uuid(), status: z.enum(['connected', 'disconnected', 'reconnect-required']) })
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT id,status FROM ${table(tx, 'tf_google_integrations')} WHERE user_id=$1 AND membership_id=$2`,
          [actor.userId, actor.membershipId],
        )
      ).rows[0],
    );
  if (
    integration &&
    ![run.data.scope, run.data.activation_scope, run.data.limit_scope].every(entries =>
      ['integration.read', 'integration.use'].every(permission =>
        entries.some(entry => entry.assetId === integration.id && entry.permissions.includes(permission)),
      ),
    )
  )
    throw new AccessDenied();
  if (availability === 'required') {
    if (!integration || integration.status === 'disconnected') throw new GoogleLifecycleError('integration-required');
    if (integration.status === 'reconnect-required') throw new GoogleWorkspaceError('reconnect-required');
  }
  return actor;
}

/** `files` reads the images a document spec places; without it, a spec with images is refused. */
export async function invokeGoogleTool(
  runtime: Runtime,
  factory: GoogleOperationsFactory | undefined,
  context: { workspaceId: string; actor: HumanActor; callId: string },
  call: GoogleToolCall,
  files?: Pick<ReturnType<typeof createFiles>, 'download'>,
) {
  if (!factory) throw new Error('google-operation-unavailable');
  const guarded: Runtime = {
    transaction: (workspaceId, range, action) =>
      runtime.transaction(workspaceId, range, async tx => {
        if (workspaceId !== context.workspaceId) throw new AccessDenied();
        await lockAuthorization(tx);
        await currentMember(tx, context.actor);
        return action(tx);
      }),
  };
  const service = factory(guarded);
  const { workspaceId, actor, callId } = context;
  let data: unknown;
  try {
    switch (call.tool) {
      case 'google.read':
        data = await service.read(workspaceId, actor.userId, { operation: call.operation });
        break;
      case 'google.propose': {
        if (!call.operation === !call.document) return invalidProposal('Set exactly one of operation or document.');
        let operation = call.operation;
        if (call.document) {
          const ids = officeImageIds(call.document.format, call.document.content);
          if (ids.length && !files)
            return invalidProposal(
              'No proposal was created. Images can only be placed from a chat. Remove the image blocks and try again.',
            );
          const images = ids.length && files ? await readOfficeImages(files, context, ids) : [];
          if (typeof images === 'string') return invalidProposal(`No proposal was created. ${images}`);
          let bytes: Uint8Array;
          try {
            bytes = await renderOfficeDocument(
              call.document.format,
              call.document.content,
              new Map(images.map(image => [image.fileId, image])),
            );
          } catch (error) {
            if (error instanceof OfficeSpecError)
              return invalidProposal(`No proposal was created. The document spec is invalid: ${error.message}`);
            throw error;
          }
          if (bytes.byteLength > maximumUploadBytes)
            return invalidProposal(
              `No proposal was created. The rendered file is over 1 MiB.${images.length ? ' Use fewer or smaller images,' : ''} Split it or save it in Files instead.`,
            );
          operation = documentUpload(call.document, Buffer.from(bytes).toString('base64'));
        }
        data = await service.propose(workspaceId, actor.userId, { commandId: callId, operation });
        break;
      }
      case 'google.status':
        data = await service.proposal(workspaceId, actor.userId, call.proposalId);
        break;
      case 'google.execute':
        data = await service.execute(workspaceId, actor.userId, call.proposalId);
        break;
    }
    return googleToolResultSchema.parse({
      provider: 'google-workspace',
      untrusted: true,
      data: withoutUploadContent(data),
    });
  } catch (error) {
    const result = googleToolError(error);
    if (result) return result;
    throw error;
  }
}
