import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccessDenied, currentMember, lockAuthorization, type HumanActor } from '@tulipfarm/access';
import { commonCompatibility, qualified, type SqlClient } from '@tulipfarm/workspace-storage/runtime';
import {
  API_CALL_LIMITS,
  ApiCallError,
  apiCallStatuses,
  apiMethods,
  apiCallDecisionSchema,
  type ApiCallStatus,
  type ApiCallView,
  apiRequestCallSchema,
  readMethods,
  type ApiCallResult,
  type ApiCallWaiting,
} from './contracts.ts';
import { encodeBody } from './policy.ts';
import {
  callOutcome,
  failedResult,
  parseApiCall,
  prepareApiCall,
  transmitApiCall,
  type ApiCallLedger,
  type ApiCallOutcome,
  type ApiCallSecrets,
  type PreparedApiCall,
  type SendApiCallOptions,
  type UsedSecret,
} from './send.ts';

export type ApiCallTransaction = { client: SqlClient; schema: string };
export type ApiCallStorage = {
  transaction<T>(
    workspaceId: string,
    range: { minimum: number; maximum: number },
    action: (tx: ApiCallTransaction) => Promise<T>,
  ): Promise<T>;
};
export type ApiCallOrigin =
  | { kind: 'chat'; conversationId: string; turnId: string; generation: number }
  | { kind: 'task'; taskId: string; runId: string };

export const API_CALL_APPROVAL_MS = 24 * 60 * 60 * 1000;
const slotRetryMs = 200;
/** A claimed change is left alone this long past its deadline before it is called `outcome-unknown`. */
const sendingGraceMs = 30_000;
const previewBytes = 16 * 1024;

const callTable = (tx: ApiCallTransaction) => qualified(tx.schema, 'tf_api_calls');
const decisionTable = (tx: ApiCallTransaction) => qualified(tx.schema, 'tf_api_call_decisions');

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Binds an approval to the exact request, who asked, where, and each secret's version, policy and placement (P24). */
export function apiCallDigest(origin: ApiCallOrigin, membershipId: string, prepared: PreparedApiCall) {
  return sha256(
    canonical({
      origin,
      membershipId,
      method: prepared.call.method,
      url: prepared.unplaced,
      headers: prepared.headers,
      contentType: prepared.contentType,
      bodySha256: prepared.body === undefined ? null : sha256(prepared.body),
      secrets: prepared.used.map(({ secretId, version, policyVersion, placement }) => ({
        secretId,
        version,
        policyVersion,
        placement,
      })),
    }),
  );
}

const originColumns = (origin: ApiCallOrigin) =>
  origin.kind === 'chat'
    ? [origin.kind, origin.conversationId, origin.turnId, origin.generation, null, null]
    : [origin.kind, null, null, null, origin.taskId, origin.runId];

async function lockWorkspace(tx: ApiCallTransaction, workspaceId: string) {
  await tx.client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`api-calls:${workspaceId}`]);
}
async function inFlight(tx: ApiCallTransaction) {
  return Number(
    (
      await tx.client.query(
        `SELECT count(*)::int AS n FROM ${callTable(tx)} WHERE status='sending' AND deadline_at > clock_timestamp()`,
      )
    ).rows[0].n,
  );
}
async function originCalls(tx: ApiCallTransaction, origin: ApiCallOrigin) {
  return Number(
    (
      await tx.client.query(
        `SELECT count(*)::int AS n FROM ${callTable(tx)} WHERE ${origin.kind === 'chat' ? 'turn_id' : 'run_id'}=$1`,
        [origin.kind === 'chat' ? origin.turnId : origin.runId],
      )
    ).rows[0].n,
  );
}
const callLimit = () =>
  new ApiCallError(
    'call-limit',
    `This turn or run already made ${API_CALL_LIMITS.callsPerScope} API calls. Summarize what you have instead.`,
  );

/**
 * Runs `attempt` under the workspace's call lock once fewer than ten calls are in flight, retrying until `deadline`.
 * Sending rows are the slots: a crashed worker's slot frees itself at its deadline.
 */
async function withSlot<T>(
  storage: ApiCallStorage,
  workspaceId: string,
  deadline: number,
  signal: AbortSignal | undefined,
  attempt: (tx: ApiCallTransaction) => Promise<T>,
): Promise<T> {
  for (;;) {
    const admitted = await storage.transaction(workspaceId, commonCompatibility, async tx => {
      await lockWorkspace(tx, workspaceId);
      if ((await inFlight(tx)) >= API_CALL_LIMITS.inFlightPerWorkspace) return { busy: true as const };
      return { busy: false as const, value: await attempt(tx) };
    });
    if (!admitted.busy) return admitted.value;
    signal?.throwIfAborted();
    if (Date.now() + slotRetryMs >= deadline)
      throw new ApiCallError(
        'timeout',
        'Too many API calls are running in this workspace. Nothing was sent. Try again shortly.',
      );
    await new Promise(resolve => setTimeout(resolve, slotRetryMs));
  }
}

