import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { uuidSchema } from '@tulipfarm/access/contracts';
import { denyMcpEgress } from '@tulipfarm/access';
import type { createGoogleWorkspaceService } from './service.ts';
import {
  GoogleOperationError,
  googleOperationCatalog,
  googleOperationSchema,
  googleWriteTarget,
  isGoogleWrite,
  type GoogleOperation,
  type GoogleWriteTarget,
} from './operation-contracts.ts';
import {
  GoogleFileError,
  googleFileListRequestSchema,
  googleFileReferenceSchema,
  googleFileContentRequestSchema,
  type GoogleFileReference,
} from './file-contracts.ts';
import { listGoogleFiles, getGoogleFile, readGoogleFile, readGoogleFileText } from './file-provider.ts';
import { dispatchGoogleOperation, readGoogleRevision } from './operation-provider.ts';
import {
  GoogleLifecycleError,
  googleVersionGuardSchema,
  googleProposalListQuerySchema,
  googleProposalListSchema,
  googleProposalSummarySchema,
  operationRequestSchema,
  proposalRequestSchema,
  requiredScopes,
} from './lifecycle-contracts.ts';
import { boundedResult, canonical, digest } from './lifecycle-internals.ts';
import {
  authorized,
  decision,
  freshProposal,
  loadIntegration,
  loadProposal,
  proposalLock,
  proposalRowSchema,
  proposalView,
  receipt,
  table,
  type GoogleOperationRuntime,
  type ProposalRow,
} from './operation-store.ts';
import type { AuthorizationTransaction, HumanActor } from '@tulipfarm/access';

import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
export * from './lifecycle-contracts.ts';
/** Concurrent Google file reads one integration may hold, and the process-wide ceiling across integrations. */
export const googleFileReadLimits = { perIntegration: 3, total: 12 } as const;
type Fence = Parameters<ReturnType<typeof createGoogleWorkspaceService>['withCredential']>[0];
type RevisionTarget = Extract<GoogleWriteTarget, { kind: 'revision' }> & { requiredRevisionId: string };
type SpreadsheetTarget = Extract<GoogleWriteTarget, { kind: 'created-spreadsheet' }>;
type ReviewedTarget = RevisionTarget | SpreadsheetTarget;
const reviewedRevision = (target: ReviewedTarget) =>
  target.kind === 'revision' ? target.requiredRevisionId : target.requiredVersion;
