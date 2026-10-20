import { createHash, randomUUID } from 'node:crypto';
import { effectiveSelection, type EngineClock } from './rolling.ts';
import { systemClock } from '../host-ports.ts';
import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  denyMcpEgress,
  lockAuthorization,
  uuidSchema,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { qualified, type createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import {
  GoogleCorpusError,
  googleCorpusBindingSchema,
  googleCorpusSelectionSchema,
  googleCorpusCursorSchema,
  type GoogleCorpusProvider,
  type GoogleCorpusObservation,
  type GoogleCorpusKind,
} from '@tulipfarm/google-workspace/corpus';
import {
  googleKnowledgeConfigureSchema,
  googleKnowledgeManageSchema,
  googleKnowledgeSourceSchema,
  googleKnowledgeWorkSchema,
  googleKnowledgeStatusSchema,
  googleKnowledgeDocumentsSchema,
  type GoogleKnowledgeWork,
} from '../google-contracts.ts';
import { KnowledgeParseError, parseKnowledgeDocument } from '../parser.ts';
import {
  citationSchema,
  knowledgeLimits,
  KnowledgeAccountChanged,
  KnowledgeError,
  lexicalInput,
  revisionInput,
} from './contracts.ts';
import { createKnowledgeStore, type KnowledgeOptions, type ExternalSource } from './store.ts';

type Runtime = Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;
type Tx = Parameters<ReturnType<typeof createKnowledgeStore>['bind']>[0];
const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, `tf_knowledge_${name}`);
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const identity = (value: string) => {
  const h = digest(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const cursorSchema = z.strictObject({
  phase: z.enum(['listing', 'sweep']),
  page: googleCorpusCursorSchema.nullable(),
  folders: z.array(z.string().max(256)).max(10000),
  visited: z.array(z.string().max(256)).max(10000),
  after: z.string().max(256).nullable(),
  pages: z.number().int().min(0).max(20000),
});
const initialCursor = () =>
  cursorSchema.parse({ phase: 'listing', page: null, folders: [], visited: [], after: null, pages: 0 });
const sourceSchema = z.object({
  source_id: uuidSchema,
  binding: googleCorpusBindingSchema,
  selection: googleCorpusSelectionSchema,
  title: z.string(),
  fingerprint: z.string(),
  generation: z.number().int(),
  reconciliation: z.number().int(),
  cursor: cursorSchema,
  lease_token: uuidSchema.nullable(),
  lease_until: z.date().nullable(),
  next_attempt_at: z.date(),
  failure: z.string().nullable(),
  sync_state: z.enum(['queued', 'syncing', 'ready', 'failed']),
  owner_membership_id: uuidSchema,
  owner_user_id: z.string(),
  state: z.enum(['active', 'paused', 'removed', 'disconnected']),
  access_epoch: z.number().int(),
});
type Source = z.infer<typeof sourceSchema>;
const denial = (error: unknown) =>
  error instanceof GoogleCorpusError &&
  [
    'forbidden',
    'not-found',
    'outside-selection',
    'restricted',
    'stale-integration',
    'reconnect-required',
    'insufficient-scope',
    'unauthenticated',
  ].includes(error.code);

export function createGoogleKnowledge({
  runtime,
  provider,
  clock = systemClock,
  now = () => clock.now(),
  gate,
}: { runtime: Runtime; provider: GoogleCorpusProvider } & EngineClock) {
  async function requireExternalSource(tx: AuthorizationTransaction, actor: HumanActor, source: ExternalSource) {
    if (source.provider !== 'google') throw new AccessDenied();
    if (
      !(
        await tx.client.query(
          `SELECT 1 FROM ${table(tx, 'google_readers')} WHERE source_id=$1 AND membership_id=$2 AND user_id=$3`,
          [source.id, actor.membershipId, actor.userId],
        )
      ).rowCount
    )
      throw new AccessDenied();
  }
  async function requireExternalProof(tx: AuthorizationTransaction, actor: HumanActor, documentId: string) {
    if (
      !(
        await tx.client.query(
          `SELECT 1 FROM ${table(tx, 'google_eligible')} WHERE document_id=$1 AND membership_id=$2 AND user_id=$3`,
          [documentId, actor.membershipId, actor.userId],
        )
      ).rowCount
    )
      throw new KnowledgeError('permission-expired');
  }
  const authority = { requireExternalSource, requireExternalProof } satisfies Partial<KnowledgeOptions>;
  const store = createKnowledgeStore({ runtime, ...authority });
  async function transaction<T>(workspaceId: string, operation: (tx: Tx) => Promise<T>) {
    return runtime.transaction(uuidSchema.parse(workspaceId), commonCompatibility, async raw => {
      const tx = store.bind(raw);
      await lockAuthorization(tx, 'write');
      return operation(tx);
    });
  }
  async function memberTransaction<T>(
    workspaceId: string,
    userId: string,
    operation: (tx: Tx, actor: HumanActor) => Promise<T>,
  ) {
    return store.transaction(workspaceId, userId, true, async (tx, actor) => {
      return operation(tx, actor);
    });
  }
  async function source(tx: Tx, sourceId: string) {
    const row = sourceSchema
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT g.*,s.owner_membership_id,s.state,s.access_epoch,m.user_id AS owner_user_id FROM ${table(tx, 'google_sources')} g JOIN ${table(tx, 'sources')} s ON s.id=g.source_id JOIN ${qualified(tx.schema, 'tf_memberships')} m ON m.id=s.owner_membership_id WHERE g.source_id=$1`,
            [sourceId],
          )
        ).rows[0],
      );
    if (!row) throw new AccessDenied();
    return { ...row, selection: effectiveSelection(row.selection, now()) };
  }
  async function manager(tx: Tx, actor: HumanActor, sourceId: string) {
    const value = await source(tx, sourceId);
    if (value.owner_membership_id !== actor.membershipId || value.owner_user_id !== actor.userId)
      throw new AccessDenied();
    return value;
  }
  async function dto(tx: Tx, s: Source, canManage = true) {
    if (!canManage)
      return googleKnowledgeSourceSchema.parse({
        sourceId: s.source_id,
        title: 'Shared Google source',
        selection: null,
        memberIds: [],
        counts: null,
        canManage: false,
        state: s.state,
        syncState: s.sync_state,
        failure: s.failure ? 'unavailable' : null,
        nextAttemptAt: s.next_attempt_at.toISOString(),
      });
    const members = z
      .array(z.object({ membership_id: uuidSchema }))
      .parse(
        (
          await tx.client.query(
            `SELECT membership_id FROM ${table(tx, 'google_members')} WHERE source_id=$1 ORDER BY membership_id`,
            [s.source_id],
          )
        ).rows,
      );
    const counts = z
      .object({ total: z.number(), ready: z.number(), failed: z.number() })
      .parse(
        (
          await tx.client.query(
            `SELECT count(*)::int AS total,count(d.lexical_publication_id)::int AS ready,count(*) FILTER (WHERE i.failure IS NOT NULL)::int AS failed FROM ${table(tx, 'google_items')} i LEFT JOIN ${table(tx, 'documents')} d ON d.id=i.document_id AND d.tombstoned_at IS NULL WHERE i.source_id=$1`,
            [s.source_id],
          )
        ).rows[0],
      );
    return googleKnowledgeSourceSchema.parse({
      sourceId: s.source_id,
      selection: s.selection,
      memberIds: members.map(m => m.membership_id),
      title: s.title,
      canManage,
      state: s.state,
      syncState: s.sync_state,
      failure: s.failure,
      nextAttemptAt: s.next_attempt_at.toISOString(),
      counts,
    });
  }
  async function discover(workspaceId: string, userId: string, kind: GoogleCorpusKind, cursor?: string) {
    denyMcpEgress();
    await memberTransaction(workspaceId, userId, async () => undefined);
    return provider.discover(workspaceId, userId, kind, cursor);
  }
  async function configure(workspaceId: string, userId: string, value: unknown) {
    denyMcpEgress();
    const input = googleKnowledgeConfigureSchema.parse(value);
    const actor = await memberTransaction(workspaceId, userId, async (_tx, a) => a);
    const memberIds = [...new Set([...input.memberIds, actor.membershipId])].sort();
    if (input.selection.kind === 'gmail' && memberIds.some(id => id !== actor.membershipId)) throw new AccessDenied();
    const fingerprint = digest(JSON.stringify({ selection: input.selection, memberIds }));
    const replay = await memberTransaction(workspaceId, userId, async (tx, human) => {
      if (!(await tx.client.query(`SELECT 1 FROM ${table(tx, 'sources')} WHERE id=$1`, [input.commandId])).rowCount)
        return null;
      const prior = await manager(tx, human, input.commandId);
      if (prior.fingerprint !== fingerprint || prior.state === 'removed') throw new KnowledgeError('conflict');
      return dto(tx, prior);
    });
    if (replay) return replay;
    const inspected = await provider.inspectSelection(workspaceId, userId, input.selection);
    if (input.accountId !== undefined && inspected.binding.accountId !== input.accountId)
      throw new KnowledgeAccountChanged();
    return memberTransaction(workspaceId, userId, async (tx, human) => {
      if (human.membershipId !== actor.membershipId) throw new AccessDenied();
      const existing = await tx.client.query(`SELECT 1 FROM ${table(tx, 'sources')} WHERE id=$1`, [input.commandId]);
      if (existing.rowCount) {
        const prior = await manager(tx, human, input.commandId);
        if (prior.fingerprint !== fingerprint || prior.state === 'removed') throw new KnowledgeError('conflict');
        return dto(tx, prior);
      }
      const active = await tx.client.query(
        `SELECT id FROM ${qualified(tx.schema, 'tf_memberships')} WHERE id=ANY($1::uuid[]) AND removed_at IS NULL`,
        [memberIds],
      );
      if (active.rowCount !== memberIds.length) throw new AccessDenied();
      const count = z
        .object({ n: z.number() })
        .parse((await tx.client.query(`SELECT count(*)::int AS n FROM ${table(tx, 'sources')}`)).rows[0]).n;
      if (count >= knowledgeLimits.sources) throw new KnowledgeError('quota');
      const inserted = await tx.client.query(
        `INSERT INTO ${table(tx, 'sources')} (id,provider,account_namespace,selection,owner_membership_id) VALUES ($1,'google',$2,$3::jsonb::text,$4) ON CONFLICT DO NOTHING`,
        [input.commandId, inspected.binding.accountId, JSON.stringify(input.selection), human.membershipId],
      );
      if (!inserted.rowCount) throw new KnowledgeError('conflict');
      await tx.client.query(
        `INSERT INTO ${table(tx, 'google_sources')} (source_id,binding,selection,title,fingerprint,cursor) VALUES ($1,$2,$3,$4,$5,$6)`,
        [input.commandId, inspected.binding, input.selection, inspected.title, fingerprint, initialCursor()],
      );
      await tx.client.query(
        `INSERT INTO ${table(tx, 'google_members')} (source_id,membership_id) SELECT $1,unnest($2::uuid[])`,
        [input.commandId, memberIds],
      );
      await store.source(tx, human, input.commandId, true);
      return dto(tx, await source(tx, input.commandId));
    });
  }
  async function list(workspaceId: string, userId: string) {
    return memberTransaction(workspaceId, userId, async (tx, actor) => {
      const rows = z
        .array(z.object({ id: uuidSchema }))
        .parse(
          (
            await tx.client.query(
              `SELECT s.id FROM ${table(tx, 'sources')} s JOIN ${table(tx, 'google_sources')} g ON g.source_id=s.id WHERE s.owner_membership_id=$1 OR (s.state<>'removed' AND EXISTS (SELECT 1 FROM ${table(tx, 'google_members')} m WHERE m.source_id=s.id AND m.membership_id=$1)) ORDER BY s.id LIMIT 100`,
              [actor.membershipId],
            )
          ).rows,
        );
      return {
        items: await Promise.all(
          rows.map(async r => {
            const s = await source(tx, r.id);
            return dto(tx, s, s.owner_membership_id === actor.membershipId && s.owner_user_id === actor.userId);
          }),
        ),
      };
    });
  }
  async function manage(workspaceId: string, userId: string, sourceId: string, value: unknown) {
    denyMcpEgress();
    sourceId = uuidSchema.parse(sourceId);
    const input = googleKnowledgeManageSchema.parse(value);
    const fingerprint = digest(JSON.stringify({ sourceId, ...input }));
    const prior = await memberTransaction(workspaceId, userId, async (tx, actor) => {
      const s = await manager(tx, actor, sourceId);
      const replay = z
        .object({ fingerprint: z.string() })
        .optional()
        .parse(
          (
            await tx.client.query(`SELECT fingerprint FROM ${table(tx, 'google_commands')} WHERE command_id=$1`, [
              input.commandId,
            ])
          ).rows[0],
        );
      if (!replay) return null;
      if (replay.fingerprint !== fingerprint) throw new KnowledgeError('conflict');
      return dto(tx, s);
    });
    if (prior) return prior;
    const inspected =
      input.action === 'retry'
        ? await memberTransaction(workspaceId, userId, async (tx, actor) => manager(tx, actor, sourceId)).then(s =>
            provider.inspectSelection(workspaceId, userId, s.selection),
          )
        : null;
    return memberTransaction(workspaceId, userId, async (tx, actor) => {
      const s = await manager(tx, actor, sourceId);
      const replay = z
        .object({ fingerprint: z.string() })
        .optional()
        .parse(
          (
            await tx.client.query(`SELECT fingerprint FROM ${table(tx, 'google_commands')} WHERE command_id=$1`, [
              input.commandId,
            ])
          ).rows[0],
        );
      if (replay) {
        if (replay.fingerprint !== fingerprint) throw new KnowledgeError('conflict');
        return dto(tx, s);
      }
      if (s.state === 'removed') throw new KnowledgeError('conflict');
      if (inspected && inspected.binding.accountId !== s.binding.accountId) throw new AccessDenied();
      const state = input.action === 'remove' ? 'removed' : input.action === 'pause' ? 'paused' : 'active';
      await tx.client.query(
        `UPDATE ${table(tx, 'sources')} SET state=$2,access_epoch=access_epoch+1,removed_at=CASE WHEN $2='removed' THEN clock_timestamp() ELSE NULL END,retain_until=CASE WHEN $2='removed' THEN clock_timestamp()+interval '30 days' ELSE NULL END WHERE id=$1`,
        [sourceId, state],
      );
      if (state === 'removed')
        await tx.client.query(
          `UPDATE ${table(tx, 'documents')} SET tombstoned_at=clock_timestamp(),retain_until=clock_timestamp()+interval '30 days',lexical_publication_id=NULL,vector_publication_id=NULL WHERE source_id=$1`,
          [sourceId],
        );
      await tx.client.query(
        `UPDATE ${table(tx, 'google_sources')} SET generation=generation+1,lease_token=NULL,lease_until=NULL,next_attempt_at=clock_timestamp(),sync_state='queued',failure=NULL WHERE source_id=$1`,
        [sourceId],
      );
      if (inspected) {
        await tx.client.query(`UPDATE ${table(tx, 'google_sources')} SET binding=$2 WHERE source_id=$1`, [
          sourceId,
          inspected.binding,
        ]);
        await store.source(tx, actor, sourceId, true);
      }
      await tx.client.query(`INSERT INTO ${table(tx, 'google_commands')} VALUES ($1,$2,$3)`, [
        input.commandId,
        sourceId,
        fingerprint,
      ]);
      return dto(tx, await source(tx, sourceId));
    });
  }
  async function invalidate(tx: Tx, documentId: string, membershipId?: string) {
    await tx.client.query(
      `INSERT INTO ${table(tx, 'google_proof_fences')} (document_id,membership_id,generation)
      SELECT d.id,m.membership_id,1 FROM ${table(tx, 'documents')} d JOIN ${table(tx, 'google_members')} m ON m.source_id=d.source_id
      WHERE d.id=$1 AND ($2::uuid IS NULL OR m.membership_id=$2)
      ON CONFLICT(document_id,membership_id) DO UPDATE SET generation=${table(tx, 'google_proof_fences')}.generation+1`,
      [documentId, membershipId ?? null],
    );
    await tx.client.query(
      `DELETE FROM ${table(tx, 'access_proofs')} WHERE document_id=$1${membershipId ? ' AND membership_id=$2' : ''}`,
      [documentId, ...(membershipId ? [membershipId] : [])],
    );
  }
  async function clear(tx: Tx, documentId: string, tombstone = false) {
    await tx.client.query(
      `UPDATE ${table(tx, 'documents')} SET lexical_publication_id=NULL,vector_publication_id=NULL${tombstone ? ",tombstoned_at=clock_timestamp(),retain_until=clock_timestamp()+interval '30 days'" : ''} WHERE id=$1`,
      [documentId],
    );
    await invalidate(tx, documentId);
  }
  async function proof(workspaceId: string, actor: HumanActor, sourceId: string, documentId: string, nativeId: string) {
    const captured = await memberTransaction(workspaceId, actor.userId, async (tx, human) => {
      if (human.membershipId !== actor.membershipId) throw new AccessDenied();
      const s = await source(tx, sourceId);
      await store.source(tx, human, sourceId);
      const row = z
        .object({
          integration_id: uuidSchema,
          account_id: z.string(),
          generation: z.number(),
          scopes: z.array(z.string()),
        })
        .parse(
          (
            await tx.client.query(
              `SELECT * FROM ${table(tx, 'google_readers')} WHERE source_id=$1 AND membership_id=$2`,
              [sourceId, human.membershipId],
            )
          ).rows[0],
        );
      const allowed =
        s.selection.kind === 'gmail'
          ? [
              'https://www.googleapis.com/auth/gmail.readonly',
              'https://www.googleapis.com/auth/gmail.modify',
              'https://mail.google.com/',
            ]
          : ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive'];
      const binding = googleCorpusBindingSchema.parse({
        integrationId: row.integration_id,
        accountId: row.account_id,
        generation: row.generation,
        requiredScopes: [allowed.find(scope => row.scopes.includes(scope))],
      });
      await tx.client.query(
        `INSERT INTO ${table(tx, 'google_proof_fences')} (document_id,membership_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [documentId, human.membershipId],
      );
      const fence = z
        .object({ generation: z.string() })
        .parse(
          (
            await tx.client.query(
              `SELECT generation FROM ${table(tx, 'google_proof_fences')} WHERE document_id=$1 AND membership_id=$2`,
              [documentId, human.membershipId],
            )
          ).rows[0],
        );
      return { s, binding, fence: fence.generation };
    });
    let observed: GoogleCorpusObservation;
    try {
      observed = await provider.check(workspaceId, actor.userId, captured.binding, captured.s.selection, nativeId);
    } catch (error) {
      if (denial(error))
        await transaction(workspaceId, async tx => {
          const manager = actor.membershipId === captured.s.owner_membership_id;
          await invalidate(tx, documentId, manager ? undefined : actor.membershipId);
          if (manager && error instanceof GoogleCorpusError && ['not-found', 'outside-selection'].includes(error.code))
            await clear(tx, documentId, true);
        });
      throw error;
    }
    return memberTransaction(workspaceId, actor.userId, async (tx, human) => {
      const s = await source(tx, sourceId);
      await store.source(tx, human, sourceId);
      if (s.generation !== captured.s.generation || s.access_epoch !== captured.s.access_epoch)
        throw new KnowledgeError('superseded');
      const current = await tx.client.query(
        `SELECT 1 FROM ${table(tx, 'google_readers')} WHERE source_id=$1 AND membership_id=$2 AND integration_id=$3 AND account_id=$4 AND generation=$5 AND scopes @> $6::text[]`,
        [
          sourceId,
          human.membershipId,
          captured.binding.integrationId,
          captured.binding.accountId,
          captured.binding.generation,
          captured.binding.requiredScopes,
        ],
      );
      if (!current.rowCount) throw new AccessDenied();
      const checked = new Date(observed.accessedAt);
      const now = z
        .object({ now: z.date() })
        .parse((await tx.client.query('SELECT clock_timestamp() AS now')).rows[0]).now;
      if (!Number.isFinite(checked.getTime()) || checked > now || checked.getTime() + 300000 <= now.getTime())
        throw new KnowledgeError('permission-expired');
      const advanced = await tx.client.query(
        `UPDATE ${table(tx, 'google_proof_fences')} SET observed_at=$4 WHERE document_id=$1 AND membership_id=$2 AND generation=$3 AND (observed_at IS NULL OR observed_at<=$4)`,
        [documentId, human.membershipId, captured.fence, checked],
      );
      if (!advanced.rowCount) throw new KnowledgeError('superseded');
      const revision = z
        .object({ source_revision: z.string() })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT r.source_revision FROM ${table(tx, 'documents')} d JOIN ${table(tx, 'revisions')} r ON r.id=d.observed_revision_id WHERE d.id=$1`,
              [documentId],
            )
          ).rows[0],
        );
      if (revision && revision.source_revision !== observed.sourceRevision) {
        await clear(tx, documentId);
        return false;
      }
      await tx.client.query(
        `INSERT INTO ${table(tx, 'access_proofs')} (id,document_id,membership_id,access_epoch,principal,acl_version,membership_version,acl_checked_at,membership_checked_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9) ON CONFLICT(document_id,membership_id) DO UPDATE SET id=EXCLUDED.id,access_epoch=EXCLUDED.access_epoch,principal=EXCLUDED.principal,acl_version=EXCLUDED.acl_version,membership_version=EXCLUDED.membership_version,acl_checked_at=EXCLUDED.acl_checked_at,membership_checked_at=EXCLUDED.membership_checked_at,expires_at=EXCLUDED.expires_at`,
        [
          randomUUID(),
          documentId,
          human.membershipId,
          s.access_epoch,
          captured.binding.accountId,
          observed.sourceRevision,
          String(captured.binding.generation),
          checked,
          new Date(checked.getTime() + 300000),
        ],
      );
      await tx.client.query(
        `INSERT INTO ${table(tx, 'google_proof_bindings')} VALUES ($1,$2,$3) ON CONFLICT(document_id,membership_id) DO UPDATE SET binding=EXCLUDED.binding`,
        [documentId, human.membershipId, captured.binding],
      );
      return true;
    });
  }
  async function refresh(workspaceId: string, userId: string, sourceId: string) {
    denyMcpEgress();
    sourceId = uuidSchema.parse(sourceId);
    const captured = await memberTransaction(workspaceId, userId, async (tx, actor) => {
      await store.source(tx, actor, sourceId);
      await tx.client.query(
        `INSERT INTO ${table(tx, 'google_refresh')} (source_id,membership_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [sourceId, actor.membershipId],
      );
      const rows = z
        .array(z.object({ id: uuidSchema, native_id: z.string() }))
        .parse(
          (
            await tx.client.query(
              `SELECT d.id,d.native_id FROM ${table(tx, 'documents')} d JOIN ${table(tx, 'google_refresh')} f ON f.source_id=d.source_id AND f.membership_id=$2 WHERE d.source_id=$1 AND d.tombstoned_at IS NULL AND (f.after_id IS NULL OR d.id>f.after_id) AND f.next_attempt_at<=clock_timestamp() ORDER BY d.id LIMIT 20`,
              [sourceId, actor.membershipId],
            )
          ).rows,
        );
      return { actor, rows };
    });
    let refreshed = 0,
      unavailable = 0;
    for (const row of captured.rows) {
      try {
        if (await proof(workspaceId, captured.actor, sourceId, row.id, row.native_id)) refreshed++;
        else unavailable++;
      } catch (error) {
        if (
          !(error instanceof GoogleCorpusError) &&
          !(error instanceof AccessDenied) &&
          !(error instanceof KnowledgeError)
        )
          throw error;
        unavailable++;
        if (error instanceof GoogleCorpusError && error.code === 'rate-limited') {
          await transaction(workspaceId, tx =>
            tx.client.query(
              `UPDATE ${table(tx, 'google_refresh')} SET next_attempt_at=clock_timestamp()+$3::double precision*interval '1 millisecond' WHERE source_id=$1 AND membership_id=$2`,
              [sourceId, captured.actor.membershipId, Math.max(30000, error.retryAfterMs ?? 0)],
            ),
          );
          return { refreshed, unavailable, bounded: true };
        }
      }
    }
    await transaction(workspaceId, tx =>
      tx.client.query(`UPDATE ${table(tx, 'google_refresh')} SET after_id=$3 WHERE source_id=$1 AND membership_id=$2`, [
        sourceId,
        captured.actor.membershipId,
        captured.rows.length === 20 ? captured.rows.at(-1)?.id : null,
      ]),
    );
    return { refreshed, unavailable, bounded: true };
  }
  async function due(workspaceId: string): Promise<GoogleKnowledgeWork[]> {
    const held = gate ? await gate(workspaceId) : [];
    return transaction(workspaceId, async tx => {
      await tx.client.query(
        `UPDATE ${table(tx, 'google_sources')} SET generation=generation+1,lease_token=NULL,lease_until=NULL WHERE lease_until<=clock_timestamp()`,
      );
      const rows = z
        .array(z.object({ source_id: uuidSchema, generation: z.number() }))
        .parse(
          (
            await tx.client.query(
              `SELECT g.source_id,g.generation FROM ${table(tx, 'google_sources')} g JOIN ${table(tx, 'sources')} s ON s.id=g.source_id WHERE s.state='active' AND g.lease_token IS NULL AND g.next_attempt_at<=clock_timestamp() AND NOT g.source_id=ANY($1::uuid[]) ORDER BY g.next_attempt_at,g.source_id LIMIT 20`,
              [held],
            )
          ).rows,
        );
      return rows.map(row => ({ workspaceId, sourceId: row.source_id, generation: row.generation }));
    });
  }
  async function fenced<T>(
    work: GoogleKnowledgeWork,
    token: string,
    operation: (tx: Tx, s: Source, actor: HumanActor) => Promise<T>,
  ) {
    return transaction(work.workspaceId, async tx => {
      const s = await source(tx, work.sourceId);
      const owned = await tx.client.query(
        `SELECT 1 FROM ${table(tx, 'google_sources')} WHERE source_id=$1 AND generation=$2 AND lease_token=$3 AND lease_until>clock_timestamp()`,
        [work.sourceId, work.generation, token],
      );
      if (!owned.rowCount || s.state !== 'active') throw new KnowledgeError('superseded');
      const actor: HumanActor = { kind: 'human', membershipId: s.owner_membership_id, userId: s.owner_user_id };
      await currentMember(tx, actor);
      await store.source(tx, actor, s.source_id, true);
      return operation(tx, s, actor);
    });
  }
  async function ingest(work: GoogleKnowledgeWork, token: string, s: Source, item: GoogleCorpusObservation) {
    const documentId = identity(`${s.source_id}:${s.binding.accountId}:${item.nativeId}`);
    await fenced(work, token, async tx => {
      const prior = z
        .object({ source_revision: z.string() })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT source_revision FROM ${table(tx, 'google_items')} WHERE source_id=$1 AND native_id=$2`,
              [s.source_id, item.nativeId],
            )
          ).rows[0],
        );
      if (!prior) {
        const count = z
          .object({ n: z.number() })
          .parse((await tx.client.query(`SELECT count(*)::int AS n FROM ${table(tx, 'google_items')}`)).rows[0]).n;
        if (count >= 20000) throw new KnowledgeError('quota');
      }
      if (prior && (prior.source_revision !== item.sourceRevision || item.coverage !== 'supported'))
        await clear(tx, documentId);
      await tx.client.query(
        `INSERT INTO ${table(tx, 'google_items')} (source_id,native_id,source_revision,seen_generation,failure) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(source_id,native_id) DO UPDATE SET source_revision=EXCLUDED.source_revision,seen_generation=EXCLUDED.seen_generation,failure=CASE WHEN ${table(tx, 'google_items')}.source_revision=EXCLUDED.source_revision AND EXCLUDED.failure IS NULL THEN ${table(tx, 'google_items')}.failure ELSE EXCLUDED.failure END`,
        [
          s.source_id,
          item.nativeId,
          item.sourceRevision,
          s.reconciliation,
          item.coverage === 'supported' || item.kind === 'folder' ? null : item.coverage,
        ],
      );
    });
    if (item.coverage !== 'supported' || item.kind === 'folder') return;
    const previous = await fenced(work, token, async tx =>
      z
        .object({ id: uuidSchema, source_revision: z.string(), lexical_publication_id: uuidSchema.nullable() })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT r.id,r.source_revision,d.lexical_publication_id FROM ${table(tx, 'documents')} d JOIN ${table(tx, 'revisions')} r ON r.id=d.observed_revision_id WHERE d.id=$1 AND d.tombstoned_at IS NULL`,
              [documentId],
            )
          ).rows[0],
        ),
    );
    const actor: HumanActor = { kind: 'human', userId: s.owner_user_id, membershipId: s.owner_membership_id };
    if (previous?.source_revision === item.sourceRevision && previous.lexical_publication_id) {
      await proof(work.workspaceId, actor, s.source_id, documentId, item.nativeId);
      return;
    }
    if (previous?.source_revision === item.sourceRevision) {
      const terminal = await fenced(
        work,
        token,
        async tx =>
          (
            await tx.client.query(
              `SELECT 1 FROM ${table(tx, 'work')} WHERE revision_id=$1 AND (parsing='ocr-unavailable' OR (parsing='failed' AND failure<>'provider'))`,
              [previous.id],
            )
          ).rowCount,
      );
      if (terminal) {
        await proof(work.workspaceId, actor, s.source_id, documentId, item.nativeId);
        return;
      }
    }
    try {
      const read = await provider.read(work.workspaceId, s.owner_user_id, s.binding, s.selection, item.nativeId);
      if (read.sourceRevision !== item.sourceRevision) throw new GoogleCorpusError('source-changed');
      if (read.title.length > 512 || read.bytes.byteLength > knowledgeLimits.originalBytes)
        throw new KnowledgeError('quota');
      const revisionId = identity(`${documentId}:${read.sourceRevision}`);
      await fenced(work, token, async (tx, _s, human) => {
        const prior = z
          .object({ observed_revision_id: uuidSchema.nullable() })
          .optional()
          .parse(
            (
              await tx.client.query(`SELECT observed_revision_id FROM ${table(tx, 'documents')} WHERE id=$1`, [
                documentId,
              ])
            ).rows[0],
          );
        await tx.client.query(`UPDATE ${table(tx, 'documents')} SET tombstoned_at=NULL,retain_until=NULL WHERE id=$1`, [
          documentId,
        ]);
        const exists = await tx.client.query(`SELECT 1 FROM ${table(tx, 'google_originals')} WHERE revision_id=$1`, [
          revisionId,
        ]);
        if (!exists.rowCount) {
          await store.observe(
            tx,
            human,
            revisionInput.parse({
              id: revisionId,
              documentId,
              sourceId: s.source_id,
              nativeId: item.nativeId,
              expectedRevisionId: prior?.observed_revision_id ?? null,
              sourceRevision: read.sourceRevision,
              title: read.title,
              canonicalUrl: read.canonicalURL,
              original: { kind: 'object', key: revisionId, bytes: read.bytes.byteLength, sha256: digest(read.bytes) },
              parserProfile: {
                id: 'google-native-v1',
                engine: 'provider',
                version: '1',
                normalization: 'pending',
                ocr: 'disabled',
              },
              sources: [],
            }),
          );
          if (
            read.normalizedContent !== null &&
            Buffer.byteLength(read.normalizedContent) > knowledgeLimits.normalizedBytes
          )
            throw new KnowledgeError('quota');
          const total = z.object({ bytes: z.coerce.number() }).parse(
            (
              await tx.client.query(`SELECT
            (SELECT COALESCE(sum(original_bytes),0) FROM ${table(tx, 'revisions')})+
            (SELECT COALESCE(sum(octet_length(normalized_content)),0) FROM ${table(tx, 'google_originals')})+
            (SELECT COALESCE(sum(octet_length(markdown)),0) FROM ${table(tx, 'publications')})+
            (SELECT COALESCE(sum(octet_length(passage)+octet_length(heading)),0) FROM ${table(tx, 'chunks')}) AS bytes`)
            ).rows[0],
          ).bytes;
          if (
            total + (read.normalizedContent ? Buffer.byteLength(read.normalizedContent) : 0) >
            knowledgeLimits.retainedBytes
          )
            throw new KnowledgeError('quota');
          await tx.client.query(`INSERT INTO ${table(tx, 'google_originals')} VALUES ($1,$2,$3,$4,$5)`, [
            revisionId,
            read.bytes,
            read.filename,
            read.mediaType,
            read.normalizedContent,
          ]);
        } else
          await tx.client.query(
            `UPDATE ${table(tx, 'documents')} SET observed_revision_id=$2,lexical_publication_id=NULL,vector_publication_id=NULL WHERE id=$1`,
            [documentId, revisionId],
          );
        await tx.client.query(
          `UPDATE ${table(tx, 'google_items')} SET document_id=$3 WHERE source_id=$1 AND native_id=$2`,
          [s.source_id, item.nativeId, documentId],
        );
      });
      if (!(await proof(work.workspaceId, actor, s.source_id, documentId, item.nativeId)))
        throw new GoogleCorpusError('source-changed');
      const content = await fenced(work, token, async tx =>
        z
          .object({
            bytes: z.instanceof(Uint8Array),
            filename: z.string(),
            media_type: z.string(),
            normalized_content: z.string().nullable(),
          })
          .parse(
            (await tx.client.query(`SELECT * FROM ${table(tx, 'google_originals')} WHERE revision_id=$1`, [revisionId]))
              .rows[0],
          ),
      );
      const original = await fenced(
        work,
        token,
        async tx =>
          store.revisionRow.parse(
            (await tx.client.query(`SELECT * FROM ${table(tx, 'revisions')} WHERE id=$1`, [revisionId])).rows[0],
          ).original,
      );
      if (content.bytes.byteLength !== original.bytes || digest(content.bytes) !== original.sha256)
        throw new KnowledgeError('integrity');
      const parsed = await parseKnowledgeDocument(
        content.normalized_content === null
          ? { bytes: content.bytes, filename: content.filename, mediaType: content.media_type }
          : { bytes: Buffer.from(content.normalized_content), filename: 'message.md', mediaType: 'text/markdown' },
      );
      await fenced(work, token, async (tx, _s, human) => {
        const publicationId = identity(`google-publication:${revisionId}`);
        await store.publish(
          tx,
          human,
          lexicalInput.parse({
            id: publicationId,
            documentId,
            revisionId,
            markdown: parsed.markdown,
            pages: parsed.pages,
            tokens: parsed.tokens,
            chunks: parsed.chunks,
          }),
          { filename: content.filename },
        );
        await tx.client.query(`INSERT INTO ${table(tx, 'parse_profiles')} VALUES ($1,$2) ON CONFLICT DO NOTHING`, [
          publicationId,
          parsed.profile,
        ]);
        await tx.client.query(
          `UPDATE ${table(tx, 'google_items')} SET failure=NULL WHERE source_id=$1 AND native_id=$2`,
          [s.source_id, item.nativeId],
        );
      });
    } catch (error) {
      if (error instanceof KnowledgeError && error.code === 'superseded') throw error;
      await fenced(work, token, async tx => {
        if (denial(error)) {
          await invalidate(tx, documentId);
          if (error instanceof GoogleCorpusError && ['not-found', 'outside-selection'].includes(error.code))
            await clear(tx, documentId, true);
        }
        const failure =
          error instanceof KnowledgeParseError
            ? error.failure
            : error instanceof KnowledgeError && error.code === 'quota'
              ? 'resource-limited'
              : error instanceof GoogleCorpusError
                ? error.code
                : 'provider';
        await tx.client.query(
          `UPDATE ${table(tx, 'google_items')} SET failure=$3 WHERE source_id=$1 AND native_id=$2`,
          [s.source_id, item.nativeId, failure],
        );
        await tx.client.query(
          `UPDATE ${table(tx, 'work')} w SET parsing=$2,failure=$3 FROM ${table(tx, 'documents')} d WHERE d.id=$1 AND w.revision_id=d.observed_revision_id AND d.lexical_publication_id IS NULL`,
          [
            documentId,
            failure === 'ocr-required' ? 'ocr-unavailable' : 'failed',
            error instanceof KnowledgeParseError
              ? error.failure
              : failure === 'resource-limited'
                ? 'resource-limited'
                : 'provider',
          ],
        );
      });
      if (
        !(error instanceof KnowledgeParseError) &&
        !(error instanceof KnowledgeError && error.code === 'quota') &&
        !(
          error instanceof GoogleCorpusError &&
          [
            'unsupported',
            'restricted',
            'resource-key-required',
            'attachments-unsupported',
            'mime-unsupported',
            'not-found',
            'outside-selection',
            'response-too-large',
          ].includes(error.code)
        )
      )
        throw error;
    }
  }
  async function process(value: GoogleKnowledgeWork): Promise<{ disposition: 'ready' | 'retry' | 'stale' | 'busy' }> {
    denyMcpEgress();
    const work = googleKnowledgeWorkSchema.parse(value);
    const token = randomUUID();
    if (gate && (await gate(work.workspaceId)).includes(work.sourceId)) return { disposition: 'stale' };
    const claim = await transaction(work.workspaceId, async tx => {
      const s = await source(tx, work.sourceId);
      if (s.generation !== work.generation || s.state !== 'active') return 'stale';
      if (s.lease_token) return 'busy';
      if (s.next_attempt_at.getTime() > clock.now()) return 'busy';
      await tx.client.query(
        `UPDATE ${table(tx, 'google_sources')} SET lease_token=$2,lease_until=clock_timestamp()+interval '15 minutes',sync_state='syncing' WHERE source_id=$1`,
        [s.source_id, token],
      );
      return s;
    });
    if (typeof claim === 'string') return { disposition: claim };
    try {
      await fenced(work, token, async () => undefined);
      await refresh(work.workspaceId, claim.owner_user_id, claim.source_id);
      const cursor = claim.cursor;
      if (cursor.phase === 'listing') {
        if (cursor.pages >= 20000) throw new KnowledgeError('quota');
        cursor.pages++;
        const queuedFolder =
          claim.selection.kind === 'drive-folder' &&
          cursor.page?.folderId &&
          cursor.page.folderId !== claim.selection.folderId
            ? cursor.page.folderId
            : null;
        let page;
        try {
          page = await provider.list(
            work.workspaceId,
            claim.owner_user_id,
            claim.binding,
            claim.selection,
            cursor.page,
          );
        } catch (error) {
          if (
            !queuedFolder ||
            !(error instanceof GoogleCorpusError) ||
            !['not-found', 'outside-selection'].includes(error.code)
          )
            throw error;
          page = { observations: [], nextCursor: null };
        }
        for (const item of page.observations) {
          await ingest(work, token, claim, item);
          if (
            claim.selection.kind === 'drive-folder' &&
            item.kind === 'folder' &&
            !cursor.visited.includes(item.nativeId) &&
            !cursor.folders.includes(item.nativeId)
          )
            cursor.folders.push(item.nativeId);
        }
        if (page.nextCursor) cursor.page = page.nextCursor;
        else {
          if (cursor.page?.folderId) cursor.visited.push(cursor.page.folderId);
          const next = cursor.folders.shift();
          if (next) cursor.page = { pageToken: null, folderId: next };
          else {
            cursor.phase = 'sweep';
            cursor.page = null;
          }
        }
      } else {
        const rows = await fenced(work, token, async tx =>
          z
            .array(z.object({ native_id: z.string(), document_id: uuidSchema.nullable() }))
            .parse(
              (
                await tx.client.query(
                  `SELECT native_id,document_id FROM ${table(tx, 'google_items')} WHERE source_id=$1 AND seen_generation<>$2 AND ($3::text IS NULL OR native_id>$3) ORDER BY native_id LIMIT 20`,
                  [claim.source_id, claim.reconciliation, cursor.after],
                )
              ).rows,
            ),
        );
        for (const row of rows) {
          try {
            const observed = await provider.check(
              work.workspaceId,
              claim.owner_user_id,
              claim.binding,
              claim.selection,
              row.native_id,
            );
            await ingest(work, token, claim, observed);
          } catch (error) {
            if (
              !(error instanceof GoogleCorpusError) ||
              !['not-found', 'outside-selection', 'unsupported'].includes(error.code)
            )
              throw error;
            const documentId = row.document_id;
            if (documentId && error.code !== 'unsupported')
              await fenced(work, token, tx => clear(tx, documentId, true));
          }
          cursor.after = row.native_id;
        }
        if (rows.length < 20) {
          await fenced(work, token, async tx => {
            await tx.client.query(
              `UPDATE ${table(tx, 'google_sources')} SET cursor=$2,reconciliation=reconciliation+1,generation=generation+1,lease_token=NULL,lease_until=NULL,sync_state='ready',failure=NULL,next_attempt_at=clock_timestamp()+interval '1 minute' WHERE source_id=$1`,
              [claim.source_id, initialCursor()],
            );
          });
          return { disposition: 'ready' };
        }
      }
      cursorSchema.parse(cursor);
      await fenced(work, token, async tx => {
        await tx.client.query(
          `UPDATE ${table(tx, 'google_sources')} SET cursor=$2,generation=generation+1,lease_token=NULL,lease_until=NULL,next_attempt_at=clock_timestamp(),failure=NULL WHERE source_id=$1`,
          [claim.source_id, cursor],
        );
      });
      return { disposition: 'retry' };
    } catch (error) {
      return transaction(work.workspaceId, async tx => {
        const current = await source(tx, work.sourceId);
        if (current.generation !== work.generation || current.lease_token !== token) return { disposition: 'stale' };
        const failure =
          error instanceof GoogleCorpusError ? error.code : error instanceof KnowledgeError ? error.code : 'provider';
        if (denial(error))
          await tx.client.query(`UPDATE ${table(tx, 'sources')} SET access_epoch=access_epoch+1 WHERE id=$1`, [
            work.sourceId,
          ]);
        const invalidCursor = failure === 'invalid-cursor';
        await tx.client.query(
          `UPDATE ${table(tx, 'google_sources')} SET generation=generation+1,lease_token=NULL,lease_until=NULL,sync_state='failed',failure=$2,next_attempt_at=clock_timestamp()+$3::double precision*interval '1 millisecond',cursor=CASE WHEN $4 THEN $5::jsonb ELSE cursor END,reconciliation=reconciliation+CASE WHEN $4 THEN 1 ELSE 0 END WHERE source_id=$1`,
          [
            work.sourceId,
            failure,
            Math.max(30000, error instanceof GoogleCorpusError ? (error.retryAfterMs ?? 0) : 0),
            invalidCursor,
            initialCursor(),
          ],
        );
        return { disposition: 'retry' };
      });
    }
  }
  async function evidence(workspaceId: string, userId: string, value: unknown) {
    const citation = citationSchema.parse(value);
    return memberTransaction(workspaceId, userId, async (tx, actor) => {
      const { revision } = await store.eligible(tx, actor, citation);
      const row = z
        .object({ passage: z.string(), heading: z.string(), expires_at: z.date() })
        .parse(
          (
            await tx.client.query(
              `SELECT k.passage,k.heading,e.expires_at FROM ${table(tx, 'chunks')} k JOIN ${table(tx, 'google_eligible')} e ON e.document_id=$1 AND e.membership_id=$2 WHERE k.publication_id=$3 AND k.ordinal=$4`,
              [citation.documentId, actor.membershipId, citation.publicationId, citation.ordinal],
            )
          ).rows[0],
        );
      await requireExternalProof(tx, actor, citation.documentId);
      return {
        title: revision.title,
        text: row.passage,
        heading: row.heading,
        citation,
        original: { kind: 'google' as const },
        validUntil: row.expires_at.toISOString(),
      };
    });
  }
  async function original(workspaceId: string, userId: string, documentId: string, revisionId: string) {
    documentId = uuidSchema.parse(documentId);
    revisionId = uuidSchema.parse(revisionId);
    return memberTransaction(workspaceId, userId, async (tx, actor) => {
      const doc = await store.document(tx, documentId);
      await store.source(tx, actor, doc.source_id);
      await requireExternalProof(tx, actor, doc.id);
      if (doc.observed_revision_id !== revisionId) throw new KnowledgeError('superseded');
      const revision = store.revisionRow.parse(
        (await tx.client.query(`SELECT * FROM ${table(tx, 'revisions')} WHERE id=$1`, [revisionId])).rows[0],
      );
      await store.dependencies(tx, actor, revision);
      const row = z
        .object({ bytes: z.instanceof(Uint8Array), filename: z.string(), media_type: z.string() })
        .parse(
          (await tx.client.query(`SELECT * FROM ${table(tx, 'google_originals')} WHERE revision_id=$1`, [revisionId]))
            .rows[0],
        );
      if (row.bytes.byteLength !== revision.original.bytes || digest(row.bytes) !== revision.original.sha256)
        throw new KnowledgeError('integrity');
      await requireExternalProof(tx, actor, doc.id);
      return { bytes: row.bytes, filename: row.filename, mediaType: row.media_type };
    });
  }
  async function status(workspaceId: string, userId: string, documentId: string) {
    documentId = uuidSchema.parse(documentId);
    return memberTransaction(workspaceId, userId, async (tx, actor) => {
      const doc = await store.document(tx, documentId);
      await store.source(tx, actor, doc.source_id);
      await requireExternalProof(tx, actor, doc.id);
      const revision = store.revisionRow.parse(
        (await tx.client.query(`SELECT * FROM ${table(tx, 'revisions')} WHERE id=$1`, [doc.observed_revision_id]))
          .rows[0],
      );
      await store.dependencies(tx, actor, revision);
      const work = z
        .object({ parsing: z.string(), embedding: z.string(), failure: z.string().nullable() })
        .parse(
          (await tx.client.query(`SELECT * FROM ${table(tx, 'work')} WHERE revision_id=$1`, [revision.id])).rows[0],
        );
      await requireExternalProof(tx, actor, doc.id);
      return googleKnowledgeStatusSchema.parse({
        documentId,
        revisionId: revision.id,
        title: revision.title,
        publicationId: doc.lexical_publication_id,
        ...work,
      });
    });
  }
  async function listDocuments(workspaceId: string, userId: string, sourceId: string, cursor?: string) {
    sourceId = uuidSchema.parse(sourceId);
    const after = cursor === undefined ? null : uuidSchema.parse(cursor);
    return memberTransaction(workspaceId, userId, async (tx, actor) => {
      const s = await source(tx, sourceId);
      await store.source(tx, actor, sourceId);
      const rows = z.array(z.object({ id: uuidSchema })).parse(
        (
          await tx.client.query(
            `SELECT d.id FROM ${table(tx, 'documents')} d
        JOIN ${table(tx, 'google_eligible')} e ON e.document_id=d.id AND e.membership_id=$2 AND e.user_id=$3
        WHERE d.source_id=$1 AND ($4::uuid IS NULL OR d.id>$4) ORDER BY d.id LIMIT 21`,
            [sourceId, actor.membershipId, actor.userId, after],
          )
        ).rows,
      );
      const items = [];
      for (const row of rows.slice(0, 20)) {
        const doc = await store.document(tx, row.id);
        const revision = store.revisionRow.parse(
          (await tx.client.query(`SELECT * FROM ${table(tx, 'revisions')} WHERE id=$1`, [doc.observed_revision_id]))
            .rows[0],
        );
        await store.dependencies(tx, actor, revision);
        const work = z
          .object({ parsing: z.string(), embedding: z.string(), failure: z.string().nullable() })
          .parse(
            (await tx.client.query(`SELECT * FROM ${table(tx, 'work')} WHERE revision_id=$1`, [revision.id])).rows[0],
          );
        const canRetry =
          s.owner_membership_id === actor.membershipId &&
          s.state === 'active' &&
          work.parsing === 'failed' &&
          work.failure === 'provider';
        items.push({
          documentId: doc.id,
          revisionId: revision.id,
          title: revision.title,
          publicationId: doc.lexical_publication_id,
          ...work,
          canRetry,
        });
      }
      for (const item of items) await requireExternalProof(tx, actor, item.documentId);
      return googleKnowledgeDocumentsSchema.parse({
        items,
        nextCursor: rows.length > 20 ? items.at(-1)?.documentId : null,
      });
    });
  }
  return {
    discover,
    configure,
    list,
    listDocuments,
    manage,
    due,
    process,
    evidence,
    original,
    refresh,
    status,
    authority,
  };
}
export type GoogleKnowledge = ReturnType<typeof createGoogleKnowledge>;