async function finish(tx: ApiCallTransaction, id: string, outcome: ApiCallOutcome) {
  await tx.client.query(
    `UPDATE ${callTable(tx)} SET status=$2, response_status=$3, duration_ms=$4, error_code=$5, completed_at=clock_timestamp(), request=NULL WHERE id=$1 AND status='sending'`,
    [id, outcome.status, outcome.responseStatus ?? null, outcome.durationMs ?? null, outcome.errorCode ?? null],
  );
}

/** Records each read of one turn or run, applying its call limit and the workspace's in-flight limit durably. */
export function apiCallLedger(
  storage: ApiCallStorage,
  input: { workspaceId: string; membershipId: string; origin: ApiCallOrigin },
): ApiCallLedger {
  return {
    async start(call, deadline, signal) {
      const id = randomUUID();
      await withSlot(storage, input.workspaceId, deadline, signal, async tx => {
        if ((await originCalls(tx, input.origin)) >= API_CALL_LIMITS.callsPerScope) throw callLimit();
        await tx.client.query(
          `INSERT INTO ${callTable(tx)} (id, membership_id, origin_kind, conversation_id, turn_id, generation, task_id, run_id, method, redacted_url, host, timeout_ms, status, deadline_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'sending', clock_timestamp() + $12::int * interval '1 millisecond')`,
          [
            id,
            input.membershipId,
            ...originColumns(input.origin),
            call.method,
            call.redactedUrl,
            call.host,
            call.timeoutMs,
          ],
        );
      });
      return {
        finish: outcome => storage.transaction(input.workspaceId, commonCompatibility, tx => finish(tx, id, outcome)),
      };
    },
  };
}

const storedSecretsSchema = z.array(
  z.object({
    secretId: z.string(),
    name: z.string(),
    version: z.number().int(),
    policyVersion: z.number().int(),
    placement: z.looseObject({ kind: z.string() }),
  }),
);
const rowSchema = z.object({
  id: z.uuid(),
  membership_id: z.uuid(),
  origin_kind: z.enum(['chat', 'task']),
  conversation_id: z.uuid().nullable(),
  turn_id: z.uuid().nullable(),
  generation: z.number().int().nullable(),
  task_id: z.uuid().nullable(),
  run_id: z.uuid().nullable(),
  method: z.enum(apiMethods),
  redacted_url: z.string(),
  host: z.string(),
  request: z.unknown().nullable(),
  secrets: storedSecretsSchema,
  purpose: z.string().nullable(),
  digest: z.string().nullable(),
  timeout_ms: z.number().int(),
  status: z.enum(apiCallStatuses),
  expires_at: z.date().nullable(),
  deadline_at: z.date().nullable(),
  response_status: z.number().int().nullable(),
  error_code: z.string().nullable(),
  expired: z.boolean(),
  overdue: z.boolean(),
  decision: z.enum(['approve', 'reject']).nullable(),
  decision_digest: z.string().nullable(),
  reason: z.string().nullable(),
});
type Row = z.infer<typeof rowSchema>;

const rowSelect = (tx: ApiCallTransaction, where: string) =>
  `SELECT c.id, c.membership_id, c.origin_kind, c.conversation_id, c.turn_id, c.generation, c.task_id, c.run_id,
     c.method, c.redacted_url, c.host, c.request, c.secrets, c.purpose, c.digest, c.timeout_ms, c.status,
     c.expires_at, c.deadline_at, c.response_status, c.error_code,
     COALESCE(c.expires_at <= clock_timestamp(), false) AS expired,
     COALESCE(c.deadline_at + $2 * interval '1 millisecond' <= clock_timestamp(), false) AS overdue,
     d.decision, d.digest AS decision_digest, d.reason
   FROM ${callTable(tx)} c LEFT JOIN ${decisionTable(tx)} d ON d.call_id = c.id
   WHERE ${where}`;

