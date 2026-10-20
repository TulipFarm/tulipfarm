import { createHash, randomUUID } from 'node:crypto';
import { effectiveSelection, type EngineClock } from './rolling.ts';
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
import { recordKnowledgeImport } from '@tulipfarm/observability';
import {
  GitHubCorpusError,
  githubCorpusBindingSchema,
  githubCorpusCursorTokenSchema,
  githubCorpusLimits,
  githubCorpusSelectionSchema,
  githubKnowledgeConfigureSchema,
  githubKnowledgeDocumentsSchema,
  githubKnowledgeManageSchema,
  githubKnowledgeSourceSchema,
  githubKnowledgeStatusSchema,
  githubKnowledgeWorkSchema,
  type GitHubCorpusBinding,
  type GitHubCorpusProvider,
  type GitHubCorpusSelection,
  type GitHubItemObservation,
  type GitHubKnowledgeWork,
  type GitHubRepositoryAccess,
} from '../github-contracts.ts';
import { KnowledgeParseError, parseKnowledgeDocument } from '../parser.ts';
import { citationSchema, knowledgeLimits, KnowledgeError, lexicalInput, revisionInput } from './contracts.ts';
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
  index: z.number().int().min(0).max(githubCorpusLimits.repositories),
  page: githubCorpusCursorTokenSchema.nullable(),
  after: z.string().max(1200).nullable(),
  pages: z.number().int().min(0).max(20000),
});
const initialCursor = () => cursorSchema.parse({ phase: 'listing', index: 0, page: null, after: null, pages: 0 });
const sourceSchema = z.object({
  source_id: uuidSchema,
  binding: githubCorpusBindingSchema,
  selection: githubCorpusSelectionSchema,
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
const repositorySchema = z.object({
  repository_id: z.string(),
  full_name: z.string(),
  visibility: z.enum(['public', 'private', 'internal']),
  title: z.string(),
  state: z.enum(['active', 'unavailable']),
  failure: z.string().nullable(),
});
const readerSchema = z.object({
  account_id: uuidSchema,
  account_generation: z.number().int(),
  github_user_id: z.string(),
  login: z.string(),
});
type Source = z.infer<typeof sourceSchema>;
type Repository = z.infer<typeof repositorySchema>;
// A repository the account cannot read. Content stays retained but hidden; other repositories keep syncing.
const repositoryDenials = ['forbidden'];
// A credential that cannot prove anything. Another linked account of the same reader may still prove access.
const credentialDenials = [
  'unauthenticated',
  'insufficient-scope',
  'not-linked',
  'stale-integration',
  'reconnect-required',
];
const denial = (error: unknown): error is GitHubCorpusError =>
  error instanceof GitHubCorpusError && [...repositoryDenials, ...credentialDenials].includes(error.code);
const skippable = [
  'too-large',
  'unsupported',
  'not-found',
  'outside-selection',
  'source-changed',
  'response-too-large',
];
const repositoryDenied = (error: unknown): error is GitHubCorpusError =>
  error instanceof GitHubCorpusError && repositoryDenials.includes(error.code);

function windowValid(after: string, now: number) {
  const start = Date.parse(after);
  return Number.isFinite(start) && start <= now && now - start <= githubCorpusLimits.windowDays * 86_400_000;
}

export function createGitHubKnowledge({
  runtime,
  provider,
  now = Date.now,
  gate,
  parseDocument = parseKnowledgeDocument,
}: {
  runtime: Runtime;
  provider: GitHubCorpusProvider;
  parseDocument?: typeof parseKnowledgeDocument;
} & EngineClock) {
  async function requireExternalSource(tx: AuthorizationTransaction, actor: HumanActor, source: ExternalSource) {
    if (source.provider !== 'github') throw new AccessDenied();
    if (
      !(
        await tx.client.query(
          `SELECT 1 FROM ${table(tx, 'github_readers')} WHERE source_id=$1 AND membership_id=$2 AND user_id=$3`,
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
          `SELECT 1 FROM ${table(tx, 'github_eligible')} WHERE document_id=$1 AND membership_id=$2 AND user_id=$3`,
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
            `SELECT g.*,s.owner_membership_id,s.state,s.access_epoch,m.user_id AS owner_user_id FROM ${table(tx, 'github_sources')} g JOIN ${table(tx, 'sources')} s ON s.id=g.source_id JOIN ${qualified(tx.schema, 'tf_memberships')} m ON m.id=s.owner_membership_id WHERE g.source_id=$1`,
            [sourceId],
          )
        ).rows[0],
      );
    if (!row) throw new AccessDenied();
    return { ...row, selection: effectiveSelection(row.selection, now()) };
  }
  async function repositories(tx: Tx, sourceId: string) {
    return z
      .array(repositorySchema)
      .parse(
        (
          await tx.client.query(
            `SELECT repository_id,full_name,visibility,title,state,failure FROM ${table(tx, 'github_repositories')} WHERE source_id=$1 ORDER BY length(repository_id),repository_id`,
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
      return githubKnowledgeSourceSchema.parse({
        sourceId: s.source_id,
        title: 'Shared GitHub source',
        selection: null,
        memberIds: [],
        counts: null,
        repositories: null,
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
            `SELECT membership_id FROM ${table(tx, 'github_members')} WHERE source_id=$1 ORDER BY membership_id`,
            [s.source_id],
          )
        ).rows,
      );
    const counts = z
      .object({ total: z.number(), ready: z.number(), failed: z.number() })
      .parse(
        (
          await tx.client.query(
            `SELECT count(*)::int AS total,count(d.lexical_publication_id)::int AS ready,count(*) FILTER (WHERE i.failure IS NOT NULL)::int AS failed FROM ${table(tx, 'github_items')} i LEFT JOIN ${table(tx, 'documents')} d ON d.id=i.document_id AND d.tombstoned_at IS NULL WHERE i.source_id=$1`,
            [s.source_id],
          )
        ).rows[0],
      );
    const selected = (await repositories(tx, s.source_id)).map(r => ({
      repositoryId: r.repository_id,
      fullName: r.full_name,
      visibility: r.visibility,
      title: r.title,
      state: r.state,
      failure: r.failure,
    }));
    return githubKnowledgeSourceSchema.parse({
      sourceId: s.source_id,
      selection: s.selection,
      memberIds: members.map(m => m.membership_id),
      title: s.title,
      canManage,
      state: s.state,
      syncState: s.sync_state,
      failure: s.failure,
      nextAttemptAt: s.next_attempt_at.toISOString(),
      repositories: selected,
      counts,
    });
  }
  async function ownAccount(tx: Tx, human: HumanActor, binding: GitHubCorpusBinding) {
    const owned = await tx.client.query(
      `SELECT 1 FROM ${qualified(tx.schema, 'tf_github_accounts')} WHERE id=$1 AND owner_membership_id=$2 AND generation=$3 AND state='active' AND identity->>'id'=$4 AND (expires_at IS NULL OR expires_at>clock_timestamp())`,
      [binding.accountId, human.membershipId, binding.accountGeneration, binding.githubUserId],
    );
    if (!owned.rowCount) throw new GitHubCorpusError('stale-integration');
  }
  async function discover(workspaceId: string, userId: string, accountId: string, cursor?: string) {
    denyMcpEgress();
    accountId = uuidSchema.parse(accountId);
    await memberTransaction(workspaceId, userId, async () => undefined);
    const result = await provider.discover(workspaceId, userId, accountId, cursor);
    await memberTransaction(workspaceId, userId, (tx, human) => ownAccount(tx, human, result.binding));
    return result;
  }
  async function configure(workspaceId: string, userId: string, value: unknown) {
    denyMcpEgress();
    const input = githubKnowledgeConfigureSchema.parse(value);
    if (!windowValid(input.selection.after, now())) throw new GitHubCorpusError('invalid-selection');
    const actor = await memberTransaction(workspaceId, userId, async (_tx, a) => a);
    const memberIds = [...new Set([...input.memberIds, actor.membershipId])].sort();
    const fingerprint = digest(JSON.stringify({ accountId: input.accountId, selection: input.selection, memberIds }));
    const replay = await memberTransaction(workspaceId, userId, async (tx, human) => {
      if (!(await tx.client.query(`SELECT 1 FROM ${table(tx, 'sources')} WHERE id=$1`, [input.commandId])).rowCount)
        return null;
      const prior = await manager(tx, human, input.commandId);
      if (prior.fingerprint !== fingerprint || prior.state === 'removed') throw new KnowledgeError('conflict');
      return dto(tx, prior);
    });
    if (replay) return replay;
    const inspected = await provider.inspectSelection(workspaceId, userId, input.accountId, input.selection);
    if (
      inspected.binding.accountId !== input.accountId ||
      inspected.repositories.length !== input.selection.repositories.length ||
      inspected.repositories.some(
        (r, i) => r.fullName.toLowerCase() !== input.selection.repositories[i]?.toLowerCase(),
      ) ||
      new Set(inspected.repositories.map(r => r.repositoryId)).size !== inspected.repositories.length
    )
      throw new GitHubCorpusError('invalid-selection');
    return memberTransaction(workspaceId, userId, async (tx, human) => {
      if (human.membershipId !== actor.membershipId) throw new AccessDenied();
      if ((await tx.client.query(`SELECT 1 FROM ${table(tx, 'sources')} WHERE id=$1`, [input.commandId])).rowCount) {
        const prior = await manager(tx, human, input.commandId);
        if (prior.fingerprint !== fingerprint || prior.state === 'removed') throw new KnowledgeError('conflict');
        return dto(tx, prior);
      }
      await ownAccount(tx, human, inspected.binding);
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
        `INSERT INTO ${table(tx, 'sources')} (id,provider,account_namespace,selection,owner_membership_id) VALUES ($1,'github',$2,$3::jsonb::text,$4) ON CONFLICT DO NOTHING`,
        [input.commandId, inspected.binding.githubUserId, JSON.stringify(input.selection), human.membershipId],
      );
      if (!inserted.rowCount) throw new KnowledgeError('conflict');
      await tx.client.query(
        `INSERT INTO ${table(tx, 'github_sources')} (source_id,binding,selection,title,fingerprint,cursor) VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          input.commandId,
          inspected.binding,
          input.selection,
          inspected.title.slice(0, 2048) || 'GitHub repositories',
          fingerprint,
          initialCursor(),
        ],
      );
      await tx.client.query(
        `INSERT INTO ${table(tx, 'github_members')} (source_id,membership_id) SELECT $1,unnest($2::uuid[])`,
        [input.commandId, memberIds],
      );
      for (const r of inspected.repositories)
        await tx.client.query(
          `INSERT INTO ${table(tx, 'github_repositories')} (source_id,repository_id,full_name,visibility,title) VALUES ($1,$2,$3,$4,$5)`,
          [input.commandId, r.repositoryId, r.fullName, r.visibility, r.title.slice(0, 512) || r.fullName],
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
              `SELECT s.id FROM ${table(tx, 'sources')} s JOIN ${table(tx, 'github_sources')} g ON g.source_id=s.id WHERE s.owner_membership_id=$1 OR (s.state<>'removed' AND EXISTS (SELECT 1 FROM ${table(tx, 'github_members')} m WHERE m.source_id=s.id AND m.membership_id=$1)) ORDER BY s.id LIMIT 100`,
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
  async function invalidate(tx: Tx, sourceId: string, repositoryId: string | null, membershipId?: string) {
    await tx.client.query(
      `INSERT INTO ${table(tx, 'github_access')} (source_id,repository_id,membership_id,generation)
      SELECT c.source_id,c.repository_id,m.membership_id,1 FROM ${table(tx, 'github_repositories')} c JOIN ${table(tx, 'github_members')} m ON m.source_id=c.source_id
      WHERE c.source_id=$1 AND ($2::text IS NULL OR c.repository_id=$2) AND ($3::uuid IS NULL OR m.membership_id=$3)
      ON CONFLICT (source_id,repository_id,membership_id) DO UPDATE SET generation=${table(tx, 'github_access')}.generation+1,binding=NULL,observed_at=NULL,expires_at=NULL`,
      [sourceId, repositoryId, membershipId ?? null],
    );
    await tx.client.query(
      `DELETE FROM ${table(tx, 'access_proofs')} p USING ${table(tx, 'github_items')} i
      WHERE i.source_id=$1 AND ($2::text IS NULL OR i.repository_id=$2) AND p.document_id=i.document_id AND ($3::uuid IS NULL OR p.membership_id=$3)`,
      [sourceId, repositoryId, membershipId ?? null],
    );
  }
  async function unavailable(tx: Tx, sourceId: string, repositoryId: string, failure: string) {
    await tx.client.query(
      `UPDATE ${table(tx, 'github_repositories')} SET state='unavailable',failure=$3 WHERE source_id=$1 AND repository_id=$2`,
      [sourceId, repositoryId, failure],
    );
    await invalidate(tx, sourceId, repositoryId);
  }
  // Copies a still-current authoritative repository check onto each current document revision. Expiry is never extended.
  async function project(tx: Tx, sourceId: string, repositoryId: string, membershipId?: string, documentId?: string) {
    await tx.client.query(
      `INSERT INTO ${table(tx, 'access_proofs')} (id,document_id,membership_id,access_epoch,principal,acl_version,membership_version,acl_checked_at,membership_checked_at,expires_at)
      SELECT gen_random_uuid(),d.id,x.membership_id,s.access_epoch,x.binding->>'githubUserId',r.source_revision,x.binding->>'accountGeneration',x.observed_at,x.observed_at,x.expires_at
      FROM ${table(tx, 'github_access')} x
      JOIN ${table(tx, 'github_repositories')} c ON c.source_id=x.source_id AND c.repository_id=x.repository_id AND c.state='active'
      JOIN ${table(tx, 'github_items')} i ON i.source_id=x.source_id AND i.repository_id=x.repository_id
      JOIN ${table(tx, 'documents')} d ON d.id=i.document_id AND d.tombstoned_at IS NULL
      JOIN ${table(tx, 'revisions')} r ON r.id=d.observed_revision_id
      JOIN ${table(tx, 'sources')} s ON s.id=x.source_id
      WHERE x.source_id=$1 AND x.repository_id=$2 AND ($3::uuid IS NULL OR x.membership_id=$3) AND ($4::uuid IS NULL OR d.id=$4) AND x.expires_at>clock_timestamp()
      ON CONFLICT (document_id,membership_id) DO UPDATE SET id=EXCLUDED.id,access_epoch=EXCLUDED.access_epoch,principal=EXCLUDED.principal,acl_version=EXCLUDED.acl_version,membership_version=EXCLUDED.membership_version,acl_checked_at=EXCLUDED.acl_checked_at,membership_checked_at=EXCLUDED.membership_checked_at,expires_at=EXCLUDED.expires_at`,
      [sourceId, repositoryId, membershipId ?? null, documentId ?? null],
    );
  }
  async function manage(workspaceId: string, userId: string, sourceId: string, value: unknown) {
    denyMcpEgress();
    sourceId = uuidSchema.parse(sourceId);
    const input = githubKnowledgeManageSchema.parse(value);
    const fingerprint = digest(JSON.stringify({ sourceId, ...input }));
    const replayed = async (tx: Tx, s: Source) => {
      const replay = z
        .object({ fingerprint: z.string() })
        .optional()
        .parse(
          (
            await tx.client.query(`SELECT fingerprint FROM ${table(tx, 'github_commands')} WHERE command_id=$1`, [
              input.commandId,
            ])
          ).rows[0],
        );
      if (!replay) return null;
      if (replay.fingerprint !== fingerprint) throw new KnowledgeError('conflict');
      return dto(tx, s);
    };
    return memberTransaction(workspaceId, userId, async (tx, actor) => {
      const s = await manager(tx, actor, sourceId);
      const again = await replayed(tx, s);
      if (again) return again;
      if (s.state === 'removed') throw new KnowledgeError('conflict');
      // Retry rebinds to the owner's current account for the same GitHub identity; the next sync re-checks every repository.
      const rebound =
        input.action === 'retry'
          ? z
              .object({ id: uuidSchema, generation: z.number().int(), login: z.string() })
              .optional()
              .parse(
                (
                  await tx.client.query(
                    `SELECT id,generation,identity->>'login' AS login FROM ${qualified(tx.schema, 'tf_github_accounts')}
        WHERE owner_membership_id=$1 AND state='active' AND identity->>'id'=$2 AND (expires_at IS NULL OR expires_at>clock_timestamp()) ORDER BY (id=$3::uuid) DESC,created_at LIMIT 1`,
                    [actor.membershipId, s.binding.githubUserId, s.binding.accountId],
                  )
                ).rows[0],
              )
          : undefined;
      if (input.action === 'retry' && !rebound) throw new GitHubCorpusError('not-linked');
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
      await invalidate(tx, sourceId, null);
      await tx.client.query(
        `UPDATE ${table(tx, 'github_sources')} SET generation=generation+1,lease_token=NULL,lease_until=NULL,next_attempt_at=clock_timestamp(),sync_state='queued',failure=NULL WHERE source_id=$1`,
        [sourceId],
      );
      if (rebound) {
        await tx.client.query(
          `UPDATE ${table(tx, 'work')} w SET parsing='queued',failure=NULL,attempts=0 FROM ${table(tx, 'documents')} d
          WHERE d.source_id=$1 AND w.revision_id=d.observed_revision_id AND w.parsing='failed' AND d.tombstoned_at IS NULL`,
          [sourceId],
        );
        await tx.client.query(
          `UPDATE ${table(tx, 'github_sources')} SET cursor=$2,reconciliation=reconciliation+1 WHERE source_id=$1`,
          [sourceId, initialCursor()],
        );
        await tx.client.query(`UPDATE ${table(tx, 'github_sources')} SET binding=$2 WHERE source_id=$1`, [
          sourceId,
          githubCorpusBindingSchema.parse({
            ...s.binding,
            accountId: rebound.id,
            accountGeneration: rebound.generation,
            login: rebound.login,
          }),
        ]);
        await tx.client.query(
          `UPDATE ${table(tx, 'github_repositories')} SET state='active',failure=NULL WHERE source_id=$1`,
          [sourceId],
        );
        await store.source(tx, actor, sourceId, true);
      }
      await tx.client.query(`INSERT INTO ${table(tx, 'github_commands')} VALUES ($1,$2,$3)`, [
        input.commandId,
        sourceId,
        fingerprint,
      ]);
      return dto(tx, await source(tx, sourceId));
    });
  }
  // One authoritative repository check with the reader's own linked GitHub accounts. Failures never renew evidence.
  async function check(workspaceId: string, actor: HumanActor, sourceId: string, repositoryId: string, owner: boolean) {
    const captured = await memberTransaction(workspaceId, actor.userId, async (tx, human) => {
      if (human.membershipId !== actor.membershipId) throw new AccessDenied();
      const s = await source(tx, sourceId);
      await store.source(tx, human, sourceId);
      if (owner && s.owner_membership_id !== human.membershipId) throw new AccessDenied();
      const r = repositorySchema
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT repository_id,full_name,visibility,title,state,failure FROM ${table(tx, 'github_repositories')} WHERE source_id=$1 AND repository_id=$2`,
              [sourceId, repositoryId],
            )
          ).rows[0],
        );
      if (!r) throw new AccessDenied();
      const readers = z.array(readerSchema).parse(
        (
          await tx.client.query(
            `SELECT account_id,account_generation,github_user_id,login FROM ${table(tx, 'github_readers')} WHERE source_id=$1 AND membership_id=$2
        ORDER BY (account_id::text=$3) DESC,created_at,account_id LIMIT 3`,
            [sourceId, human.membershipId, s.binding.accountId],
          )
        ).rows,
      );
      if (!readers.length) throw new AccessDenied();
      await tx.client.query(
        `INSERT INTO ${table(tx, 'github_access')} (source_id,repository_id,membership_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [sourceId, repositoryId, human.membershipId],
      );
      const fence = z
        .object({ generation: z.string() })
        .parse(
          (
            await tx.client.query(
              `SELECT generation FROM ${table(tx, 'github_access')} WHERE source_id=$1 AND repository_id=$2 AND membership_id=$3`,
              [sourceId, repositoryId, human.membershipId],
            )
          ).rows[0],
        ).generation;
      const bindings = readers.map(reader =>
        githubCorpusBindingSchema.parse({
          accountId: reader.account_id,
          accountGeneration: reader.account_generation,
          githubUserId: reader.github_user_id,
          login: reader.login,
        }),
      );
      return { s, r, bindings: owner ? bindings.slice(0, 1) : bindings, fence };
    });
    if (!owner && captured.r.state !== 'active') return false;
    let result: { observed: GitHubRepositoryAccess; binding: GitHubCorpusBinding } | null = null;
    let failure: GitHubCorpusError | null = null;
    for (const binding of captured.bindings) {
      try {
        const observed = await provider.access(workspaceId, actor.userId, binding, repositoryId);
        if (observed.repositoryId !== repositoryId) throw new GitHubCorpusError('invalid-response');
        if (!observed.readable) {
          failure = new GitHubCorpusError('forbidden');
          continue;
        }
        result = { observed, binding };
        break;
      } catch (error) {
        if (!(error instanceof GitHubCorpusError) || !credentialDenials.includes(error.code)) throw error;
        if (!failure) failure = error;
      }
    }
    if (!result) {
      const error = failure ?? new GitHubCorpusError('forbidden');
      await transaction(workspaceId, async tx => {
        if (owner && repositoryDenials.includes(error.code)) await unavailable(tx, sourceId, repositoryId, error.code);
        else await invalidate(tx, sourceId, repositoryId, actor.membershipId);
      });
      throw error;
    }
    const { observed, binding } = result;
    return memberTransaction(workspaceId, actor.userId, async (tx, human) => {
      const s = await source(tx, sourceId);
      await store.source(tx, human, sourceId);
      if (s.access_epoch !== captured.s.access_epoch || s.state !== 'active') throw new KnowledgeError('superseded');
      const current = await tx.client.query(
        `SELECT 1 FROM ${table(tx, 'github_readers')} WHERE source_id=$1 AND membership_id=$2 AND account_id=$3 AND account_generation=$4 AND github_user_id=$5`,
        [sourceId, human.membershipId, binding.accountId, binding.accountGeneration, binding.githubUserId],
      );
      if (!current.rowCount) throw new AccessDenied();
      const checked = new Date(observed.accessedAt);
      const now = z
        .object({ now: z.date() })
        .parse((await tx.client.query('SELECT clock_timestamp() AS now')).rows[0]).now;
      if (!Number.isFinite(checked.getTime()) || checked > now || checked.getTime() + 300000 <= now.getTime())
        throw new KnowledgeError('permission-expired');
      const advanced = await tx.client.query(
        `UPDATE ${table(tx, 'github_access')} SET binding=$5,observed_at=$4,expires_at=$4::timestamptz+interval '5 minutes' WHERE source_id=$1 AND repository_id=$2 AND membership_id=$3 AND generation=$6 AND (observed_at IS NULL OR observed_at<=$4)`,
        [sourceId, repositoryId, human.membershipId, checked, binding, captured.fence],
      );
      if (!advanced.rowCount) throw new KnowledgeError('superseded');
      if (owner)
        await tx.client.query(
          `UPDATE ${table(tx, 'github_repositories')} SET state='active',failure=NULL,full_name=$3,visibility=$4,title=$5 WHERE source_id=$1 AND repository_id=$2`,
          [
            sourceId,
            repositoryId,
            observed.fullName,
            observed.visibility,
            observed.title.slice(0, 512) || observed.fullName,
          ],
        );
      const r = repositorySchema.parse(
        (
          await tx.client.query(
            `SELECT repository_id,full_name,visibility,title,state,failure FROM ${table(tx, 'github_repositories')} WHERE source_id=$1 AND repository_id=$2`,
            [sourceId, repositoryId],
          )
        ).rows[0],
      );
      if (r.state !== 'active') return false;
      await project(tx, sourceId, repositoryId, human.membershipId);
      return true;
    });
  }
  async function renew(workspaceId: string, userId: string, sourceId: string, limit: number, staleOnly: boolean) {
    const captured = await memberTransaction(workspaceId, userId, async (tx, actor) => {
      await store.source(tx, actor, sourceId);
      const rows = z.array(z.object({ repository_id: z.string() })).parse(
        (
          await tx.client.query(
            `SELECT c.repository_id FROM ${table(tx, 'github_repositories')} c
        LEFT JOIN ${table(tx, 'github_access')} x ON x.source_id=c.source_id AND x.repository_id=c.repository_id AND x.membership_id=$2
        WHERE c.source_id=$1 AND c.state='active' AND (NOT $4 OR x.expires_at IS NULL OR x.expires_at<clock_timestamp()+interval '2 minutes')
        ORDER BY x.expires_at NULLS FIRST,c.repository_id LIMIT $3`,
            [sourceId, actor.membershipId, limit, staleOnly],
          )
        ).rows,
      );
      return { actor, rows };
    });
    let refreshed = 0,
      unavailableCount = 0;
    for (const row of captured.rows) {
      try {
        if (await check(workspaceId, captured.actor, sourceId, row.repository_id, false)) refreshed++;
        else unavailableCount++;
      } catch (error) {
        if (
          !(error instanceof GitHubCorpusError) &&
          !(error instanceof AccessDenied) &&
          !(error instanceof KnowledgeError)
        )
          throw error;
        unavailableCount++;
        if (error instanceof GitHubCorpusError && error.code === 'rate-limited') break;
      }
    }
    return { refreshed, unavailable: unavailableCount, bounded: true as const };
  }
  async function refresh(workspaceId: string, userId: string, sourceId: string) {
    denyMcpEgress();
    return renew(workspaceId, userId, uuidSchema.parse(sourceId), 20, false);
  }
  async function due(workspaceId: string): Promise<GitHubKnowledgeWork[]> {
    const held = gate ? await gate(workspaceId) : [];
    return transaction(workspaceId, async tx => {
      await tx.client.query(
        `UPDATE ${table(tx, 'github_sources')} SET generation=generation+1,lease_token=NULL,lease_until=NULL WHERE lease_until<=clock_timestamp()`,
      );
      const rows = z
        .array(z.object({ source_id: uuidSchema, generation: z.number() }))
        .parse(
          (
            await tx.client.query(
              `SELECT g.source_id,g.generation FROM ${table(tx, 'github_sources')} g JOIN ${table(tx, 'sources')} s ON s.id=g.source_id WHERE s.state='active' AND g.lease_token IS NULL AND g.next_attempt_at<=clock_timestamp() AND NOT g.source_id=ANY($1::uuid[]) ORDER BY g.next_attempt_at,g.source_id LIMIT 20`,
              [held],
            )
          ).rows,
        );
      return rows.map(row => ({ workspaceId, sourceId: row.source_id, generation: row.generation }));
    });
  }
  async function health(workspaceId: string) {
    return transaction(workspaceId, async tx =>
      z.object({ failedItems: z.number(), failedSources: z.number(), stalledSources: z.number() }).parse(
        (
          await tx.client.query(`
      SELECT (SELECT count(*)::int FROM ${table(tx, 'github_items')} i JOIN ${table(tx, 'sources')} s ON s.id=i.source_id
        WHERE s.state='active' AND i.failure IS NOT NULL) AS "failedItems",
      count(*) FILTER (WHERE g.sync_state='failed' OR EXISTS (SELECT 1 FROM ${table(tx, 'github_repositories')} r
        WHERE r.source_id=g.source_id AND r.state='unavailable'))::int AS "failedSources",
      count(*) FILTER (WHERE g.sync_state IN ('queued','syncing','ready') AND g.next_attempt_at<clock_timestamp()-interval '15 minutes')::int AS "stalledSources"
      FROM ${table(tx, 'github_sources')} g JOIN ${table(tx, 'sources')} s ON s.id=g.source_id WHERE s.state='active'`)
        ).rows[0],
      ),
    );
  }
  async function fenced<T>(
    work: GitHubKnowledgeWork,
    token: string,
    operation: (tx: Tx, s: Source, actor: HumanActor) => Promise<T>,
  ) {
    return transaction(work.workspaceId, async tx => {
      const s = await source(tx, work.sourceId);
      const owned = await tx.client.query(
        `SELECT 1 FROM ${table(tx, 'github_sources')} WHERE source_id=$1 AND generation=$2 AND lease_token=$3 AND lease_until>clock_timestamp()`,
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
      `UPDATE ${table(tx, 'documents')} SET lexical_publication_id=NULL,vector_publication_id=NULL${tombstone ? ",tombstoned_at=COALESCE(tombstoned_at,clock_timestamp()),retain_until=COALESCE(retain_until,tombstoned_at+interval '30 days',clock_timestamp()+interval '30 days')" : ''} WHERE id=$1`,
      [documentId],
    );
    await tx.client.query(`DELETE FROM ${table(tx, 'access_proofs')} WHERE document_id=$1`, [documentId]);
  }
  async function ensureOwnerProof(work: GitHubKnowledgeWork, token: string, repositoryId: string) {
    const captured = await fenced(work, token, async (tx, s, actor) => ({
      actor,
      sourceId: s.source_id,
      fresh: !!(
        await tx.client.query(
          `SELECT 1 FROM ${table(tx, 'github_access')} a JOIN ${table(tx, 'github_repositories')} r USING(source_id,repository_id)
        WHERE a.source_id=$1 AND a.repository_id=$2 AND a.membership_id=$3 AND r.state='active'
        AND a.binding IS NOT NULL AND a.expires_at>clock_timestamp()+interval '1 minute'`,
          [s.source_id, repositoryId, actor.membershipId],
        )
      ).rowCount,
    }));
    if (!captured.fresh && !(await check(work.workspaceId, captured.actor, captured.sourceId, repositoryId, true)))
      throw new GitHubCorpusError('forbidden');
  }
  async function ingest(work: GitHubKnowledgeWork, token: string, s: Source, item: GitHubItemObservation) {
    const documentId = identity(`${s.source_id}:github:${item.nativeId}`);
    await fenced(work, token, async tx => {
      const prior = z
        .object({ source_revision: z.string() })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT source_revision FROM ${table(tx, 'github_items')} WHERE source_id=$1 AND native_id=$2`,
              [s.source_id, item.nativeId],
            )
          ).rows[0],
        );
      if (!prior) {
        const count = z
          .object({ n: z.number() })
          .parse((await tx.client.query(`SELECT count(*)::int AS n FROM ${table(tx, 'github_items')}`)).rows[0]).n;
        if (count >= 20000) throw new KnowledgeError('quota');
      }
      if (prior && (prior.source_revision !== item.sourceRevision || item.coverage !== 'supported'))
        await clear(tx, documentId);
      await tx.client.query(
        `INSERT INTO ${table(tx, 'github_items')} (source_id,native_id,repository_id,kind,source_revision,seen_generation,failure) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(source_id,native_id) DO UPDATE SET source_revision=EXCLUDED.source_revision,seen_generation=EXCLUDED.seen_generation,failure=CASE WHEN ${table(tx, 'github_items')}.source_revision=EXCLUDED.source_revision AND EXCLUDED.failure IS NULL THEN ${table(tx, 'github_items')}.failure ELSE EXCLUDED.failure END`,
        [
          s.source_id,
          item.nativeId,
          item.repositoryId,
          item.kind,
          item.sourceRevision,
          s.reconciliation,
          item.coverage === 'supported' ? null : item.coverage,
        ],
      );
    });
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
              `SELECT 1 FROM ${table(tx, 'work')} WHERE revision_id=$1 AND parsing='failed' AND (failure<>'provider' OR attempts>=3)`,
              [previous.id],
            )
          ).rowCount,
      ))
    )
      return;
    try {
      await ensureOwnerProof(work, token, item.repositoryId);
      const read = await provider.read(
        work.workspaceId,
        s.owner_user_id,
        s.binding,
        item.repositoryId,
        item.nativeId,
        s.selection,
      );
      if (read.sourceRevision !== item.sourceRevision || read.nativeId !== item.nativeId)
        throw new GitHubCorpusError('source-changed');
      const bytes = Buffer.from(read.markdown);
      if (read.title.length > 512 || bytes.byteLength > githubCorpusLimits.markdownBytes)
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
        if (
          !(await tx.client.query(`SELECT 1 FROM ${table(tx, 'github_originals')} WHERE revision_id=$1`, [revisionId]))
            .rowCount
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
                id: 'github-item-v1',
                engine: 'provider',
                version: '1',
                normalization: 'pending',
                ocr: 'disabled',
              },
              sources: [],
            }),
          );
          await tx.client.query(`INSERT INTO ${table(tx, 'github_originals')} VALUES ($1,$2)`, [
            revisionId,
            read.markdown,
          ]);
        } else
          await tx.client.query(
            `UPDATE ${table(tx, 'documents')} SET observed_revision_id=$2,lexical_publication_id=NULL,vector_publication_id=NULL WHERE id=$1`,
            [documentId, revisionId],
          );
        await tx.client.query(
          `UPDATE ${table(tx, 'github_items')} SET document_id=$3 WHERE source_id=$1 AND native_id=$2`,
          [s.source_id, item.nativeId, documentId],
        );
        await tx.client.query(`UPDATE ${table(tx, 'work')} SET attempts=attempts+1 WHERE revision_id=$1`, [revisionId]);
        await project(tx, s.source_id, item.repositoryId, human.membershipId, documentId);
      });
      const stored = await fenced(work, token, async tx => ({
        markdown: z
          .object({ markdown: z.string() })
          .parse(
            (
              await tx.client.query(`SELECT markdown FROM ${table(tx, 'github_originals')} WHERE revision_id=$1`, [
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
      const parsed = await parseDocument({
        bytes: content,
        filename: 'github-document.md',
        mediaType: 'text/markdown',
      });
      await ensureOwnerProof(work, token, item.repositoryId);
      await fenced(work, token, async (tx, _s, human) => {
        const publicationId = identity(`github-publication:${revisionId}`);
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
          { filename: 'github-document.md' },
        );
        await tx.client.query(`INSERT INTO ${table(tx, 'parse_profiles')} VALUES ($1,$2) ON CONFLICT DO NOTHING`, [
          publicationId,
          parsed.profile,
        ]);
        await tx.client.query(
          `UPDATE ${table(tx, 'github_items')} SET failure=NULL WHERE source_id=$1 AND native_id=$2`,
          [s.source_id, item.nativeId],
        );
      });
      recordKnowledgeImport('item', 'ready');
    } catch (error) {
      if (error instanceof KnowledgeError && error.code === 'superseded') throw error;
      await fenced(work, token, async tx => {
        if (error instanceof GitHubCorpusError && ['not-found', 'outside-selection'].includes(error.code))
          await clear(tx, documentId, true);
        const failure =
          error instanceof KnowledgeParseError
            ? error.failure
            : error instanceof KnowledgeError && error.code === 'quota'
              ? 'resource-limited'
              : error instanceof GitHubCorpusError
                ? error.code
                : error instanceof KnowledgeError
                  ? error.code
                  : 'provider';
        await tx.client.query(
          `UPDATE ${table(tx, 'github_items')} SET failure=$3 WHERE source_id=$1 AND native_id=$2`,
          [s.source_id, item.nativeId, failure],
        );
        await tx.client.query(
          `UPDATE ${table(tx, 'work')} w SET parsing='failed',failure=$2 FROM ${table(tx, 'documents')} d WHERE d.id=$1 AND w.revision_id=d.observed_revision_id AND d.lexical_publication_id IS NULL`,
          [
            documentId,
            error instanceof KnowledgeParseError
              ? error.retryable
                ? 'provider'
                : error.failure
              : failure === 'resource-limited'
                ? 'resource-limited'
                : 'provider',
          ],
        );
      });
      recordKnowledgeImport(
        'item',
        'error',
        error instanceof KnowledgeParseError
          ? error.reason
          : error instanceof KnowledgeError || error instanceof GitHubCorpusError
            ? error.code
            : 'provider',
        error instanceof KnowledgeParseError ? error.diagnostics : undefined,
      );
      if (
        !(error instanceof KnowledgeParseError) &&
        !(error instanceof KnowledgeError && ['quota', 'permission-expired'].includes(error.code)) &&
        !(error instanceof GitHubCorpusError && skippable.includes(error.code))
      )
        throw error;
    }
  }
  async function process(value: GitHubKnowledgeWork): Promise<{ disposition: 'ready' | 'retry' | 'stale' | 'busy' }> {
    denyMcpEgress();
    const work = githubKnowledgeWorkSchema.parse(value);
    const token = randomUUID();
    if (gate && (await gate(work.workspaceId)).includes(work.sourceId)) return { disposition: 'stale' };
    const claim = await transaction(work.workspaceId, async tx => {
      const s = await source(tx, work.sourceId);
      if (s.generation !== work.generation || s.state !== 'active') return 'stale' as const;
      if (s.lease_token) return 'busy' as const;
      if (s.next_attempt_at.getTime() > Date.now()) return 'busy' as const;
      await tx.client.query(
        `UPDATE ${table(tx, 'github_sources')} SET lease_token=$2,lease_until=clock_timestamp()+interval '15 minutes',sync_state='syncing' WHERE source_id=$1`,
        [s.source_id, token],
      );
      return s;
    });
    if (typeof claim === 'string') return { disposition: claim };
    try {
      await fenced(work, token, async () => undefined);
      const owner: HumanActor = { kind: 'human', membershipId: claim.owner_membership_id, userId: claim.owner_user_id };
      await renew(work.workspaceId, claim.owner_user_id, claim.source_id, 5, true);
      const cursor = claim.cursor;
      const selected = await fenced(work, token, tx => repositories(tx, claim.source_id));
      if (cursor.phase === 'listing') {
        if (cursor.pages >= 20000) throw new KnowledgeError('quota');
        cursor.pages++;
        const repository: Repository | undefined = selected[cursor.index];
        if (!repository) {
          cursor.phase = 'sweep';
          cursor.page = null;
        } else {
          let accessible = true;
          try {
            accessible = await check(work.workspaceId, owner, claim.source_id, repository.repository_id, true);
          } catch (error) {
            if (!repositoryDenied(error)) throw error;
            accessible = false;
          }
          if (accessible) {
            try {
              const page = await provider.list(
                work.workspaceId,
                claim.owner_user_id,
                claim.binding,
                repository.repository_id,
                claim.selection,
                cursor.page,
              );
              if (page.nextCursor && page.nextCursor === cursor.page) throw new GitHubCorpusError('invalid-cursor');
              for (const item of page.observations) {
                if (item.repositoryId !== repository.repository_id) throw new GitHubCorpusError('invalid-response');
                await ingest(work, token, claim, item);
              }
              await fenced(work, token, tx => project(tx, claim.source_id, repository.repository_id));
              cursor.page = page.nextCursor;
            } catch (error) {
              if (!repositoryDenied(error)) throw error;
              await fenced(work, token, tx => unavailable(tx, claim.source_id, repository.repository_id, error.code));
              cursor.page = null;
            }
          } else cursor.page = null;
          if (!cursor.page) {
            cursor.index++;
            if (cursor.index >= selected.length) cursor.phase = 'sweep';
          }
        }
      } else {
        const rows = await fenced(work, token, async tx =>
          z
            .array(
              z.object({
                native_id: z.string(),
                repository_id: z.string(),
                kind: z.string(),
                source_revision: z.string(),
                document_id: uuidSchema.nullable(),
              }),
            )
            .parse(
              (
                await tx.client.query(
                  `SELECT i.native_id,i.repository_id,i.kind,i.source_revision,i.document_id FROM ${table(tx, 'github_items')} i
          JOIN ${table(tx, 'github_repositories')} c ON c.source_id=i.source_id AND c.repository_id=i.repository_id AND c.state='active'
          LEFT JOIN ${table(tx, 'documents')} d ON d.id=i.document_id
          WHERE i.source_id=$1 AND i.seen_generation<>$2 AND d.tombstoned_at IS NULL AND ($3::text IS NULL OR i.native_id>$3) ORDER BY i.native_id LIMIT 20`,
                  [claim.source_id, claim.reconciliation, cursor.after],
                )
              ).rows,
            ),
        );
        const verified = new Map<string, boolean>();
        const displaced = new Map<string, Set<string>>();
        for (const row of rows) {
          let accessible = verified.get(row.repository_id);
          if (accessible === undefined) {
            try {
              accessible = await check(work.workspaceId, owner, claim.source_id, row.repository_id, true);
            } catch (error) {
              if (!repositoryDenied(error)) throw error;
              accessible = false;
            }
            verified.set(row.repository_id, accessible);
          }
          if (accessible)
            try {
              if (row.kind === 'code') {
                let beyond = displaced.get(row.repository_id);
                if (!beyond) {
                  beyond = new Set(
                    await provider.displacedCode(
                      work.workspaceId,
                      claim.owner_user_id,
                      claim.binding,
                      row.repository_id,
                      claim.selection,
                      rows
                        .filter(other => other.kind === 'code' && other.repository_id === row.repository_id)
                        .map(other => other.native_id),
                    ),
                  );
                  displaced.set(row.repository_id, beyond);
                }
                // Files pushed beyond the current head's count bound get the same excluded skip as listed ones; unproven files are read as before.
                if (beyond.has(row.native_id)) {
                  await ingest(work, token, claim, {
                    nativeId: row.native_id,
                    repositoryId: row.repository_id,
                    kind: 'code',
                    title: row.native_id,
                    canonicalURL: '',
                    sourceRevision: row.source_revision,
                    accessedAt: new Date().toISOString(),
                    coverage: 'excluded',
                  });
                  await fenced(work, token, tx => project(tx, claim.source_id, row.repository_id));
                  cursor.after = row.native_id;
                  continue;
                }
              }
              const observed = await provider.read(
                work.workspaceId,
                claim.owner_user_id,
                claim.binding,
                row.repository_id,
                row.native_id,
                claim.selection,
              );
              const { markdown: _markdown, ...observation } = observed;
              await ingest(work, token, claim, observation);
              await fenced(work, token, tx => project(tx, claim.source_id, row.repository_id));
            } catch (error) {
              if (repositoryDenied(error)) {
                await fenced(work, token, tx => unavailable(tx, claim.source_id, row.repository_id, error.code));
                verified.set(row.repository_id, false);
              } else if (
                !(error instanceof GitHubCorpusError) ||
                !['not-found', 'outside-selection', 'too-large', 'unsupported'].includes(error.code)
              )
                throw error;
              else if (row.document_id && ['not-found', 'outside-selection'].includes(error.code)) {
                const documentId = row.document_id;
                await fenced(work, token, tx => clear(tx, documentId, true));
              }
            }
          cursor.after = row.native_id;
        }
        if (rows.length < 20) {
          await fenced(work, token, async tx => {
            await tx.client.query(
              `UPDATE ${table(tx, 'github_sources')} SET cursor=$2,reconciliation=reconciliation+1,generation=generation+1,lease_token=NULL,lease_until=NULL,sync_state='ready',failure=NULL,next_attempt_at=clock_timestamp()+interval '1 minute' WHERE source_id=$1`,
              [claim.source_id, initialCursor()],
            );
          });
          recordKnowledgeImport('source', 'ready');
          return { disposition: 'ready' };
        }
      }
      cursorSchema.parse(cursor);
      await fenced(work, token, async tx => {
        await tx.client.query(
          `UPDATE ${table(tx, 'github_sources')} SET cursor=$2,generation=generation+1,lease_token=NULL,lease_until=NULL,next_attempt_at=clock_timestamp(),failure=NULL WHERE source_id=$1`,
          [claim.source_id, cursor],
        );
      });
      return { disposition: 'retry' };
    } catch (error) {
      const result = await transaction(work.workspaceId, async tx => {
        const current = await source(tx, work.sourceId);
        if (current.generation !== work.generation || current.lease_token !== token)
          return { disposition: 'stale' as const };
        const failure =
          error instanceof GitHubCorpusError
            ? error.code
            : error instanceof KnowledgeError
              ? error.code
              : error instanceof AccessDenied
                ? 'not-linked'
                : 'provider';
        if (denial(error) || error instanceof AccessDenied)
          await tx.client.query(`UPDATE ${table(tx, 'sources')} SET access_epoch=access_epoch+1 WHERE id=$1`, [
            work.sourceId,
          ]);
        const invalidCursor = failure === 'invalid-cursor';
        await tx.client.query(
          `UPDATE ${table(tx, 'github_sources')} SET generation=generation+1,lease_token=NULL,lease_until=NULL,sync_state='failed',failure=$2,next_attempt_at=clock_timestamp()+$3::double precision*interval '1 millisecond',cursor=CASE WHEN $4 THEN $5::jsonb ELSE cursor END,reconciliation=reconciliation+CASE WHEN $4 THEN 1 ELSE 0 END WHERE source_id=$1`,
          [
            work.sourceId,
            failure,
            Math.max(30000, error instanceof GitHubCorpusError ? (error.retryAfterMs ?? 0) : 0),
            invalidCursor,
            initialCursor(),
          ],
        );
        return { disposition: 'retry' as const };
      });
      if (result.disposition === 'retry')
        recordKnowledgeImport(
          'source',
          'error',
          error instanceof GitHubCorpusError || error instanceof KnowledgeError
            ? error.code
            : error instanceof AccessDenied
              ? 'not-linked'
              : 'provider',
          { error },
        );
      return result;
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
              `SELECT k.passage,k.heading,e.expires_at FROM ${table(tx, 'chunks')} k JOIN ${table(tx, 'github_eligible')} e ON e.document_id=$1 AND e.membership_id=$2 WHERE k.publication_id=$3 AND k.ordinal=$4`,
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
        original: { kind: 'github' as const },
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
        .object({ markdown: z.string() })
        .parse(
          (
            await tx.client.query(`SELECT markdown FROM ${table(tx, 'github_originals')} WHERE revision_id=$1`, [
              revisionId,
            ])
          ).rows[0],
        );
      const bytes = Buffer.from(row.markdown);
      if (bytes.byteLength !== revision.original.bytes || digest(bytes) !== revision.original.sha256)
        throw new KnowledgeError('integrity');
      await requireExternalProof(tx, actor, doc.id);
      return { bytes, filename: 'github-document.md', mediaType: 'text/markdown' };
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
      const work = await importStatus(tx, 'github_items', doc, revision.id);
      await requireExternalProof(tx, actor, doc.id);
      return githubKnowledgeStatusSchema.parse({
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
        JOIN ${table(tx, 'github_eligible')} e ON e.document_id=d.id AND e.membership_id=$2 AND e.user_id=$3
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
        const work = await importStatus(tx, 'github_items', doc, revision.id);
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
      return githubKnowledgeDocumentsSchema.parse({
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
    health,
    process,
    evidence,
    original,
    refresh,
    status,
    authority,
  };
}
export type GitHubKnowledge = ReturnType<typeof createGitHubKnowledge>;
export type { GitHubCorpusBinding, GitHubCorpusSelection };