function reviewedTarget(operation: GoogleOperation): ReviewedTarget | null {
  const target = googleWriteTarget(operation);
  if (target.kind === 'unguarded') throw new GoogleLifecycleError('operation-unguarded-update');
  if (target.kind === 'unbound') return null;
  if (target.kind === 'created-spreadsheet') return target;
  if (target.requiredRevisionId === undefined) throw new GoogleLifecycleError('operation-revision-required');
  return { ...target, requiredRevisionId: target.requiredRevisionId };
}
/** The spreadsheet id must come from a succeeded receipt of a spreadsheet create, Drive copy, or new Drive upload in this workspace. */
async function requireCreatedSpreadsheet(tx: AuthorizationTransaction, spreadsheetId: string) {
  const created = await tx.client.query(
    `SELECT 1 FROM ${table(tx, 'receipts')} r JOIN ${table(tx, 'proposals')} p ON p.id=r.proposal_id
    WHERE r.status='succeeded' AND ((p.operation->>'kind'='sheets.spreadsheets.create' AND r.result->'data'->>'spreadsheetId'=$1)
      OR (p.operation->>'kind'='drive.files.copy' AND r.result->'data'->>'id'=$1)
      OR (p.operation->>'kind'='drive.files.upload' AND NOT p.operation ? 'fileId' AND r.result->'data'->>'id'=$1)) LIMIT 1`,
    [spreadsheetId],
  );
  if (!created.rowCount) throw new GoogleLifecycleError('operation-unguarded-update');
}
async function previousProposal(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  commandId: string,
  operation: GoogleOperation,
): Promise<ProposalRow | undefined> {
  const previous = proposalRowSchema
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT *,expires_at<=clock_timestamp() AS expired FROM ${table(tx, 'proposals')} WHERE membership_id=$1 AND command_id=$2`,
          [actor.membershipId, commandId],
        )
      ).rows[0],
    );
  // A replay that left the Sheets version to TulipFarm matches the proposal that bound it.
  const target = googleWriteTarget(operation);
  const comparable =
    previous && target.kind === 'created-spreadsheet' && target.requiredVersion === undefined
      ? { ...previous.operation, requiredVersion: undefined }
      : previous?.operation;
  if (previous && canonical(comparable) !== canonical(operation)) throw new GoogleLifecycleError('operation-conflict');
  return previous;
}
export function createGoogleOperations(options: {
  runtime: GoogleOperationRuntime;
  integrations: ReturnType<typeof createGoogleWorkspaceService>;
  fetcher?: typeof fetch;
  calendarFeaturesEnabled?: (workspaceId: string, userId: string) => Promise<boolean>;
}) {
  const access = authorized(options.runtime);
  const fetcher = options.fetcher ?? fetch;
  async function requireCalendarFeature(workspaceId: string, userId: string, operation: GoogleOperation) {
    if (
      (operation.kind === 'calendar.events.create' || operation.kind === 'calendar.events.update') &&
      operation.event.conferenceData &&
      !(await options.calendarFeaturesEnabled?.(workspaceId, userId))
    )
      throw new GoogleLifecycleError('calendar-feature-disabled');
  }
  // A member holds one Google integration per workspace, so workspace and user name the integration before it is loaded.
  const fileReads = new Map<string, number>();
  let activeFileReads = 0;
  async function fileRead<T>(
    workspaceId: string,
    userId: string,
    expected: GoogleFileReference['expectedIntegration'],
    scopes: string[],
    operation: (credential: { accessToken: string; signal: AbortSignal; fetcher: typeof fetch }) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    denyMcpEgress();
    const integration = `${workspaceId}:${userId}`;
    const held = fileReads.get(integration) ?? 0;
    if (held >= googleFileReadLimits.perIntegration || activeFileReads >= googleFileReadLimits.total)
      throw new GoogleFileError('transfer-busy');
    fileReads.set(integration, held + 1);
    activeFileReads++;
    try {
      const fence = await access(workspaceId, userId, async (tx, actor) => ({
        workspaceId: uuidSchema.parse(workspaceId),
        actor,
        ...(await loadIntegration(tx, actor, scopes)),
      }));
      if (
        expected.integrationId !== fence.integrationId ||
        expected.accountId !== fence.accountId ||
        expected.generation !== fence.generation
      )
        throw new GoogleOperationError('reconnect-required');
      return await options.integrations.withReadCredential(
        fence,
        credential => operation({ ...credential, fetcher }),
        signal,
      );
    } finally {
      activeFileReads--;
      const remaining = (fileReads.get(integration) ?? 1) - 1;
      if (remaining) fileReads.set(integration, remaining);
      else fileReads.delete(integration);
    }
  }
  /** The target's current revision; a reviewed revision that differs is stale. */
  async function requireCurrentRevision(fence: Fence, target: ReviewedTarget) {
    const current = await options.integrations.withCredential(fence, ({ accessToken, signal }) =>
      readGoogleRevision({ target, accessToken, signal, fetcher }),
    );
    const reviewed = reviewedRevision(target);
    if (reviewed !== undefined && current !== reviewed) throw new GoogleLifecycleError('operation-target-stale');
    return current;
  }
  return {
    async listFiles(workspaceId: string, userId: string, input: unknown, signal?: AbortSignal) {
      const value = googleFileListRequestSchema.parse(input);
      return fileRead(
        workspaceId,
        userId,
        value.expectedIntegration,
        ['https://www.googleapis.com/auth/drive'],
        credential => listGoogleFiles(value, credential),
        signal,
      );
    },
    async fileMetadata(workspaceId: string, userId: string, input: unknown, signal?: AbortSignal) {
      const value = googleFileReferenceSchema.parse(input);
      return fileRead(
        workspaceId,
        userId,
        value.expectedIntegration,
        ['https://www.googleapis.com/auth/drive'],
        credential => getGoogleFile(value.fileId, credential),
        signal,
      );
    },
    async fileContent(workspaceId: string, userId: string, input: unknown, signal?: AbortSignal) {
      const value = googleFileContentRequestSchema.parse(input);
      return fileRead(
        workspaceId,
        userId,
        value.expectedIntegration,
        [
          value.kind === 'sheet-range'
            ? 'https://www.googleapis.com/auth/spreadsheets'
            : 'https://www.googleapis.com/auth/drive',
        ],
        credential => readGoogleFile(value, credential),
        signal,
      );
    },
    /** Current text-readable content for a chat reference, read only through the integration the reference was bound to. */
    async fileText(workspaceId: string, userId: string, input: GoogleFileReference, signal?: AbortSignal) {
      const value = googleFileReferenceSchema.parse(input);
      return fileRead(
        workspaceId,
        userId,
        value.expectedIntegration,
        ['https://www.googleapis.com/auth/drive'],
        credential => readGoogleFileText(value.fileId, credential),
        signal,
      );
    },
    catalog() {
      return googleOperationCatalog;
    },
    async read(workspaceId: string, userId: string, input: unknown) {
      denyMcpEgress();
      const { operation, expectedIntegration } = operationRequestSchema.parse(input);
      if (isGoogleWrite(operation)) throw new GoogleLifecycleError('operation-read-required');
      const fence = await access(workspaceId, userId, async (tx, actor) => ({
        workspaceId: uuidSchema.parse(workspaceId),
        actor,
        ...(await loadIntegration(tx, actor, requiredScopes(operation))),
      }));
      if (
        expectedIntegration &&
        (expectedIntegration.integrationId !== fence.integrationId ||
          expectedIntegration.accountId !== fence.accountId ||
          expectedIntegration.generation !== fence.generation)
      )
        throw new GoogleOperationError('reconnect-required');
      return options.integrations.withCredential(fence, async ({ accessToken, signal }) =>
        boundedResult(await dispatchGoogleOperation({ operation, accessToken, signal, fetcher }), accessToken),
      );
    },
    async propose(workspaceId: string, userId: string, input: unknown) {
      denyMcpEgress();
      const value = proposalRequestSchema.parse(input);
      if (!isGoogleWrite(value.operation)) throw new GoogleLifecycleError('operation-write-required');
      await requireCalendarFeature(workspaceId, userId, value.operation);
      if (
        (value.operation.kind === 'calendar.events.create' || value.operation.kind === 'calendar.events.update') &&
        value.operation.event.conferenceData
      ) {
        // Command identity survives retries and is bound into the exact approval digest.
        value.operation.event.conferenceData.createRequest.requestId = value.commandId;
      }
      const target = reviewedTarget(value.operation);
      let observed: Fence | null = null;
      let operation = value.operation;
      if (target) {
        const pending = await access(workspaceId, userId, async (tx, actor) => {
          await proposalLock(tx, `${actor.membershipId}:${value.commandId}`);
          const previous = await previousProposal(tx, actor, value.commandId, value.operation);
          if (previous) return { kind: 'existing' as const, view: await proposalView(tx, previous) };
          if (target.kind === 'created-spreadsheet') await requireCreatedSpreadsheet(tx, target.id);
          return {
            kind: 'observe' as const,
            fence: {
              workspaceId: uuidSchema.parse(workspaceId),
              actor,
              ...(await loadIntegration(tx, actor, requiredScopes(value.operation))),
            },
          };
        });
        if (pending.kind === 'existing') return pending.view;
        const current = await requireCurrentRevision(pending.fence, target);
        if (target.kind === 'created-spreadsheet')
          operation = googleOperationSchema.parse({ ...value.operation, requiredVersion: current });
        observed = pending.fence;
      }
      return access(workspaceId, userId, async (tx, actor) => {
        await proposalLock(tx, `${actor.membershipId}:${value.commandId}`);
        const previous = await previousProposal(tx, actor, value.commandId, value.operation);
        if (previous) return proposalView(tx, previous);
        if (target?.kind === 'created-spreadsheet') await requireCreatedSpreadsheet(tx, target.id);
        const integration = await loadIntegration(tx, actor, requiredScopes(value.operation));
        if (
          observed &&
          (observed.integrationId !== integration.integrationId ||
            observed.accountId !== integration.accountId ||
            observed.generation !== integration.generation)
        )
          throw new GoogleLifecycleError('operation-conflict');
        await proposalLock(tx, actor.membershipId);
        const count = z
          .number()
          .parse(
            (
              await tx.client.query(
                `SELECT count(*)::integer AS count FROM ${table(tx, 'proposals')} WHERE membership_id=$1 AND created_at>clock_timestamp()-interval '1 day'`,
                [actor.membershipId],
              )
            ).rows[0]?.count,
          );
        if (count >= 1000 || Buffer.byteLength(JSON.stringify(value.operation)) > 2_097_152)
          throw new GoogleLifecycleError('operation-limit');
        const id = randomUUID();
        const actionDigest = digest({
          workspaceId: uuidSchema.parse(workspaceId),
          membershipId: actor.membershipId,
          userId: actor.userId,
          id,
          commandId: value.commandId,
          operation,
          integration,
        });
        await tx.client.query(
          `INSERT INTO ${table(tx, 'proposals')} (id,membership_id,user_id,command_id,integration_id,account_id,generation,scopes,required_scopes,operation,digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            id,
            actor.membershipId,
            actor.userId,
            value.commandId,
            integration.integrationId,
            integration.accountId,
            integration.generation,
            integration.scopes,
            integration.requiredScopes,
            operation,
            actionDigest,
          ],
        );
        return proposalView(tx, await loadProposal(tx, actor, id));
      });
    },
    async proposal(workspaceId: string, userId: string, proposalId: string) {
      return access(workspaceId, userId, async (tx, actor) =>
        proposalView(tx, await loadProposal(tx, actor, proposalId)),
      );
    },
    async proposals(workspaceId: string, userId: string, input: unknown = {}) {
      const query = googleProposalListQuerySchema.parse(input);
      const [createdAt, id] = query.cursor?.split('~') ?? [];
      return access(workspaceId, userId, async (tx, actor) => {
        const rows = (
          await tx.client.query(
            `SELECT p.id,p.operation->>'kind' AS "operationKind",
          to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
          to_char(p.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "expiresAt",
          d.decision,r.status AS "receiptStatus"
          FROM ${table(tx, 'proposals')} p
          LEFT JOIN ${table(tx, 'decisions')} d ON d.proposal_id=p.id
          LEFT JOIN ${table(tx, 'receipts')} r ON r.proposal_id=p.id
          WHERE p.membership_id=$1 AND p.user_id=$2
          AND ($3::timestamptz IS NULL OR (p.created_at,p.id)<($3::timestamptz,$4::uuid))
          ORDER BY p.created_at DESC,p.id DESC LIMIT $5`,
            [actor.membershipId, actor.userId, createdAt ?? null, id ?? null, query.limit + 1],
          )
        ).rows;
        const proposals = z.array(googleProposalSummarySchema).parse(rows.slice(0, query.limit));
        const last = proposals.at(-1);
        return googleProposalListSchema.parse({
          proposals,
          nextCursor: rows.length > query.limit && last ? `${last.createdAt}~${last.id}` : null,
        });
      });
    },
    async execute(workspaceId: string, userId: string, proposalId: string) {
      denyMcpEgress();
      const admit = (claim: boolean) =>
        access(workspaceId, userId, async (tx, actor) => {
          await proposalLock(tx, uuidSchema.parse(proposalId));
          const row = await loadProposal(tx, actor, proposalId);
          const existing = await receipt(tx, row.id);
          if (existing) return { kind: 'existing' as const, receipt: existing };
          await requireCalendarFeature(workspaceId, userId, row.operation);
          const integration = await freshProposal(tx, actor, row);
          if ((await decision(tx, row.id)) !== 'approve') throw new GoogleLifecycleError('operation-approval-required');
          const target = reviewedTarget(row.operation);
          if (target?.kind === 'created-spreadsheet') {
            await requireCreatedSpreadsheet(tx, target.id);
            // A proposal made before versions were bound carries no reviewed version to compare.
            if (target.requiredVersion === undefined) throw new GoogleLifecycleError('operation-revision-required');
          }
          if (claim) await tx.client.query(`INSERT INTO ${table(tx, 'receipts')} (proposal_id) VALUES ($1)`, [row.id]);
          return {
            kind: 'admitted' as const,
            row,
            target,
            fence: { workspaceId: uuidSchema.parse(workspaceId), actor, ...integration },
          };
        });
      const checked = await admit(false);
      if (checked.kind === 'existing') return checked.receipt;
      if (checked.target) await requireCurrentRevision(checked.fence, checked.target);
      const claimed = await admit(true);
      if (claimed.kind === 'existing') return claimed.receipt;
      let stale = false;
      let result: ReturnType<typeof boundedResult> | null = null;
      let status: 'succeeded' | 'failed' | 'outcome-unknown' = 'outcome-unknown';
      const settle = async (tx: AuthorizationTransaction) => {
        await tx.client.query(
          `UPDATE ${table(tx, 'receipts')} SET status=$2,result=$3,error=$4 WHERE proposal_id=$1 AND status='executing'`,
          [
            claimed.row.id,
            status,
            result,
            status === 'succeeded'
              ? null
              : status === 'failed'
                ? 'provider-request-failed'
                : 'provider-outcome-unknown',
          ],
        );
      };
      const sheet = claimed.target?.kind === 'created-spreadsheet' ? claimed.target : null;
      let dispatched = false;
      try {
        await options.integrations.withCredential(claimed.fence, async ({ accessToken, signal }, tx) => {
          if (claimed.row.expires_at.getTime() <= Date.now()) throw new GoogleLifecycleError('operation-expired');
          // Sheets has no write precondition, so the version is read again as close to the write as TulipFarm can.
          if (
            sheet &&
            (await readGoogleRevision({ target: sheet, accessToken, signal, fetcher })) !== sheet.requiredVersion
          )
            throw new GoogleOperationError('target-stale');
          dispatched = true;
          const written = boundedResult(
            await dispatchGoogleOperation({ operation: claimed.row.operation, accessToken, signal, fetcher }),
            accessToken,
          );
          result = !sheet?.requiredVersion
            ? written
            : {
                ...written,
                versionGuard: googleVersionGuardSchema.parse({
                  requiredVersion: sheet.requiredVersion,
                  versionAfterWrite: await readGoogleRevision({ target: sheet, accessToken, signal, fetcher }).catch(
                    () => null,
                  ),
                  residualRace:
                    'An edit saved between the final Drive version read and this write is not detected and may have been overwritten.',
                }),
              };
          status = 'succeeded';
          await settle(tx);
          return result;
        });
      } catch (error) {
        // A success recorded inside the credential transaction rolled back with it, so the later transaction cannot claim it.
        status = 'outcome-unknown';
        result = null;
        stale = error instanceof GoogleOperationError && error.code === 'target-stale';
        if (!dispatched && sheet) status = 'failed';
        if (
          error instanceof GoogleOperationError &&
          ['target-stale', 'provider-rejected', 'reconnect-required', 'insufficient-scope', 'rate-limited'].includes(
            error.code,
          )
        )
          status = 'failed';
      }
      await options.runtime.transaction(claimed.fence.workspaceId, commonCompatibility, settle);
      if (stale) throw new GoogleLifecycleError('operation-target-stale');
      return access(workspaceId, userId, async (tx, actor) => {
        await loadProposal(tx, actor, claimed.row.id);
        return receipt(tx, claimed.row.id);
      });
    },
  };
}