async function loadRow(tx: ApiCallTransaction, id: string, lock: boolean): Promise<Row | undefined> {
  return rowSchema
    .optional()
    .parse(
      (await tx.client.query(`${rowSelect(tx, 'c.id = $1')}${lock ? ' FOR UPDATE OF c' : ''}`, [id, sendingGraceMs]))
        .rows[0],
    );
}
const rowOrigin = (row: Row): ApiCallOrigin =>
  row.origin_kind === 'chat'
    ? { kind: 'chat', conversationId: row.conversation_id!, turnId: row.turn_id!, generation: row.generation! }
    : { kind: 'task', taskId: row.task_id!, runId: row.run_id! };

const finalMessages: Record<string, string> = {
  rejected: "The member chose not to send this request. Nothing was sent. Don't make it again unless they ask.",
  expired: 'Nobody approved this request within 24 hours, so it expired. Nothing was sent.',
  conflict:
    'The request or a secret it uses changed after it was approved, so it was not sent. Ask again if it is still needed.',
  'outcome-unknown':
    'The request may have reached the server, but no response came back. It was not sent again. Tell the member to check the service before trying again.',
};
function storedResult(row: Row): ApiCallResult {
  if (row.status === 'sent' && row.error_code === null && row.response_status !== null)
    return {
      status: 'sent',
      method: row.method,
      url: row.redacted_url,
      response: { status: row.response_status, durationMs: 0, headers: {}, body: { kind: 'none' } },
      secrets: row.secrets.map(({ name, placement }) => ({ name, placement: placement as never })),
      untrusted: true,
      note: 'The request was sent earlier; its response body was not kept.',
    };
  const code = (row.status === 'sent' || row.status === 'failed' ? row.error_code : row.status) ?? 'unavailable';
  return {
    status: 'failed',
    code: code as never,
    message: finalMessages[code] ?? 'The request did not complete.',
    ...(row.response_status !== null ? { httpStatus: row.response_status } : {}),
  };
}

export type ProposeInput = {
  workspaceId: string;
  membershipId: string;
  origin: ApiCallOrigin;
  /** The tool call's ID, which becomes the call's ID. */
  callId: string;
  call: unknown;
  secrets?: ApiCallSecrets | undefined;
};

/**
 * Checks a `POST`, `PUT`, `PATCH` or `DELETE` call and records it for the member's approval, without sending. A
 * repeated proposal of the same call ID returns the same wait.
 */
export async function proposeApiCall(
  storage: ApiCallStorage,
  input: ProposeInput,
): Promise<ApiCallWaiting | ApiCallResult> {
  let prepared: PreparedApiCall;
  try {
    const call = parseApiCall(input.call);
    if (readMethods.has(call.method)) throw new ApiCallError('invalid-request', 'Reads are sent without approval.');
    prepared = await prepareApiCall(call, input.secrets);
  } catch (error) {
    if (error instanceof ApiCallError) return failedResult(error);
    throw error;
  }
  const digest = apiCallDigest(input.origin, input.membershipId, prepared);
  try {
    await storage.transaction(input.workspaceId, commonCompatibility, async tx => {
      await lockWorkspace(tx, input.workspaceId);
      if ((await loadRow(tx, input.callId, false)) !== undefined) return;
      if ((await originCalls(tx, input.origin)) >= API_CALL_LIMITS.callsPerScope) throw callLimit();
      await tx.client.query(
        `INSERT INTO ${callTable(tx)} (id, membership_id, origin_kind, conversation_id, turn_id, generation, task_id, run_id, method, redacted_url, host, request, secrets, purpose, digest, timeout_ms, status, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'awaiting-approval', clock_timestamp() + $17 * interval '1 millisecond')`,
        [
          input.callId,
          input.membershipId,
          ...originColumns(input.origin),
          prepared.call.method,
          prepared.redactedUrl,
          prepared.host,
          JSON.stringify(prepared.call),
          JSON.stringify(
            prepared.used.map(({ secretId, name, version, policyVersion, placement }) => ({
              secretId,
              name,
              version,
              policyVersion,
              placement,
            })),
          ),
          prepared.call.purpose ?? null,
          digest,
          prepared.timeoutMs,
          API_CALL_APPROVAL_MS,
        ],
      );
    });
  } catch (error) {
    if (error instanceof ApiCallError) return failedResult(error);
    throw error;
  }
  return { provider: 'api-call', kind: 'waiting', callId: input.callId };
}

export type ResumeOptions = Pick<SendApiCallOptions, 'secrets' | 'signal' | 'files' | 'dependencies'>;

/**
 * Continues a change after its decision: sends it once if it is approved and nothing it binds changed, or returns
 * how it ended. `waiting` means there is no decision yet, or another worker is sending it.
 */
