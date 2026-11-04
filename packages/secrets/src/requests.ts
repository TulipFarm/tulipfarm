import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccessDenied, type AuthorizationTransaction, type HumanActor } from '@tulipfarm/access';
import {
  SecretError,
  normalizeDestinations,
  placementSchema,
  sameOrigin,
  secretKindSchema,
  secretNameSchema,
  type Destination,
  type Placement,
  type SecretKind,
  type SecretOrigin,
} from './contracts.ts';
import {
  fieldIdSchema,
  requestFieldSchema,
  secretRequestInputSchema,
  type RequestField,
  type SecretRequestInput,
} from './contracts.ts';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { table, type Secrets, type SecretsPrincipal, type SecretTransaction } from './service.ts';

/** How long an unanswered request stays open, matching a conversation request. */
export const REQUEST_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** Where a request came from. A chat request also names the conversation request that pauses the turn. */
export const requestOriginSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('chat'),
    conversationId: z.uuid(),
    turnId: z.uuid(),
    conversationRequestId: z.uuid(),
  }),
  z.strictObject({ kind: z.literal('task'), taskId: z.uuid(), runId: z.uuid() }),
]);
export type RequestOrigin = z.infer<typeof requestOriginSchema>;
export const secretOriginOf = (origin: RequestOrigin): SecretOrigin =>
  origin.kind === 'chat'
    ? { kind: 'chat', conversationId: origin.conversationId }
    : { kind: 'task', taskId: origin.taskId, runId: origin.runId };

const newValueSchema = z.strictObject({
  fieldId: fieldIdSchema,
  value: z.unknown(),
  name: secretNameSchema.optional(),
  lifetime: z.enum(['conversation', 'saved']),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  placement: placementSchema.optional(),
});
const savedValueSchema = z.strictObject({ fieldId: fieldIdSchema, secretId: z.uuid() });
export const submitRequestSchema = z.strictObject({
  requestId: z.uuid(),
  expectedRevision: z.number().int().positive(),
  fields: z
    .array(z.union([savedValueSchema, newValueSchema]))
    .min(1)
    .max(5),
});
export type SubmitRequestInput = z.input<typeof submitRequestSchema>;
export const declineRequestSchema = z.strictObject({
  requestId: z.uuid(),
  expectedRevision: z.number().int().positive(),
  reason: z.string().trim().max(500).optional(),
});

/** What the agent learns about a provided secret. Never a value. */
export type SecretReference = {
  referenceId: string;
  fieldId: string;
  name: string;
  kind: SecretKind;
  placement: Placement;
  destinations: Destination[];
};
const referenceSchema = z.object({
  referenceId: z.uuid(),
  fieldId: z.string(),
  name: z.string(),
  kind: secretKindSchema,
  placement: placementSchema,
  destinations: z.array(z.object({ kind: z.enum(['host', 'endpoint']), value: z.string() })),
});

export type RequestStatus = 'waiting' | 'provided' | 'declined' | 'expired' | 'cancelled';
/** A form a task sent its owner, as the task page shows it. */
export type TaskSecretRequest = {
  id: string;
  status: RequestStatus;
  revision: number;
  expiresAt: string;
  purpose: string;
  declineReason: string | null;
  references: { referenceId: string; fieldId: string; name: string; kind: SecretKind }[];
};
export type RequestSettlement =
  | { status: 'provided'; references: SecretReference[] }
  | { status: 'declined'; reason: string | null }
  | { status: 'expired' }
  | { status: 'cancelled' };
export type SettledRequest = { workspaceId: string; id: string; membershipId: string; origin: RequestOrigin };
/**
 * Resumes the chat turn or task run that waits for a request, in the same transaction (P4, P13). Called once
 * per request. `commandId` and `actor` are present when a member submitted or declined.
 */
export type SettleRequest = (
  tx: AuthorizationTransaction,
  request: SettledRequest,
  settlement: RequestSettlement,
  context: { actor?: HumanActor; commandId?: string },
) => Promise<void>;

export type SecretOption = {
  secretId: string;
  name: string;
  lifetime: 'saved' | 'conversation';
  placement: Placement;
  expiresAt: string | null;
};
export type SecretRequestView = {
  id: string;
  status: RequestStatus;
  revision: number;
  expiresAt: string;
  purpose: string;
  destinations: Destination[];
  fields: (Omit<RequestField, 'placement'> & { placement: Placement | null; options: SecretOption[] })[];
  declineReason: string | null;
};

