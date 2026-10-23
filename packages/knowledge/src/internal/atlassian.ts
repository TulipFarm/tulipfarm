import { createHash, randomUUID } from 'node:crypto';
import { effectiveSelection, type EngineClock } from './rolling.ts';
import { systemClock } from '../host-ports.ts';
import { z } from 'zod';
import { createAtlassianCorpusAdapter } from '../corpus-adapters.ts';
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
  AtlassianCorpusError,
  atlassianCorpusBindingSchema,
  atlassianCorpusLimits as limits,
  atlassianCorpusSelectionSchema,
  atlassianCursorTokenSchema,
  atlassianKnowledgeConfigureSchema,
  atlassianKnowledgeDocumentsSchema,
  atlassianKnowledgeManageSchema,
  atlassianKnowledgeSourceSchema,
  atlassianKnowledgeStatusSchema,
  atlassianKnowledgeWorkSchema,
  atlassianProductSchema,
  atlassianTargetKey,
  type AtlassianCorpusBinding,
  type AtlassianCorpusProvider,
  type AtlassianCorpusSelection,
  type AtlassianDiscoverKind,
  type AtlassianItemObservation,
  type AtlassianItemRead,
  type AtlassianKnowledgeWork,
  type AtlassianSelectedTarget,
} from '../atlassian-contracts.ts';
import { KnowledgeParseError, parseKnowledgeDocument } from '../parser.ts';
import { citationSchema, KnowledgeAccountChanged, KnowledgeError, lexicalInput, revisionInput } from './contracts.ts';
import { importStatus } from './import-status.ts';
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
  index: z.number().int().min(0).max(limits.targets),
  page: atlassianCursorTokenSchema.nullable(),
  after: z.string().max(128).nullable(),
  pages: z.number().int().min(0).max(20000),
});
const initialCursor = () => cursorSchema.parse({ phase: 'listing', index: 0, page: null, after: null, pages: 0 });
const sourceSchema = z.object({
  source_id: uuidSchema,
  product: atlassianProductSchema,
  binding: atlassianCorpusBindingSchema,
  selection: atlassianCorpusSelectionSchema,
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
const targetRowSchema = z.object({
  target_id: z.string(),
  kind: z.enum(['space', 'page', 'project']),
  key: z.string().nullable(),
  title: z.string(),
  descendants: z.boolean(),
  state: z.enum(['active', 'unavailable']),
  failure: z.string().nullable(),
});
const readerSchema = z.object({
  account_id: uuidSchema,
  account_generation: z.number().int(),
  atlassian_account_id: z.string(),
});
type Source = z.infer<typeof sourceSchema>;
type TargetRow = z.infer<typeof targetRowSchema>;
const credentialDenials = [
  'unauthenticated',
  'insufficient-scope',
  'not-linked',
  'stale-integration',
  'reconnect-required',
  'not-configured',
];
const itemGone = ['forbidden', 'not-found', 'outside-selection'];
const credentialDenied = (error: unknown): error is AtlassianCorpusError =>
  error instanceof AtlassianCorpusError && credentialDenials.includes(error.code);
/** Errors that stop the whole work item. Everything else is recorded on the single page or issue. */
const fatal = (error: unknown) =>
  credentialDenied(error) ||
  (error instanceof AtlassianCorpusError && error.code === 'rate-limited') ||
  (error instanceof KnowledgeError && error.code === 'superseded');
const itemOf = (nativeId: string) => nativeId.slice(nativeId.indexOf(':') + 1);
const selected = (t: TargetRow): AtlassianSelectedTarget => ({
  kind: t.kind,
  id: itemOf(t.target_id),
  descendants: t.descendants,
  key: t.key,
});

export function createAtlassianKnowledge({
  runtime,
  provider,
  clock = systemClock,
  now = () => clock.now(),
  gate,
}: { runtime: Runtime; provider: AtlassianCorpusProvider } & EngineClock) {
  const corpus = createAtlassianCorpusAdapter(provider);
  async function requireExternalSource(tx: AuthorizationTransaction, actor: HumanActor, source: ExternalSource) {
    if (source.provider !== 'confluence' && source.provider !== 'jira') throw new AccessDenied();
    if (
      !(
        await tx.client.query(
          `SELECT 1 FROM ${table(tx, 'atlassian_readers')} WHERE source_id=$1 AND membership_id=$2 AND user_id=$3`,
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
          `SELECT 1 FROM ${table(tx, 'atlassian_eligible')} WHERE document_id=$1 AND membership_id=$2 AND user_id=$3`,
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
            `SELECT g.*,s.owner_membership_id,s.state,s.access_epoch,m.user_id AS owner_user_id FROM ${table(tx, 'atlassian_sources')} g JOIN ${table(tx, 'sources')} s ON s.id=g.source_id JOIN ${qualified(tx.schema, 'tf_memberships')} m ON m.id=s.owner_membership_id WHERE g.source_id=$1`,
            [sourceId],
          )
        ).rows[0],
      );
    if (!row) throw new AccessDenied();
    return { ...row, selection: effectiveSelection(row.selection, now()) };
  }
  async function targets(tx: Tx, sourceId: string) {
    return z
      .array(targetRowSchema)
      .parse(
        (
          await tx.client.query(
            `SELECT target_id,kind,key,title,descendants,state,failure FROM ${table(tx, 'atlassian_targets')} WHERE source_id=$1 ORDER BY target_id`,
            [sourceId],
          )
        ).rows,
      );
  }
  async function manager(tx: Tx, actor: HumanActor, sourceId: string) {
    const value = await source(tx, sourceId);
    if (value.owner_membership_id !== actor.membershipId || value.owner_user_id !== actor.userId)
      throw new AccessDenied();
    return value;
  }
  async function dto(tx: Tx, s: Source, canManage = true) {
    if (!canManage)
      return atlassianKnowledgeSourceSchema.parse({
        sourceId: s.source_id,
        product: s.product,
        title: s.product === 'jira' ? 'Shared Jira source' : 'Shared Confluence source',
        selection: null,
        memberIds: [],
        counts: null,
        targets: null,
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
            `SELECT membership_id FROM ${table(tx, 'atlassian_members')} WHERE source_id=$1 ORDER BY membership_id`,
            [s.source_id],
          )
        ).rows,
      );
    const counts = z
      .object({ total: z.number(), ready: z.number(), failed: z.number() })
      .parse(
        (
          await tx.client.query(
            `SELECT count(*)::int AS total,count(d.lexical_publication_id)::int AS ready,count(*) FILTER (WHERE i.failure IS NOT NULL)::int AS failed FROM ${table(tx, 'atlassian_items')} i LEFT JOIN ${table(tx, 'documents')} d ON d.id=i.document_id AND d.tombstoned_at IS NULL WHERE i.source_id=$1`,
            [s.source_id],
          )
        ).rows[0],
      );
    const listed = (await targets(tx, s.source_id)).map(t => ({
      kind: t.kind,
      id: itemOf(t.target_id),
      key: t.key,
      title: t.title,
      descendants: t.descendants,
      state: t.state,
      failure: t.failure,
    }));
    return atlassianKnowledgeSourceSchema.parse({
      sourceId: s.source_id,
      product: s.product,
      selection: s.selection,
      memberIds: members.map(m => m.membership_id),
      title: s.title,
      canManage,
      state: s.state,
      syncState: s.sync_state,
      failure: s.failure,
      nextAttemptAt: s.next_attempt_at.toISOString(),
      targets: listed,
      counts,
    });
  }
  async function sites(workspaceId: string, userId: string, scope?: { account?: string }) {
    denyMcpEgress();
    await memberTransaction(workspaceId, userId, async () => undefined);
    return scope ? provider.sites(workspaceId, userId, scope) : provider.sites(workspaceId, userId);
  }
  async function discover(
    workspaceId: string,
    userId: string,
    cloudId: string,
    kind: AtlassianDiscoverKind,
    within?: string,
    cursor?: string,
    scope?: { account?: string },
  ) {
    denyMcpEgress();
    await memberTransaction(workspaceId, userId, async () => undefined);
    return scope
      ? provider.discover(workspaceId, userId, cloudId, kind, within, cursor, scope)
      : provider.discover(workspaceId, userId, cloudId, kind, within, cursor);
  }
  async function configure(workspaceId: string, userId: string, value: unknown) {
    denyMcpEgress();
    const input = atlassianKnowledgeConfigureSchema.parse(value);
    const actor = await memberTransaction(workspaceId, userId, async (_tx, a) => a);
    const memberIds = [...new Set([...input.memberIds, actor.membershipId])].sort();
    const fingerprint = digest(JSON.stringify({ selection: input.selection, memberIds }));
    const prior = async (tx: Tx, human: HumanActor) => {
      if (!(await tx.client.query(`SELECT 1 FROM ${table(tx, 'sources')} WHERE id=$1`, [input.commandId])).rowCount)
        return null;
      const existing = await manager(tx, human, input.commandId);
      if (existing.fingerprint !== fingerprint || existing.state === 'removed') throw new KnowledgeError('conflict');
      return dto(tx, existing);
    };
    const replay = await memberTransaction(workspaceId, userId, prior);
    if (replay) return replay;
    const inspected =
      input.accountId === undefined
        ? await provider.inspectSelection(workspaceId, userId, input.selection)
        : await provider.inspectSelection(workspaceId, userId, input.selection, { account: input.accountId });
    if (input.accountId !== undefined && inspected.binding.accountId !== input.accountId)
      throw new KnowledgeAccountChanged();
    if (
      inspected.binding.cloudId !== input.selection.cloudId ||
      inspected.targets.length !== input.selection.targets.length ||
      inspected.targets.some((t, i) => {
        const want = input.selection.targets[i];
        return !want || t.kind !== want.kind || t.id !== want.id;
      })
    )
      throw new AtlassianCorpusError('invalid-selection');
    return memberTransaction(workspaceId, userId, async (tx, human) => {
      if (human.membershipId !== actor.membershipId) throw new AccessDenied();
      const again = await prior(tx, human);
      if (again) return again;
      const linked = await tx.client.query(
        `SELECT 1 FROM ${qualified(tx.schema, 'tf_atlassian_accounts')} WHERE id=$1 AND protocol='atlassian-rest' AND ownership='personal' AND owner_membership_id=$2
        AND state IN ('active','refreshing') AND identity->>'qualification'='verified' AND identity->>'id'=$3 AND resources @> jsonb_build_array(jsonb_build_object('id',$4::text))`,
        [
          inspected.binding.accountId,
          human.membershipId,
          inspected.binding.atlassianAccountId,
          inspected.binding.cloudId,
        ],
      );
      if (!linked.rowCount) throw new AtlassianCorpusError('stale-integration');
      const active = await tx.client.query(
        `SELECT id FROM ${qualified(tx.schema, 'tf_memberships')} WHERE id=ANY($1::uuid[]) AND removed_at IS NULL`,
        [memberIds],
      );
      if (active.rowCount !== memberIds.length) throw new AccessDenied();
      const inserted = await tx.client.query(
        `INSERT INTO ${table(tx, 'sources')} (id,provider,account_namespace,selection,owner_membership_id) VALUES ($1,$2,$3,$4::jsonb::text,$5) ON CONFLICT DO NOTHING`,
        [
          input.commandId,
          input.selection.product,
          input.selection.cloudId,
          JSON.stringify(input.selection),
          human.membershipId,
        ],
      );
      if (!inserted.rowCount) throw new KnowledgeError('conflict');
      await tx.client.query(
        `INSERT INTO ${table(tx, 'atlassian_sources')} (source_id,product,binding,selection,title,fingerprint,cursor) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          input.commandId,
          input.selection.product,
          inspected.binding,
          input.selection,
          inspected.title.slice(0, 2048) ||
            (input.selection.product === 'jira' ? 'Jira projects' : 'Confluence content'),
          fingerprint,
          initialCursor(),
        ],
      );
      await tx.client.query(
        `INSERT INTO ${table(tx, 'atlassian_members')} (source_id,membership_id) SELECT $1,unnest($2::uuid[])`,
        [input.commandId, memberIds],
      );
      for (const [index, t] of inspected.targets.entries())
        await tx.client.query(
          `INSERT INTO ${table(tx, 'atlassian_targets')} (source_id,target_id,kind,key,title,descendants) VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            input.commandId,
            atlassianTargetKey(t),
            t.kind,
            t.key?.slice(0, 255) ?? null,
            t.title.slice(0, 512) || atlassianTargetKey(t),
            input.selection.targets[index]?.descendants ?? false,
          ],
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
              `SELECT s.id FROM ${table(tx, 'sources')} s JOIN ${table(tx, 'atlassian_sources')} g ON g.source_id=s.id WHERE s.owner_membership_id=$1 OR (s.state<>'removed' AND EXISTS (SELECT 1 FROM ${table(tx, 'atlassian_members')} m WHERE m.source_id=s.id AND m.membership_id=$1)) ORDER BY s.id LIMIT 100`,
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
  // Denials and local changes raise the fence generation and remove copied document proofs at once.
  async function invalidate(
    tx: Tx,
    sourceId: string,
    scope: { nativeIds?: string[]; targetId?: string; membershipId?: string },
  ) {
    await tx.client.query(
      `UPDATE ${table(tx, 'atlassian_access')} a SET generation=a.generation+1,binding=NULL,observed_at=NULL,expires_at=NULL
      FROM ${table(tx, 'atlassian_items')} i WHERE i.source_id=a.source_id AND i.native_id=a.native_id AND a.source_id=$1
        AND ($2::text[] IS NULL OR a.native_id=ANY($2::text[])) AND ($3::text IS NULL OR i.target_id=$3) AND ($4::uuid IS NULL OR a.membership_id=$4)`,
      [sourceId, scope.nativeIds ?? null, scope.targetId ?? null, scope.membershipId ?? null],
    );
    await tx.client.query(
      `DELETE FROM ${table(tx, 'access_proofs')} p USING ${table(tx, 'atlassian_items')} i
      WHERE i.source_id=$1 AND ($2::text[] IS NULL OR i.native_id=ANY($2::text[])) AND ($3::text IS NULL OR i.target_id=$3) AND p.document_id=i.document_id AND ($4::uuid IS NULL OR p.membership_id=$4)`,
      [sourceId, scope.nativeIds ?? null, scope.targetId ?? null, scope.membershipId ?? null],
    );
  }
  async function unavailableTarget(tx: Tx, sourceId: string, targetId: string, failure: string) {
    await tx.client.query(
      `UPDATE ${table(tx, 'atlassian_targets')} SET state='unavailable',failure=$3 WHERE source_id=$1 AND target_id=$2`,
      [sourceId, targetId, failure],
    );
    await invalidate(tx, sourceId, { targetId });
  }
  // Copies a still-current authoritative item check onto the current document revision. Expiry is never extended.
  async function project(tx: Tx, sourceId: string, nativeIds: string[] | null, membershipId?: string) {
    await tx.client.query(
      `INSERT INTO ${table(tx, 'access_proofs')} (id,document_id,membership_id,access_epoch,principal,acl_version,membership_version,acl_checked_at,membership_checked_at,expires_at)
      SELECT gen_random_uuid(),d.id,x.membership_id,s.access_epoch,x.binding->>'atlassianAccountId',r.source_revision,x.binding->>'accountGeneration',x.observed_at,x.observed_at,x.expires_at
      FROM ${table(tx, 'atlassian_access')} x
      JOIN ${table(tx, 'atlassian_items')} i ON i.source_id=x.source_id AND i.native_id=x.native_id
      JOIN ${table(tx, 'atlassian_targets')} t ON t.source_id=i.source_id AND t.target_id=i.target_id AND t.state='active'
      JOIN ${table(tx, 'documents')} d ON d.id=i.document_id AND d.tombstoned_at IS NULL
      JOIN ${table(tx, 'revisions')} r ON r.id=d.observed_revision_id
      JOIN ${table(tx, 'sources')} s ON s.id=x.source_id
      WHERE x.source_id=$1 AND ($2::text[] IS NULL OR x.native_id=ANY($2::text[])) AND ($3::uuid IS NULL OR x.membership_id=$3) AND x.expires_at>clock_timestamp()
      ON CONFLICT (document_id,membership_id) DO UPDATE SET id=EXCLUDED.id,access_epoch=EXCLUDED.access_epoch,principal=EXCLUDED.principal,acl_version=EXCLUDED.acl_version,membership_version=EXCLUDED.membership_version,acl_checked_at=EXCLUDED.acl_checked_at,membership_checked_at=EXCLUDED.membership_checked_at,expires_at=EXCLUDED.expires_at`,
      [sourceId, nativeIds, membershipId ?? null],
    );
  }
  async function manage(workspaceId: string, userId: string, sourceId: string, value: unknown) {
    denyMcpEgress();
    sourceId = uuidSchema.parse(sourceId);
    const input = atlassianKnowledgeManageSchema.parse(value);
    const fingerprint = digest(JSON.stringify({ sourceId, ...input }));
    const replayed = async (tx: Tx, s: Source) => {
      const replay = z
        .object({ fingerprint: z.string() })
        .optional()
        .parse(
          (
            await tx.client.query(`SELECT fingerprint FROM ${table(tx, 'atlassian_commands')} WHERE command_id=$1`, [
              input.commandId,
            ])
          ).rows[0],
        );
      if (!replay) return null;
      if (replay.fingerprint !== fingerprint) throw new KnowledgeError('conflict');
      return dto(tx, s);
    };
    const prior = await memberTransaction(workspaceId, userId, async (tx, actor) =>
      replayed(tx, await manager(tx, actor, sourceId)),
    );
    if (prior) return prior;
    const inspected =
      input.action === 'retry'
        ? await memberTransaction(workspaceId, userId, async (tx, actor) => manager(tx, actor, sourceId)).then(s =>
            provider.inspectSelection(workspaceId, userId, s.selection, { skipUnavailable: true }),
          )
        : null;
    return memberTransaction(workspaceId, userId, async (tx, actor) => {
      const s = await manager(tx, actor, sourceId);
      const again = await replayed(tx, s);
      if (again) return again;
      if (s.state === 'removed') throw new KnowledgeError('conflict');
      if (
        inspected &&
        (inspected.binding.cloudId !== s.binding.cloudId ||
          inspected.binding.atlassianAccountId !== s.binding.atlassianAccountId)
      )
        throw new AccessDenied();
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
      await invalidate(tx, sourceId, {});
      await tx.client.query(
        `UPDATE ${table(tx, 'atlassian_sources')} SET generation=generation+1,lease_token=NULL,lease_until=NULL,next_attempt_at=clock_timestamp(),sync_state='queued',failure=NULL WHERE source_id=$1`,
        [sourceId],
      );
      if (inspected) {
        await tx.client.query(`UPDATE ${table(tx, 'atlassian_sources')} SET binding=$2 WHERE source_id=$1`, [
          sourceId,
          inspected.binding,
        ]);
        for (const t of inspected.targets)
          await tx.client.query(
            `UPDATE ${table(tx, 'atlassian_targets')} SET state='active',failure=NULL,key=$3,title=$4 WHERE source_id=$1 AND target_id=$2`,
            [
              sourceId,
              atlassianTargetKey(t),
              t.key?.slice(0, 255) ?? null,
              t.title.slice(0, 512) || atlassianTargetKey(t),
            ],
          );
        await store.source(tx, actor, sourceId, true);
      }
      await tx.client.query(`INSERT INTO ${table(tx, 'atlassian_commands')} VALUES ($1,$2,$3)`, [
        input.commandId,
        sourceId,
        fingerprint,
      ]);
      return dto(tx, await source(tx, sourceId));
    });
  }
  // One authoritative batch check with the reader's own Atlassian account. Failures never renew evidence.
  async function check(workspaceId: string, actor: HumanActor, sourceId: string, nativeIds: string[]) {
    if (!nativeIds.length) return { visible: 0, denied: 0 };
    const captured = await memberTransaction(workspaceId, actor.userId, async (tx, human) => {
      if (human.membershipId !== actor.membershipId) throw new AccessDenied();
      const s = await source(tx, sourceId);
      await store.source(tx, human, sourceId);
      const reader = readerSchema
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT account_id,account_generation,atlassian_account_id FROM ${table(tx, 'atlassian_readers')} WHERE source_id=$1 AND membership_id=$2 AND user_id=$3 ORDER BY account_id LIMIT 1`,
              [sourceId, human.membershipId, human.userId],
            )
          ).rows[0],
        );
      if (!reader) throw new AccessDenied();
      await tx.client.query(
        `INSERT INTO ${table(tx, 'atlassian_access')} (source_id,native_id,membership_id) SELECT $1,i.native_id,$2 FROM ${table(tx, 'atlassian_items')} i WHERE i.source_id=$1 AND i.native_id=ANY($3::text[]) ON CONFLICT DO NOTHING`,
        [sourceId, human.membershipId, nativeIds],
      );
      const fences = z
        .array(z.object({ native_id: z.string(), generation: z.string() }))
        .parse(
          (
            await tx.client.query(
              `SELECT native_id,generation FROM ${table(tx, 'atlassian_access')} WHERE source_id=$1 AND membership_id=$2 AND native_id=ANY($3::text[])`,
              [sourceId, human.membershipId, nativeIds],
            )
          ).rows,
        );
      const binding = atlassianCorpusBindingSchema.parse({
        accountId: reader.account_id,
        atlassianAccountId: reader.atlassian_account_id,
        cloudId: s.binding.cloudId,
      });
      return { s, binding, fences };
    });
    if (!captured.fences.length) return { visible: 0, denied: 0 };
    let observed;
    try {
      observed = await corpus.permissions(
        workspaceId,
        actor.userId,
        captured.binding,
        captured.s.product,
        captured.fences.map(f => itemOf(f.native_id)),
      );
    } catch (error) {
      if (credentialDenied(error))
        await transaction(workspaceId, async tx =>
          invalidate(tx, sourceId, {
            nativeIds: captured.fences.map(f => f.native_id),
            membershipId: actor.membershipId,
          }),
        );
      throw error;
    }
    const result = observed;
    return memberTransaction(workspaceId, actor.userId, async (tx, human) => {
      const s = await source(tx, sourceId);
      await store.source(tx, human, sourceId);
      if (s.access_epoch !== captured.s.access_epoch || s.state !== 'active') throw new KnowledgeError('superseded');
      const current = await tx.client.query(
        `SELECT 1 FROM ${table(tx, 'atlassian_readers')} WHERE source_id=$1 AND membership_id=$2 AND account_id=$3 AND account_generation=$4 AND atlassian_account_id=$5`,
        [
          sourceId,
          human.membershipId,
          captured.binding.accountId,
          result.accountGeneration,
          captured.binding.atlassianAccountId,
        ],
      );
      if (!current.rowCount) throw new AccessDenied();
      const checked = new Date(result.accessedAt);
      const now = z
        .object({ now: z.date() })
        .parse((await tx.client.query('SELECT clock_timestamp() AS now')).rows[0]).now;
      if (!Number.isFinite(checked.getTime()) || checked > now || checked.getTime() + 300000 <= now.getTime())
        throw new KnowledgeError('permission-expired');
      const visible = new Set(result.visible);
      const granted = captured.fences.filter(f => visible.has(itemOf(f.native_id)));
      const denied = captured.fences.filter(f => !visible.has(itemOf(f.native_id))).map(f => f.native_id);
      const binding = { ...captured.binding, accountGeneration: String(result.accountGeneration) };
      const advanced = granted.length
        ? (
            await tx.client.query(
              `UPDATE ${table(tx, 'atlassian_access')} a SET binding=$3,observed_at=$4,expires_at=$4::timestamptz+interval '5 minutes'
        FROM unnest($5::text[],$6::bigint[]) AS f(native_id,generation)
        WHERE a.source_id=$1 AND a.membership_id=$2 AND a.native_id=f.native_id AND a.generation=f.generation AND (a.observed_at IS NULL OR a.observed_at<=$4) RETURNING a.native_id`,
              [
                sourceId,
                human.membershipId,
                binding,
                checked,
                granted.map(f => f.native_id),
                granted.map(f => f.generation),
              ],
            )
          ).rows.map(row => z.string().parse(row.native_id))
        : [];
      if (denied.length) await invalidate(tx, sourceId, { nativeIds: denied, membershipId: human.membershipId });
      if (advanced.length) await project(tx, sourceId, advanced, human.membershipId);
      return { visible: advanced.length, denied: captured.fences.length - advanced.length };
    });
  }
  async function renew(workspaceId: string, userId: string, sourceId: string, limit: number, staleOnly: boolean) {
    const captured = await memberTransaction(workspaceId, userId, async (tx, actor) => {
      await store.source(tx, actor, sourceId);
      const rows = z.array(z.object({ native_id: z.string() })).parse(
        (
          await tx.client.query(
            `SELECT i.native_id FROM ${table(tx, 'atlassian_items')} i
        JOIN ${table(tx, 'atlassian_targets')} t ON t.source_id=i.source_id AND t.target_id=i.target_id AND t.state='active'
        LEFT JOIN ${table(tx, 'atlassian_access')} x ON x.source_id=i.source_id AND x.native_id=i.native_id AND x.membership_id=$2
        WHERE i.source_id=$1 AND i.document_id IS NOT NULL AND (NOT $4 OR x.expires_at IS NULL OR x.expires_at<clock_timestamp()+interval '2 minutes')
        ORDER BY x.expires_at NULLS FIRST,i.native_id LIMIT $3`,
            [sourceId, actor.membershipId, limit, staleOnly],
          )
        ).rows,
      );
      return { actor, ids: rows.map(row => row.native_id) };
    });
    let refreshed = 0,
      unavailableCount = 0;
    for (let start = 0; start < captured.ids.length; start += limits.accessBatch) {
      const batch = captured.ids.slice(start, start + limits.accessBatch);
      try {
        const outcome = await check(workspaceId, captured.actor, sourceId, batch);
        refreshed += outcome.visible;
        unavailableCount += outcome.denied;
      } catch (error) {
        if (
          !(error instanceof AtlassianCorpusError) &&
          !(error instanceof AccessDenied) &&
          !(error instanceof KnowledgeError)
        )
          throw error;
        unavailableCount += captured.ids.length - start;
        break;
      }
    }
    return { refreshed, unavailable: unavailableCount, bounded: true as const };
  }
  async function refresh(workspaceId: string, userId: string, sourceId: string) {
    denyMcpEgress();
    return renew(workspaceId, userId, uuidSchema.parse(sourceId), 100, false);
  }
  async function due(workspaceId: string): Promise<AtlassianKnowledgeWork[]> {
    const held = gate ? await gate(workspaceId) : [];
    return transaction(workspaceId, async tx => {
      await tx.client.query(
        `UPDATE ${table(tx, 'atlassian_sources')} SET generation=generation+1,lease_token=NULL,lease_until=NULL WHERE lease_until<=clock_timestamp()`,
      );
      const rows = z
        .array(z.object({ source_id: uuidSchema, generation: z.number() }))
        .parse(
          (
            await tx.client.query(
              `SELECT g.source_id,g.generation FROM ${table(tx, 'atlassian_sources')} g JOIN ${table(tx, 'sources')} s ON s.id=g.source_id WHERE s.state='active' AND g.lease_token IS NULL AND g.next_attempt_at<=clock_timestamp() AND NOT g.source_id=ANY($1::uuid[]) ORDER BY g.next_attempt_at,g.source_id LIMIT 20`,
              [held],
            )
          ).rows,
        );
      return rows.map(row => ({ workspaceId, sourceId: row.source_id, generation: row.generation }));
    });
  }
  async function fenced<T>(
    work: AtlassianKnowledgeWork,
    token: string,
    operation: (tx: Tx, s: Source, actor: HumanActor) => Promise<T>,
  ) {
    return transaction(work.workspaceId, async tx => {
      const s = await source(tx, work.sourceId);
      const owned = await tx.client.query(
        `SELECT 1 FROM ${table(tx, 'atlassian_sources')} WHERE source_id=$1 AND generation=$2 AND lease_token=$3 AND lease_until>clock_timestamp()`,
        [work.sourceId, work.generation, token],
      );
      if (!owned.rowCount || s.state !== 'active') throw new KnowledgeError('superseded');
      const actor: HumanActor = { kind: 'human', membershipId: s.owner_membership_id, userId: s.owner_user_id };
      await currentMember(tx, actor);
      await store.source(tx, actor, s.source_id, true);
      return operation(tx, s, actor);
    });
  }
  async function clear(tx: Tx, documentId: string, tombstone = false) {
    await tx.client.query(
      `UPDATE ${table(tx, 'documents')} SET lexical_publication_id=NULL,vector_publication_id=NULL${tombstone ? ",tombstoned_at=clock_timestamp(),retain_until=clock_timestamp()+interval '30 days'" : ''} WHERE id=$1`,
      [documentId],
    );
    await tx.client.query(`DELETE FROM ${table(tx, 'access_proofs')} WHERE document_id=$1`, [documentId]);
  }
  const documentFor = (s: Source, nativeId: string) => identity(`${s.source_id}:${s.binding.cloudId}:${nativeId}`);
  async function gone(work: AtlassianKnowledgeWork, token: string, s: Source, nativeId: string, failure: string) {
    await fenced(work, token, async tx => {
      const row = z
        .object({ document_id: uuidSchema.nullable() })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT document_id FROM ${table(tx, 'atlassian_items')} WHERE source_id=$1 AND native_id=$2`,
              [s.source_id, nativeId],
            )
          ).rows[0],
        );
      if (row?.document_id) await clear(tx, row.document_id, true);
      await invalidate(tx, s.source_id, { nativeIds: [nativeId] });
      await tx.client.query(
        `UPDATE ${table(tx, 'atlassian_items')} SET failure=$3 WHERE source_id=$1 AND native_id=$2`,
        [s.source_id, nativeId, failure],
      );
    });
  }
  // Records one observed page or issue before the owner's batch access check.
  async function record(
    work: AtlassianKnowledgeWork,
    token: string,
    s: Source,
    target: TargetRow,
    item: AtlassianItemObservation,
  ) {
    const documentId = documentFor(s, item.nativeId);
    await fenced(work, token, async tx => {
      const prior = z
        .object({ source_revision: z.string() })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT source_revision FROM ${table(tx, 'atlassian_items')} WHERE source_id=$1 AND native_id=$2`,
              [s.source_id, item.nativeId],
            )
          ).rows[0],
        );
      if (!prior) {
        const count = z
          .object({ n: z.number() })
          .parse((await tx.client.query(`SELECT count(*)::int AS n FROM ${table(tx, 'atlassian_items')}`)).rows[0]).n;
        if (count >= 20000) throw new KnowledgeError('quota');
      }
      if (prior && (prior.source_revision !== item.sourceRevision || item.coverage !== 'supported'))
        await clear(tx, documentId);
      await tx.client.query(
        `INSERT INTO ${table(tx, 'atlassian_items')} (source_id,native_id,target_id,source_revision,seen_generation,failure) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT(source_id,native_id) DO UPDATE SET target_id=EXCLUDED.target_id,source_revision=EXCLUDED.source_revision,seen_generation=EXCLUDED.seen_generation,failure=CASE WHEN ${table(tx, 'atlassian_items')}.source_revision=EXCLUDED.source_revision AND EXCLUDED.failure IS NULL THEN ${table(tx, 'atlassian_items')}.failure ELSE EXCLUDED.failure END`,
        [
          s.source_id,
          item.nativeId,
          target.target_id,
          item.sourceRevision,
          s.reconciliation,
          item.coverage === 'supported' ? null : item.coverage,
        ],
      );
    });
  }
  // Publishes the Markdown of a recorded page or issue. Item-level provider failures are recorded, not thrown.
  async function ingest(
    work: AtlassianKnowledgeWork,
    token: string,
    s: Source,
    target: TargetRow,
    item: AtlassianItemObservation,
    prefetched?: AtlassianItemRead,
  ) {
    const documentId = documentFor(s, item.nativeId);
    if (item.coverage !== 'supported') return;
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
    if (previous?.source_revision === item.sourceRevision && previous.lexical_publication_id) return;
    if (
      previous?.source_revision === item.sourceRevision &&
      (await fenced(
        work,
        token,
        async tx =>
          (
            await tx.client.query(
              `SELECT 1 FROM ${table(tx, 'work')} WHERE revision_id=$1 AND parsing='failed' AND failure<>'provider'`,
              [previous.id],
            )
          ).rowCount,
      ))
    )
      return;
    try {
      const read =
        prefetched ?? (await corpus.fetch(work.workspaceId, s.owner_user_id, s.binding, selected(target), item.itemId));
      if (read.sourceRevision !== item.sourceRevision || read.nativeId !== item.nativeId)
        throw new AtlassianCorpusError('source-changed');
      const bytes = Buffer.from(read.markdown);
      if (read.title.length > 512 || bytes.byteLength > limits.markdownBytes)
        throw new AtlassianCorpusError('item-too-large');
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
        if (
          !(
            await tx.client.query(`SELECT 1 FROM ${table(tx, 'atlassian_originals')} WHERE revision_id=$1`, [
              revisionId,
            ])
          ).rowCount
        ) {
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
              original: { kind: 'object', key: revisionId, bytes: bytes.byteLength, sha256: digest(bytes) },
              parserProfile: {
                id: `${s.product}-item-v1`,
                engine: 'provider',
                version: '1',
                normalization: 'pending',
                ocr: 'disabled',
              },
              sources: [],
            }),
          );
          await tx.client.query(`INSERT INTO ${table(tx, 'atlassian_originals')} VALUES ($1,$2)`, [
            revisionId,
            read.markdown,
          ]);
        } else
          await tx.client.query(
            `UPDATE ${table(tx, 'documents')} SET observed_revision_id=$2,lexical_publication_id=NULL,vector_publication_id=NULL WHERE id=$1`,
            [documentId, revisionId],
          );
        await tx.client.query(
          `UPDATE ${table(tx, 'atlassian_items')} SET document_id=$3 WHERE source_id=$1 AND native_id=$2`,
          [s.source_id, item.nativeId, documentId],
        );
        await project(tx, s.source_id, [item.nativeId]);
      });
      const stored = await fenced(work, token, async tx => ({
        markdown: z
          .object({ markdown: z.string() })
          .parse(
            (
              await tx.client.query(`SELECT markdown FROM ${table(tx, 'atlassian_originals')} WHERE revision_id=$1`, [
                revisionId,
              ])
            ).rows[0],
          ).markdown,
        original: store.revisionRow.parse(
          (await tx.client.query(`SELECT * FROM ${table(tx, 'revisions')} WHERE id=$1`, [revisionId])).rows[0],
        ).original,
      }));
      const content = Buffer.from(stored.markdown);
      if (content.byteLength !== stored.original.bytes || digest(content) !== stored.original.sha256)
        throw new KnowledgeError('integrity');
      const parsed = await parseKnowledgeDocument({
        bytes: content,
        filename: `${s.product}-item.md`,
        mediaType: 'text/markdown',
      });
      await fenced(work, token, async (tx, _s, human) => {
        const publicationId = identity(`atlassian-publication:${revisionId}`);
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
          { filename: `${s.product}-item.md` },
        );
        await tx.client.query(`INSERT INTO ${table(tx, 'parse_profiles')} VALUES ($1,$2) ON CONFLICT DO NOTHING`, [
          publicationId,
          parsed.profile,
        ]);
        await tx.client.query(
          `UPDATE ${table(tx, 'atlassian_items')} SET failure=NULL WHERE source_id=$1 AND native_id=$2`,
          [s.source_id, item.nativeId],
        );
      });
    } catch (error) {
      if (fatal(error)) throw error;
      if (error instanceof AtlassianCorpusError && itemGone.includes(error.code)) {
        await gone(work, token, s, item.nativeId, error.code);
        return;
      }
      await fenced(work, token, async tx => {
        const failure =
          error instanceof KnowledgeParseError
            ? error.failure
            : error instanceof KnowledgeError && error.code === 'quota'
              ? 'resource-limited'
              : error instanceof AtlassianCorpusError
                ? error.code
                : error instanceof KnowledgeError
                  ? error.code
                  : 'provider';
        await tx.client.query(
          `UPDATE ${table(tx, 'atlassian_items')} SET failure=$3 WHERE source_id=$1 AND native_id=$2`,
          [s.source_id, item.nativeId, failure],
        );
        await tx.client.query(
          `UPDATE ${table(tx, 'work')} w SET parsing='failed',failure=$2 FROM ${table(tx, 'documents')} d WHERE d.id=$1 AND w.revision_id=d.observed_revision_id AND d.lexical_publication_id IS NULL`,
          [
            documentId,
            error instanceof KnowledgeParseError
              ? error.failure
              : failure === 'resource-limited'
                ? 'resource-limited'
                : 'provider',
          ],
        );
      });
    }
  }
  async function ownerCheck(work: AtlassianKnowledgeWork, owner: HumanActor, sourceId: string, nativeIds: string[]) {
    for (let start = 0; start < nativeIds.length; start += limits.accessBatch) {
      try {
        await check(work.workspaceId, owner, sourceId, nativeIds.slice(start, start + limits.accessBatch));
      } catch (error) {
        if (
          fatal(error) ||
          !(error instanceof AtlassianCorpusError || error instanceof AccessDenied || error instanceof KnowledgeError)
        )
          throw error;
      }
    }
  }
  async function process(
    value: AtlassianKnowledgeWork,
  ): Promise<{ disposition: 'ready' | 'retry' | 'stale' | 'busy' }> {
    denyMcpEgress();
    const work = atlassianKnowledgeWorkSchema.parse(value);
    const token = randomUUID();
    if (gate && (await gate(work.workspaceId)).includes(work.sourceId)) return { disposition: 'stale' };
    const claim = await transaction(work.workspaceId, async tx => {
      const s = await source(tx, work.sourceId);
      if (s.generation !== work.generation || s.state !== 'active') return 'stale' as const;
      if (s.lease_token) return 'busy' as const;
      if (s.next_attempt_at.getTime() > clock.now()) return 'busy' as const;
      await tx.client.query(
        `UPDATE ${table(tx, 'atlassian_sources')} SET lease_token=$2,lease_until=clock_timestamp()+interval '15 minutes',sync_state='syncing' WHERE source_id=$1`,
        [s.source_id, token],
      );
      return s;
    });
    if (typeof claim === 'string') return { disposition: claim };
    try {
      await fenced(work, token, async () => undefined);
      const owner: HumanActor = { kind: 'human', membershipId: claim.owner_membership_id, userId: claim.owner_user_id };
      await renew(work.workspaceId, claim.owner_user_id, claim.source_id, limits.accessBatch, true);
      const cursor = claim.cursor;
      const all = await fenced(work, token, tx => targets(tx, claim.source_id));
      if (cursor.phase === 'listing') {
        if (cursor.pages >= 20000) throw new KnowledgeError('quota');
        cursor.pages++;
        const target = all[cursor.index];
        if (!target) {
          cursor.phase = 'sweep';
          cursor.page = null;
        } else {
          try {
            const page = await corpus.discover(
              work.workspaceId,
              claim.owner_user_id,
              claim.binding,
              selected(target),
              cursor.page,
            );
            if (page.nextCursor && page.nextCursor === cursor.page) throw new AtlassianCorpusError('invalid-cursor');
            if (target.state !== 'active')
              await fenced(work, token, async tx => {
                await tx.client.query(
                  `UPDATE ${table(tx, 'atlassian_targets')} SET state='active',failure=NULL WHERE source_id=$1 AND target_id=$2`,
                  [claim.source_id, target.target_id],
                );
              });
            const active = { ...target, state: 'active' as const, failure: null };
            for (const item of page.observations) await record(work, token, claim, active, item);
            await ownerCheck(
              work,
              owner,
              claim.source_id,
              page.observations.map(item => item.nativeId),
            );
            for (const item of page.observations) await ingest(work, token, claim, active, item);
            cursor.page = page.nextCursor;
          } catch (error) {
            if (
              fatal(error) ||
              !(error instanceof AtlassianCorpusError || (error instanceof KnowledgeError && error.code === 'quota'))
            )
              throw error;
            await fenced(work, token, tx => unavailableTarget(tx, claim.source_id, target.target_id, error.code));
            cursor.page = null;
          }
          if (!cursor.page) {
            cursor.index++;
            if (cursor.index >= all.length) cursor.phase = 'sweep';
          }
        }
      } else {
        const rows = await fenced(work, token, async tx =>
          z.array(z.object({ native_id: z.string(), target_id: z.string() })).parse(
            (
              await tx.client.query(
                `SELECT i.native_id,i.target_id FROM ${table(tx, 'atlassian_items')} i
          JOIN ${table(tx, 'atlassian_targets')} t ON t.source_id=i.source_id AND t.target_id=i.target_id AND t.state='active'
          WHERE i.source_id=$1 AND i.seen_generation<>$2 AND ($3::text IS NULL OR i.native_id>$3) ORDER BY i.native_id LIMIT $4`,
                [claim.source_id, claim.reconciliation, cursor.after, limits.sweepBatch],
              )
            ).rows,
          ),
        );
        const confirmed: { target: TargetRow; read: AtlassianItemRead; observation: AtlassianItemObservation }[] = [];
        for (const row of rows) {
          const target = all.find(t => t.target_id === row.target_id);
          if (target)
            try {
              const read = await corpus.fetch(
                work.workspaceId,
                claim.owner_user_id,
                claim.binding,
                selected(target),
                itemOf(row.native_id),
              );
              const { markdown: _markdown, accessedAt: _at, accountGeneration: _generation, ...observation } = read;
              await record(work, token, claim, target, observation);
              confirmed.push({ target, read, observation });
            } catch (error) {
              if (fatal(error)) throw error;
              if (error instanceof AtlassianCorpusError && itemGone.includes(error.code))
                await gone(work, token, claim, row.native_id, error.code);
              else
                await fenced(work, token, async tx => {
                  await tx.client.query(
                    `UPDATE ${table(tx, 'atlassian_items')} SET failure=$3 WHERE source_id=$1 AND native_id=$2`,
                    [claim.source_id, row.native_id, error instanceof AtlassianCorpusError ? error.code : 'provider'],
                  );
                });
            }
          cursor.after = row.native_id;
        }
        await ownerCheck(
          work,
          owner,
          claim.source_id,
          confirmed.map(item => item.observation.nativeId),
        );
        for (const item of confirmed) await ingest(work, token, claim, item.target, item.observation, item.read);
        if (rows.length < limits.sweepBatch) {
          await fenced(work, token, async tx => {
            await tx.client.query(
              `UPDATE ${table(tx, 'atlassian_sources')} SET cursor=$2,reconciliation=reconciliation+1,generation=generation+1,lease_token=NULL,lease_until=NULL,sync_state='ready',failure=NULL,next_attempt_at=clock_timestamp()+interval '1 minute' WHERE source_id=$1`,
              [claim.source_id, initialCursor()],
            );
          });
          return { disposition: 'ready' };
        }
      }
      cursorSchema.parse(cursor);
      await fenced(work, token, async tx => {
        await tx.client.query(
          `UPDATE ${table(tx, 'atlassian_sources')} SET cursor=$2,generation=generation+1,lease_token=NULL,lease_until=NULL,next_attempt_at=clock_timestamp(),failure=NULL WHERE source_id=$1`,
          [claim.source_id, cursor],
        );
      });
      return { disposition: 'retry' };
    } catch (error) {
      return transaction(work.workspaceId, async tx => {
        const current = await source(tx, work.sourceId);
        if (current.generation !== work.generation || current.lease_token !== token)
          return { disposition: 'stale' as const };
        const failure =
          error instanceof AtlassianCorpusError
            ? error.code
            : error instanceof KnowledgeError
              ? error.code
              : error instanceof AccessDenied
                ? 'not-linked'
                : 'provider';
        if (credentialDenied(error) || error instanceof AccessDenied)
          await tx.client.query(`UPDATE ${table(tx, 'sources')} SET access_epoch=access_epoch+1 WHERE id=$1`, [
            work.sourceId,
          ]);
        const invalidCursor = failure === 'invalid-cursor';
        await tx.client.query(
          `UPDATE ${table(tx, 'atlassian_sources')} SET generation=generation+1,lease_token=NULL,lease_until=NULL,sync_state='failed',failure=$2,next_attempt_at=clock_timestamp()+$3::double precision*interval '1 millisecond',cursor=CASE WHEN $4 THEN $5::jsonb ELSE cursor END,reconciliation=reconciliation+CASE WHEN $4 THEN 1 ELSE 0 END WHERE source_id=$1`,
          [
            work.sourceId,
            failure,
            Math.max(30000, error instanceof AtlassianCorpusError ? (error.retryAfterMs ?? 0) : 0),
            invalidCursor,
            initialCursor(),
          ],
        );
        return { disposition: 'retry' as const };
      });
    }
  }
  async function evidence(workspaceId: string, userId: string, value: unknown) {
    const citation = citationSchema.parse(value);
    return memberTransaction(workspaceId, userId, async (tx, actor) => {
      const { revision, origin } = await store.eligible(tx, actor, citation);
      const row = z
        .object({ passage: z.string(), heading: z.string(), expires_at: z.date() })
        .parse(
          (
            await tx.client.query(
              `SELECT k.passage,k.heading,e.expires_at FROM ${table(tx, 'chunks')} k JOIN ${table(tx, 'atlassian_eligible')} e ON e.document_id=$1 AND e.membership_id=$2 AND e.user_id=$5 WHERE k.publication_id=$3 AND k.ordinal=$4`,
              [citation.documentId, actor.membershipId, citation.publicationId, citation.ordinal, actor.userId],
            )
          ).rows[0],
        );
      await requireExternalProof(tx, actor, citation.documentId);
      return {
        title: revision.title,
        text: row.passage,
        heading: row.heading,
        citation,
        original: { kind: atlassianProductSchema.parse(origin.provider) },
        validUntil: row.expires_at.toISOString(),
      };
    });
  }
  async function original(workspaceId: string, userId: string, documentId: string, revisionId: string) {
    documentId = uuidSchema.parse(documentId);
    revisionId = uuidSchema.parse(revisionId);
    return memberTransaction(workspaceId, userId, async (tx, actor) => {
      const doc = await store.document(tx, documentId);
      const origin = await store.source(tx, actor, doc.source_id);
      await requireExternalProof(tx, actor, doc.id);
      if (doc.observed_revision_id !== revisionId) throw new KnowledgeError('superseded');
      const revision = store.revisionRow.parse(
        (await tx.client.query(`SELECT * FROM ${table(tx, 'revisions')} WHERE id=$1`, [revisionId])).rows[0],
      );
      await store.dependencies(tx, actor, revision);
      const row = z
        .object({ markdown: z.string() })
        .parse(
          (
            await tx.client.query(`SELECT markdown FROM ${table(tx, 'atlassian_originals')} WHERE revision_id=$1`, [
              revisionId,
            ])
          ).rows[0],
        );
      const bytes = Buffer.from(row.markdown);
      if (bytes.byteLength !== revision.original.bytes || digest(bytes) !== revision.original.sha256)
        throw new KnowledgeError('integrity');
      await requireExternalProof(tx, actor, doc.id);
      return { bytes, filename: `${origin.provider}-item.md`, mediaType: 'text/markdown' };
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
      const work = await importStatus(tx, 'atlassian_items', doc, revision.id);
      await requireExternalProof(tx, actor, doc.id);
      return atlassianKnowledgeStatusSchema.parse({
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
        JOIN ${table(tx, 'atlassian_eligible')} e ON e.document_id=d.id AND e.membership_id=$2 AND e.user_id=$3
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
        const work = await importStatus(tx, 'atlassian_items', doc, revision.id);
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
      return atlassianKnowledgeDocumentsSchema.parse({
        items,
        nextCursor: rows.length > 20 ? items.at(-1)?.documentId : null,
      });
    });
  }
  return {
    sites,
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
export type AtlassianKnowledge = ReturnType<typeof createAtlassianKnowledge>;
export type { AtlassianCorpusBinding, AtlassianCorpusSelection };