export async function resumeApiCall(
  storage: ApiCallStorage,
  workspaceId: string,
  callId: string,
  options: ResumeOptions = {},
): Promise<{ state: 'waiting' } | { state: 'done'; result: ApiCallResult }> {
  const done = (result: ApiCallResult) => ({ state: 'done' as const, result });
  const settle = async (
    status: 'expired' | 'rejected' | 'outcome-unknown',
    from: Row,
  ): Promise<{ state: 'done'; result: ApiCallResult }> => {
    const row = await storage.transaction(workspaceId, commonCompatibility, async tx => {
      await tx.client.query(
        `UPDATE ${callTable(tx)} SET status=$2, error_code=$2, completed_at=clock_timestamp(), request=NULL WHERE id=$1 AND status=$3`,
        [callId, status, from.status],
      );
      return loadRow(tx, callId, false);
    });
    return done(storedResult(row!));
  };
  const row = await storage.transaction(workspaceId, commonCompatibility, tx => loadRow(tx, callId, false));
  if (!row) throw new AccessDenied();
  if (row.status === 'sending') return row.overdue ? settle('outcome-unknown', row) : { state: 'waiting' };
  if (row.status !== 'awaiting-approval') return done(storedResult(row));
  if (row.decision === 'reject' && row.decision_digest === row.digest) return settle('rejected', row);
  if (row.expired) return settle('expired', row);
  if (row.decision !== 'approve' || row.decision_digest !== row.digest) return { state: 'waiting' };

  const call = apiRequestCallSchema.parse(row.request);
  const deadline = Date.now() + row.timeout_ms;
  let claimed: boolean;
  try {
    claimed = await withSlot(storage, workspaceId, deadline, options.signal, async tx => {
      const current = await loadRow(tx, callId, true);
      if (!current || current.status !== 'awaiting-approval' || current.expired) return false;
      await tx.client.query(
        `UPDATE ${callTable(tx)} SET status='sending', claimed_at=clock_timestamp(), deadline_at=clock_timestamp() + $2 * interval '1 millisecond' WHERE id=$1`,
        [callId, row.timeout_ms],
      );
      return true;
    });
  } catch (error) {
    if (error instanceof ApiCallError && error.code === 'timeout') return { state: 'waiting' };
    throw error;
  }
  if (!claimed) return resumeApiCall(storage, workspaceId, callId, options);

  let result: ApiCallResult | undefined;
  let transmitting = false;
  try {
    let prepared: PreparedApiCall | undefined;
    try {
      prepared = await prepareApiCall(call, options.secrets, row.secrets as UsedSecret[]);
      if (apiCallDigest(rowOrigin(row), row.membership_id, prepared) !== row.digest)
        throw new ApiCallError('conflict', finalMessages.conflict!);
    } catch (error) {
      if (!(error instanceof ApiCallError)) throw error;
      result =
        error.code === 'conflict'
          ? failedResult(new ApiCallError('conflict', finalMessages.conflict!))
          : failedResult(error);
    }
    if (prepared && !result) {
      transmitting = true;
      result = await transmitApiCall(prepared, { ...options, deadline });
    }
    return done(result!);
  } finally {
    const outcome: ApiCallOutcome = result
      ? callOutcome(result)
      : transmitting
        ? { status: 'outcome-unknown', errorCode: 'outcome-unknown' }
        : { status: 'failed', errorCode: 'unavailable' };
    // If this fails the call stays `sending` and later reads as `outcome-unknown`; it is never sent again.
    await storage
      .transaction(workspaceId, commonCompatibility, tx => finish(tx, callId, outcome))
      .catch(() => undefined);
  }
}

function viewOf(row: Row): ApiCallView {
  const parsed = row.request === null ? null : apiRequestCallSchema.safeParse(row.request);
  const call = parsed?.success ? parsed.data : null;
  let body: ApiCallView['body'] = null;
  if (call?.body) {
    const encoded = encodeBody(call.body);
    const bytes = Buffer.byteLength(encoded.body);
    const preview = Buffer.from(encoded.body)
      .subarray(0, previewBytes)
      .toString('utf8')
      .replace(/\uFFFD+$/, '');
    body = { contentType: encoded.contentType, preview, bytes, truncated: bytes > previewBytes };
  }
  const status: ApiCallStatus =
    row.status !== 'awaiting-approval'
      ? row.status
      : row.decision === 'reject'
        ? 'rejected'
        : row.expired
          ? 'expired'
          : row.decision === 'approve'
            ? 'sending'
            : row.status;
  return {
    id: row.id,
    status,
    method: row.method,
    url: row.redacted_url,
    host: row.host,
    headers: call?.headers ?? {},
    body,
    secrets: row.secrets.map(({ name, placement }) => ({ name, placement })),
    purpose: row.purpose,
    digest: row.digest,
    expiresAt: row.expires_at?.toISOString() ?? null,
    responseStatus: row.response_status,
    errorCode: row.error_code,
    origin:
      row.origin_kind === 'chat'
        ? { kind: 'chat', conversationId: row.conversation_id! }
        : { kind: 'task', taskId: row.task_id! },
  };
}