const timestamp = z.union([z.date(), z.string()]).transform(value => new Date(value).toISOString());
const requestRowSchema = z.object({
  id: z.uuid(),
  membership_id: z.uuid(),
  origin: requestOriginSchema,
  purpose: z.string(),
  fields: z.array(requestFieldSchema),
  destinations: z.array(z.object({ kind: z.enum(['host', 'endpoint']), value: z.string() })),
  status: z.enum(['waiting', 'provided', 'declined', 'expired', 'cancelled']),
  revision: z.number().int(),
  decline_reason: z.string().nullable(),
  expires_at: timestamp,
  expired: z.boolean(),
});
type RequestRow = z.infer<typeof requestRowSchema>;

const sameDestination = (a: Destination, b: Destination) => a.kind === b.kind && a.value === b.value;
const samePlacement = (a: Placement, b: Placement) =>
  JSON.stringify(placementSchema.parse(a)) === JSON.stringify(placementSchema.parse(b));

export function createSecretRequests(secrets: Secrets, config: { settle?: SettleRequest } = {}) {
  const settle: SettleRequest = config.settle ?? (async () => {});
  const { internal } = secrets;

  async function loadRequest(tx: SecretTransaction, id: string, lock = true) {
    const row = requestRowSchema
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT *, expires_at <= clock_timestamp() AS expired FROM ${table(tx, 'requests')} WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
            [z.uuid().parse(id)],
          )
        ).rows[0],
      );
    if (!row) throw new AccessDenied();
    return row;
  }

  async function finish(
    tx: AuthorizationTransaction,
    workspaceId: string,
    row: RequestRow,
    settlement: RequestSettlement,
    context: { actor?: HumanActor; commandId?: string } = {},
  ) {
    const updated = await tx.client.query(
      `UPDATE ${table(tx, 'requests')} SET status = $2, revision = revision + 1, settled_at = clock_timestamp(),
         decline_reason = $3 WHERE id = $1 AND status = 'waiting'`,
      [row.id, settlement.status, settlement.status === 'declined' ? settlement.reason : null],
    );
    // Settling an already-settled request does nothing (P11).
    if (!updated.rowCount) return false;
    await settle(
      tx,
      { workspaceId, id: row.id, membershipId: row.membership_id, origin: row.origin },
      settlement,
      context,
    );
    return true;
  }

  /** A late submission fails even before the sweep expires the request (P11). */
  function open(row: RequestRow) {
    if (row.status === 'waiting' && row.expired) throw new SecretError('expired');
    if (row.status !== 'waiting') throw new SecretError('conflict');
  }

  async function options(tx: SecretTransaction, actor: HumanActor, row: RequestRow, field: RequestField) {
    const candidates = z.array(z.object({ id: z.uuid() })).parse(
      (
        await tx.client.query(
          `SELECT id FROM ${table(tx, 'secrets')} WHERE status = 'active' AND kind = $1
             AND (expires_at IS NULL OR expires_at > clock_timestamp()) ORDER BY lower(name), created_at LIMIT 200`,
          [field.kind],
        )
      ).rows,
    );
    const origin = secretOriginOf(row.origin);
    const result: SecretOption[] = [];
    for (const { id } of candidates) {
      const secret = await internal.load(tx, id, 'none');
      if (!(await internal.access(tx, actor.membershipId, secret)).use) continue;
      // A temporary secret is offered only in the chat or task run it belongs to (P8, P45).
      if (secret.lifetime === 'conversation' && !(secret.origin && sameOrigin(secret.origin, origin))) continue;
      if (field.placement && !samePlacement(field.placement, secret.placement)) continue;
      const own = z
        .array(z.object({ kind: z.enum(['host', 'endpoint']), value: z.string() }))
        .parse(
          (await tx.client.query(`SELECT kind, value FROM ${table(tx, 'destinations')} WHERE secret_id = $1`, [id]))
            .rows,
        );
      if (!row.destinations.every(wanted => own.some(have => sameDestination(have, wanted)))) continue;
      result.push({
        secretId: secret.id,
        name: secret.name,
        lifetime: secret.lifetime,
        placement: secret.placement,
        expiresAt: secret.expires_at,
      });
    }
    return result;
  }

  async function reference(tx: SecretTransaction, row: RequestRow, fieldId: string, secretId: string) {
    const id = randomUUID();
    await tx.client.query(
      `INSERT INTO ${table(tx, 'references')} (id, request_id, field_id, secret_id, membership_id, origin)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, row.id, fieldId, secretId, row.membership_id, JSON.stringify(secretOriginOf(row.origin))],
    );
    return describe(tx, id, fieldId, secretId);
  }

  async function endOrigin(tx: SecretTransaction, origin: SecretOrigin) {
    const rows = z.array(requestRowSchema).parse(
      (
        await tx.client.query(
          `SELECT *, expires_at <= clock_timestamp() AS expired FROM ${table(tx, 'requests')}
           WHERE status = 'waiting' AND origin @> $1::jsonb ORDER BY id FOR UPDATE`,
          [JSON.stringify(origin)],
        )
      ).rows,
    );
    let cancelled = 0;
    for (const row of rows)
      if (sameOrigin(secretOriginOf(row.origin), origin)) {
        await tx.client.query(
          `UPDATE ${table(tx, 'requests')} SET status = 'cancelled', revision = revision + 1,
             settled_at = clock_timestamp() WHERE id = $1`,
          [row.id],
        );
        cancelled++;
      }
    return { cancelled, deleted: await secrets.deleteOrigin(tx, origin) };
  }

  async function describe(tx: SecretTransaction, id: string, fieldId: string, secretId: string) {
    const secret = await internal.load(tx, secretId, 'none');
    const destinations = z
      .array(z.object({ kind: z.enum(['host', 'endpoint']), value: z.string() }))
      .parse(
        (
          await tx.client.query(
            `SELECT kind, value FROM ${table(tx, 'destinations')} WHERE secret_id = $1 ORDER BY kind, value`,
            [secretId],
          )
        ).rows,
      );
    return {
      referenceId: id,
      fieldId,
      name: secret.name,
      kind: secret.kind,
      placement: secret.placement,
      destinations,
    } satisfies SecretReference;
  }

  return {
    /**
     * Records a request in the caller's transaction, which also pauses the chat turn or task run. The caller
     * checks the origin belongs to `membershipId`.
     */
    async create(
      tx: SecretTransaction,
      input: {
        id?: string;
        membershipId: string;
        origin: RequestOrigin;
        request: SecretRequestInput;
        expiresAt?: Date;
      },
    ) {
      if (!secrets.capabilities().enabled) throw new SecretError('disabled');
      const request = secretRequestInputSchema.parse(input.request);
      const destinations = normalizeDestinations(request.destinations, secrets.privateHosts);
      const id = input.id ?? randomUUID();
      const expiresAt = input.expiresAt ?? new Date(Date.now() + REQUEST_LIFETIME_MS);
      await tx.client.query(
        `INSERT INTO ${table(tx, 'requests')} (id, membership_id, origin, purpose, fields, destinations, status, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,'waiting',$7)`,
        [
          z.uuid().parse(id),
          z.uuid().parse(input.membershipId),
          JSON.stringify(requestOriginSchema.parse(input.origin)),
          request.purpose,
          JSON.stringify(request.fields),
          JSON.stringify(destinations),
          expiresAt.toISOString(),
        ],
      );
      return { secretRequestId: id, destinations };
    },

    /** The form for the member a request is addressed to (P5-P8, P41). */
    async view(workspaceId: string, principal: SecretsPrincipal, id: string): Promise<SecretRequestView> {
      return internal.authorized(workspaceId, principal, async (tx, actor) => {
        let row = await loadRequest(tx, id);
        if (row.membership_id !== actor.membershipId) throw new AccessDenied();
        if (row.status === 'waiting' && row.expired) {
          await finish(tx, workspaceId, row, { status: 'expired' });
          row = await loadRequest(tx, id);
        }
        const fields = [];
        for (const field of row.fields)
          fields.push({
            ...field,
            placement: field.placement ?? null,
            options: row.status === 'waiting' ? await options(tx, actor, row, field) : [],
          });
        return {
          id: row.id,
          status: row.status,
          revision: row.revision,
          expiresAt: row.expires_at,
          purpose: row.purpose,
          destinations: row.destinations,
          fields,
          declineReason: row.decline_reason,
        };
      });
    },

    /** Stores new values, links chosen secrets and resumes the agent, all at once (P9, P12, P13, P41, P45). */
    async submit(workspaceId: string, principal: SecretsPrincipal, id: string, raw: SubmitRequestInput) {
      if (!secrets.capabilities().enabled) throw new SecretError('disabled');
      const input = submitRequestSchema.parse(raw);
      const shape = {
        id,
        expectedRevision: input.expectedRevision,
        fields: input.fields.map(field => ('value' in field ? { ...field, value: undefined } : field)),
      };
      return internal.authorized(workspaceId, principal, async (tx, actor) =>
        internal.command(
          tx,
          actor,
          input.requestId,
          'submit-request',
          shape,
          z.object({ status: z.literal('provided'), references: z.array(referenceSchema) }),
          async () => {
            const row = await loadRequest(tx, id);
            if (row.membership_id !== actor.membershipId) throw new AccessDenied();
            open(row);
            if (row.revision !== input.expectedRevision) throw new SecretError('conflict');
            const answers = new Map(input.fields.map(field => [field.fieldId, field]));
            if (answers.size !== input.fields.length || answers.size !== row.fields.length)
              throw new SecretError('invalid-input');
            const origin = secretOriginOf(row.origin);
            const references: SecretReference[] = [];
            for (const field of row.fields) {
              const answer = answers.get(field.id);
              if (!answer) throw new SecretError('invalid-input');
              if ('secretId' in answer) {
                const offered = await options(tx, actor, row, field);
                if (!offered.some(option => option.secretId === answer.secretId)) throw new AccessDenied();
                references.push(await reference(tx, row, field.id, answer.secretId));
                continue;
              }
              const placement = answer.placement ?? field.placement;
              if (!placement) throw new SecretError('placement-required');
              const chosen = answer.placement && !(field.placement && samePlacement(answer.placement, field.placement));
              const secretId = await internal.insert(tx, workspaceId, actor, {
                requestId: randomUUID(),
                name: answer.name ?? field.label,
                kind: field.kind,
                value: answer.value,
                placement,
                placementSource: chosen ? 'member' : 'agent',
                destinations: row.destinations.map(destination =>
                  destination.kind === 'host'
                    ? { kind: 'host', host: destination.value }
                    : { kind: 'endpoint', url: destination.value },
                ),
                lifetime: answer.lifetime === 'conversation' ? { kind: 'conversation', origin } : { kind: 'saved' },
                expiresAt: answer.expiresAt,
              });
              references.push(await reference(tx, row, field.id, secretId));
            }
            await finish(
              tx,
              workspaceId,
              row,
              { status: 'provided', references },
              { actor, commandId: input.requestId },
            );
            return { status: 'provided' as const, references };
          },
        ),
      );
    },

    /** The member declines; the agent continues without the secret (P10). */
    async decline(
      workspaceId: string,
      principal: SecretsPrincipal,
      id: string,
      raw: z.input<typeof declineRequestSchema>,
    ) {
      const input = declineRequestSchema.parse(raw);
      return internal.authorized(workspaceId, principal, async (tx, actor) =>
        internal.command(
          tx,
          actor,
          input.requestId,
          'decline-request',
          { id, ...input },
          z.object({ status: z.literal('declined') }),
          async () => {
            const row = await loadRequest(tx, id);
            if (row.membership_id !== actor.membershipId) throw new AccessDenied();
            open(row);
            if (row.revision !== input.expectedRevision) throw new SecretError('conflict');
            await finish(
              tx,
              workspaceId,
              row,
              { status: 'declined', reason: input.reason || null },
              { actor, commandId: input.requestId },
            );
            return { status: 'declined' as const };
          },
        ),
      );
    },

    /**
     * How a task's request ended, for the run that waits on it, in the caller's transaction. An overdue request is
     * expired here; `waiting` means the owner has not answered yet.
     */
    async outcome(
      tx: AuthorizationTransaction,
      workspaceId: string,
      id: string,
    ): Promise<{ status: 'waiting' } | RequestSettlement | undefined> {
      const found = await tx.client.query(`SELECT 1 FROM ${table(tx, 'requests')} WHERE id = $1`, [z.uuid().parse(id)]);
      if (!found.rowCount) return undefined;
      let row = await loadRequest(tx, id);
      if (row.status === 'waiting' && row.expired) {
        await finish(tx, workspaceId, row, { status: 'expired' });
        row = await loadRequest(tx, id);
      }
      if (row.status === 'waiting') return { status: 'waiting' };
      if (row.status === 'declined') return { status: 'declined', reason: row.decline_reason };
      if (row.status !== 'provided') return { status: row.status };
      const linked = z
        .array(z.object({ id: z.uuid(), field_id: z.string(), secret_id: z.uuid() }))
        .parse(
          (
            await tx.client.query(
              `SELECT id, field_id, secret_id FROM ${table(tx, 'references')} WHERE request_id = $1 ORDER BY created_at, id`,
              [row.id],
            )
          ).rows,
        );
      const references: SecretReference[] = [];
      for (const reference of linked)
        references.push(await describe(tx, reference.id, reference.field_id, reference.secret_id));
      return { status: 'provided', references };
    },

    /**
     * The forms a task's current run sent to this member, newest first, for the task page. Other members see none,
     * since only the owner may answer them.
     */
    async forTask(workspaceId: string, principal: SecretsPrincipal, taskId: string): Promise<TaskSecretRequest[]> {
      return internal.authorized(workspaceId, principal, async (tx, actor) => {
        const ids = z.array(z.object({ id: z.uuid() })).parse(
          (
            await tx.client.query(
              `SELECT q.id FROM ${table(tx, 'requests')} q
               JOIN ${qualified(tx.schema, 'tf_agent_task_runs')} b ON b.run_id = (q.origin->>'runId')::uuid
               JOIN ${qualified(tx.schema, 'tf_agent_tasks')} t ON t.id = b.task_id AND t.generation = b.generation
               WHERE q.membership_id = $1 AND q.origin->>'kind' = 'task' AND q.origin->>'taskId' = $2::text AND b.task_id = $2::uuid
               ORDER BY q.created_at DESC, q.id LIMIT 10`,
              [actor.membershipId, z.uuid().parse(taskId)],
            )
          ).rows,
        );
        const result: TaskSecretRequest[] = [];
        for (const { id } of ids) {
          let row = await loadRequest(tx, id);
          if (row.status === 'waiting' && row.expired) {
            await finish(tx, workspaceId, row, { status: 'expired' });
            row = await loadRequest(tx, id);
          }
          const linked = z
            .array(z.object({ id: z.uuid(), field_id: z.string(), secret_id: z.uuid() }))
            .parse(
              (
                await tx.client.query(
                  `SELECT id, field_id, secret_id FROM ${table(tx, 'references')} WHERE request_id = $1 ORDER BY created_at, id`,
                  [row.id],
                )
              ).rows,
            );
          const references = [];
          for (const reference of linked) {
            const described = await describe(tx, reference.id, reference.field_id, reference.secret_id);
            references.push({
              referenceId: described.referenceId,
              fieldId: described.fieldId,
              name: described.name,
              kind: described.kind,
            });
          }
          result.push({
            id: row.id,
            status: row.status,
            revision: row.revision,
            expiresAt: row.expires_at,
            purpose: row.purpose,
            declineReason: row.decline_reason,
            references,
          });
        }
        return result;
      });
    },

    /** Where a request a member may answer came from, so a task waiting on it can be woken. */
    async origin(workspaceId: string, principal: SecretsPrincipal, id: string): Promise<RequestOrigin> {
      return internal.authorized(workspaceId, principal, async (tx, actor) => {
        const row = await loadRequest(tx, id, false);
        if (row.membership_id !== actor.membershipId) throw new AccessDenied();
        return row.origin;
      });
    },

    /**
     * Cancels the open requests of a chat or task run and deletes its temporary secrets, in the caller's
     * transaction (P11, P46). The caller has already stopped the turn or run, so nothing is resumed.
     */
    endOrigin,

    /**
     * Expires overdue requests, ends the forms and temporary secrets of deleted chats and ended task runs, and
     * deletes expired secrets.
     * Run by the worker sweep (P11, P46, P47).
     */
    async sweep(workspaceId: string) {
      const expired = await secrets.transaction(workspaceId, async tx => {
        const rows = z.array(requestRowSchema).parse(
          (
            await tx.client.query(
              `SELECT *, true AS expired FROM ${table(tx, 'requests')} WHERE status = 'waiting'
               AND expires_at <= clock_timestamp() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED`,
            )
          ).rows,
        );
        let count = 0;
        for (const row of rows) if (await finish(tx, workspaceId, row, { status: 'expired' })) count++;
        return count;
      });
      const endedChats = await secrets.transaction(workspaceId, async tx => {
        const chats = z.array(z.object({ id: z.uuid() })).parse(
          (
            await tx.client.query(
              `SELECT DISTINCT o.id FROM (
                 SELECT (origin->>'conversationId')::uuid AS id FROM ${table(tx, 'requests')}
                 WHERE status = 'waiting' AND origin->>'kind' = 'chat'
                 UNION SELECT (origin->>'conversationId')::uuid FROM ${table(tx, 'secrets')}
                 WHERE status = 'active' AND lifetime = 'conversation' AND origin->>'kind' = 'chat'
               ) o JOIN ${qualified(tx.schema, 'tf_conversations')} c ON c.id = o.id
               WHERE c.deleted_at IS NOT NULL ORDER BY o.id LIMIT 100`,
            )
          ).rows,
        );
        for (const chat of chats) await endOrigin(tx, { kind: 'chat', conversationId: chat.id });
        return chats.length;
      });
      const endedRuns = await secrets.transaction(workspaceId, async tx => {
        const runs = z.array(z.object({ task_id: z.uuid(), run_id: z.uuid() })).parse(
          (
            await tx.client.query(
              `SELECT DISTINCT o.task_id, o.run_id FROM (
                 SELECT (origin->>'taskId')::uuid AS task_id, (origin->>'runId')::uuid AS run_id FROM ${table(tx, 'requests')}
                 WHERE status = 'waiting' AND origin->>'kind' = 'task'
                 UNION SELECT (origin->>'taskId')::uuid, (origin->>'runId')::uuid FROM ${table(tx, 'secrets')}
                 WHERE status = 'active' AND lifetime = 'conversation' AND origin->>'kind' = 'task'
               ) o LEFT JOIN ${qualified(tx.schema, 'tf_agent_runs')} r ON r.id = o.run_id
               LEFT JOIN ${qualified(tx.schema, 'tf_agent_task_runs')} b ON b.run_id = o.run_id AND b.task_id = o.task_id
               LEFT JOIN ${qualified(tx.schema, 'tf_agent_tasks')} t ON t.id = b.task_id
               WHERE r.id IS NULL OR r.status NOT IN ('ready', 'running', 'waiting') OR t.id IS NULL
                 OR t.generation <> b.generation OR t.status IN ('completed', 'failed')
               ORDER BY o.run_id LIMIT 100`,
            )
          ).rows,
        );
        for (const run of runs) await endOrigin(tx, { kind: 'task', taskId: run.task_id, runId: run.run_id });
        return runs.length;
      });
      return {
        expiredRequests: expired,
        endedChats,
        endedRuns,
        deletedSecrets: await secrets.sweepExpired(workspaceId),
      };
    },

    /** The references a member holds in this chat or task run, for `secrets.list` and `api.request` (P15). */
    async references(tx: SecretTransaction, membershipId: string, origin: SecretOrigin) {
      const rows = z
        .array(z.object({ id: z.uuid(), field_id: z.string(), secret_id: z.uuid(), origin: z.unknown() }))
        .parse(
          (
            await tx.client.query(
              `SELECT r.id, r.field_id, r.secret_id, r.origin FROM ${table(tx, 'references')} r
               JOIN ${table(tx, 'secrets')} s ON s.id = r.secret_id
               WHERE r.membership_id = $1 AND r.origin @> $2::jsonb AND s.status = 'active' ORDER BY r.created_at, r.id`,
              [z.uuid().parse(membershipId), JSON.stringify(origin)],
            )
          ).rows,
        );
      const result: (SecretReference & { variableName: string; status: 'active' | 'expired' | 'suspended' })[] = [];
      for (const row of rows) {
        const secret = await internal.load(tx, row.secret_id, 'none');
        const rights = await internal.access(tx, membershipId, secret);
        // Expired and suspended secrets stay listed so the agent can say why a call failed.
        if (rights.status === 'deleted' || (rights.status === 'active' && !rights.use)) continue;
        const destinations = z
          .array(z.object({ kind: z.enum(['host', 'endpoint']), value: z.string() }))
          .parse(
            (
              await tx.client.query(
                `SELECT kind, value FROM ${table(tx, 'destinations')} WHERE secret_id = $1 ORDER BY kind, value`,
                [secret.id],
              )
            ).rows,
          );
        result.push({
          referenceId: row.id,
          fieldId: row.field_id,
          name: secret.name,
          variableName: secret.variable_name,
          kind: secret.kind,
          placement: secret.placement,
          destinations,
          status: rights.status,
        });
      }
      return result;
    },
  };
}
export type SecretRequests = ReturnType<typeof createSecretRequests>;