/** A change as its member reviews it: secrets by name, never values. Anyone else reads `undefined`. */
export async function viewApiCall(
  tx: ApiCallTransaction,
  actor: HumanActor,
  callId: string,
): Promise<ApiCallView | undefined> {
  const row = await loadRow(tx, z.uuid().parse(callId), false);
  if (!row || row.digest === null || row.membership_id !== actor.membershipId) return undefined;
  return viewOf(row);
}

/** The member's own changes in a task, newest first, for the task page. */
export async function listTaskApiCalls(tx: ApiCallTransaction, actor: HumanActor, taskId: string) {
  const rows = z
    .array(rowSchema)
    .parse(
      (
        await tx.client.query(
          `${rowSelect(tx, 'c.task_id = $1 AND c.membership_id = $3 AND c.digest IS NOT NULL')} ORDER BY c.created_at DESC, c.id LIMIT 20`,
          [z.uuid().parse(taskId), sendingGraceMs, actor.membershipId],
        )
      ).rows,
    );
  return rows.map(viewOf);
}

export class ApiCallDecisionConflict extends Error {
  constructor() {
    super('api-call-conflict');
    this.name = 'ApiCallDecisionConflict';
  }
}

/**
 * Records the member's decision on their own waiting change, in a transaction of the confirmation role. A retry of
 * the same command returns the call again; any other second decision, a stale digest, an expired call or an origin
 * that stopped waiting is a conflict.
 */
export async function decideApiCall(
  tx: ApiCallTransaction,
  actor: HumanActor,
  callId: string,
  input: unknown,
): Promise<{ view: ApiCallView; origin: ApiCallOrigin }> {
  const decision = apiCallDecisionSchema.parse(input);
  await lockAuthorization(tx);
  await currentMember(tx, actor);
  // The confirmation role cannot lock call rows; the decision's primary key keeps it to one decision per call.
  const row = await loadRow(tx, z.uuid().parse(callId), false);
  if (!row || row.digest === null || row.membership_id !== actor.membershipId) throw new AccessDenied();
  const replay = async () => {
    const existing = (
      await tx.client.query(`SELECT command_id, decision, digest FROM ${decisionTable(tx)} WHERE call_id=$1`, [callId])
    ).rows[0] as { command_id: string; decision: string; digest: string } | undefined;
    if (!existing) return undefined;
    if (
      existing.command_id !== decision.commandId ||
      existing.decision !== decision.decision ||
      existing.digest !== decision.digest
    )
      throw new ApiCallDecisionConflict();
    return { view: viewOf(row), origin: rowOrigin(row) };
  };
  const earlier = await replay();
  if (earlier) return earlier;
  if (row.status !== 'awaiting-approval' || row.expired || row.digest !== decision.digest)
    throw new ApiCallDecisionConflict();
  const origin = rowOrigin(row);
  const live =
    origin.kind === 'chat'
      ? await tx.client.query(
          `SELECT 1 FROM ${qualified(tx.schema, 'tf_conversation_turns')} WHERE id=$1 AND generation=$2 AND status='waiting'`,
          [origin.turnId, origin.generation],
        )
      : await tx.client.query(
          `SELECT 1 FROM ${qualified(tx.schema, 'tf_agent_task_runs')} b JOIN ${qualified(tx.schema, 'tf_agent_tasks')} t ON t.id=b.task_id AND t.generation=b.generation WHERE b.task_id=$1 AND b.run_id=$2 AND t.status IN ('pending','waiting-approval')`,
          [origin.taskId, origin.runId],
        );
  if (!live.rowCount) throw new ApiCallDecisionConflict();
  const inserted = await tx.client.query(
    `INSERT INTO ${decisionTable(tx)} (call_id, membership_id, command_id, digest, decision, reason) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (call_id) DO NOTHING`,
    [callId, actor.membershipId, decision.commandId, decision.digest, decision.decision, decision.reason ?? null],
  );
  if (!inserted.rowCount) return (await replay()) ?? Promise.reject(new ApiCallDecisionConflict());
  return {
    view: { ...viewOf(row), status: decision.decision === 'reject' ? 'rejected' : 'sending' },
    origin,
  };
}
