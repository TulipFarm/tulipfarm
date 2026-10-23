import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  denyMcpEgress,
  lockAuthorization,
  resolveHuman,
  uuidSchema,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import type { Clock, FeatureFlags } from '@tulipfarm/memory-core/ports/runtime';
import { knowledgeFeatureFlags, systemClock } from '../host-ports.ts';
import { qualified, type createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import {
  atlassianTargetKey,
  type AtlassianDiscoverKind,
  type AtlassianSite,
  type AtlassianTarget,
} from '../atlassian-contracts.ts';
import { githubCorpusKinds, type GitHubRepository } from '../github-contracts.ts';
import { slackAccountKey, type SlackConversation } from '../slack-contracts.ts';
import { KnowledgeAccountChanged, KnowledgeError } from './contracts.ts';
import {
  defaultKnowledgeCountsSchema,
  defaultKnowledgeIntentInputSchema,
  defaultKnowledgeIntentSchema,
  defaultKnowledgeLimits,
  defaultKnowledgeManageSchema,
  defaultKnowledgeProductSchema,
  defaultKnowledgeWorkSchema,
  type DefaultKnowledgeIntent,
  type DefaultKnowledgeIntentInput,
  type DefaultKnowledgeProduct,
  type DefaultKnowledgeWork,
} from '../default-contracts.ts';

type Runtime = Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;
type Tx = AuthorizationTransaction;
const table = (tx: Tx, name: string) => qualified(tx.schema, `tf_knowledge_${name}`);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const identity = (value: string) => {
  const h = digest(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export * from '../default-contracts.ts';

/** The first common storage version that has the automatic Knowledge tables. */
export const defaultKnowledgeStorageVersion = 1;
async function installed(tx: Tx & { commonVersion?: number }) {
  if (typeof tx.commonVersion === 'number') return tx.commonVersion >= defaultKnowledgeStorageVersion;
  return z
    .object({ installed: z.boolean() })
    .parse(
      (await tx.client.query('SELECT to_regclass($1) IS NOT NULL AS installed', [table(tx, 'default_intents')]))
        .rows[0],
    ).installed;
}

/**
 * Records a durable, idempotent request in the same transaction that persists the credential. Replays and reauthorization never add a second intent.
 * Workspaces still on an older storage version record nothing, so connecting keeps working while the migration rolls out.
 */
export async function recordDefaultKnowledgeIntent(tx: Tx, value: DefaultKnowledgeIntentInput) {
  const input = defaultKnowledgeIntentInputSchema.parse(value);
  if (!(await installed(tx))) return { intentId: '', created: false };
  const id = identity(`default-intent:${input.product}:${input.membershipId}:${input.accountKey}`);
  const inserted = await tx.client.query(
    `INSERT INTO ${table(tx, 'default_intents')} (id,product,membership_id,account_key,account_label) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [id, input.product, input.membershipId, input.accountKey, input.accountLabel],
  );
  return { intentId: id, created: inserted.rowCount === 1 };
}

export const defaultKnowledgeFlagEnabled = (workspaceId: string, userId: string) =>
  knowledgeFeatureFlags.enabled('default-connection-knowledge', userId, workspaceId);

async function disabledOwners(
  tx: Tx,
  workspaceId: string,
  enabled: (workspaceId: string, userId: string) => Promise<boolean>,
) {
  if (!(await installed(tx))) return [];
  const owners = z
    .array(z.object({ user_id: z.string() }))
    .parse(
      (
        await tx.client.query(
          `SELECT DISTINCT m.user_id FROM ${table(tx, 'default_intents')} i JOIN ${qualified(tx.schema, 'tf_memberships')} m ON m.id=i.membership_id`,
        )
      ).rows,
    );
  const disabled: string[] = [];
  for (const owner of owners) if (!(await enabled(workspaceId, owner.user_id))) disabled.push(owner.user_id);
  return disabled;
}

/** GitHub Knowledge is on for everyone: its automatic sources and intents are never held by the feature flag. */
export const ungatedDefaultKnowledgeProducts: readonly DefaultKnowledgeProduct[] = ['github'];

/**
 * Lists automatic sources whose owner cannot use the feature now. Engines exclude them before their dispatch limit and recheck at claim time.
 * Manual sources and ungated products are never held, and older storage versions have no automatic sources.
 */
export function createDefaultKnowledgeGate({
  runtime,
  featureFlags = knowledgeFeatureFlags,
  enabled = (workspaceId, userId) => featureFlags.enabled('default-connection-knowledge', userId, workspaceId),
}: {
  runtime: Runtime;
  featureFlags?: FeatureFlags<'default-connection-knowledge'>;
  enabled?: (workspaceId: string, userId: string) => Promise<boolean>;
}) {
  return (workspaceId: string) =>
    runtime.transaction(uuidSchema.parse(workspaceId), commonCompatibility, async tx => {
      const disabled = await disabledOwners(tx, workspaceId, enabled);
      if (!disabled.length) return [];
      return z
        .array(z.object({ source_id: uuidSchema }))
        .parse(
          (
            await tx.client.query(
              `SELECT d.source_id FROM ${table(tx, 'default_sources')} d JOIN ${table(tx, 'default_intents')} i ON i.id=d.intent_id
      JOIN ${qualified(tx.schema, 'tf_memberships')} m ON m.id=i.membership_id WHERE m.user_id=ANY($1::text[]) AND NOT i.product=ANY($2::text[])`,
              [disabled, ungatedDefaultKnowledgeProducts],
            )
          ).rows,
        )
        .map(row => row.source_id);
    });
}

export type DefaultScope = { key: string; group: string; title: string };
type Intent = z.infer<typeof intentSchema>;
/** A provider's own source command; automatic Retry runs its `retry`, which also rebinds the source to the account's current authorization. */
type SourceManager = {
  manage?(workspaceId: string, userId: string, sourceId: string, value: unknown): Promise<unknown>;
};
type Engines = {
  google?: SourceManager & { configure(workspaceId: string, userId: string, value: unknown): Promise<unknown> };
  slack?: SourceManager & {
    discover(
      workspaceId: string,
      userId: string,
      kind: 'channels',
      cursor?: string,
    ): Promise<{
      binding: { teamId: string; slackUserId: string };
      items: SlackConversation[];
      nextCursor: string | null;
    }>;
    configure(workspaceId: string, userId: string, value: unknown): Promise<unknown>;
  };
  github?: SourceManager & {
    discover(
      workspaceId: string,
      userId: string,
      accountId: string,
      cursor?: string,
    ): Promise<{ items: GitHubRepository[]; nextCursor: string | null }>;
    configure(workspaceId: string, userId: string, value: unknown): Promise<unknown>;
  };
  atlassian?: SourceManager & {
    sites(workspaceId: string, userId: string, scope?: { account?: string }): Promise<{ items: AtlassianSite[] }>;
    discover(
      workspaceId: string,
      userId: string,
      cloudId: string,
      kind: AtlassianDiscoverKind,
      within?: string,
      cursor?: string,
      scope?: { account?: string },
    ): Promise<{ items: AtlassianTarget[]; nextCursor: string | null }>;
    configure(workspaceId: string, userId: string, value: unknown): Promise<unknown>;
  };
};
const intentSchema = z.object({
  id: uuidSchema,
  product: defaultKnowledgeProductSchema,
  membership_id: uuidSchema,
  account_key: z.string(),
  account_label: z.string(),
  state: z.enum(['active', 'opted-out']),
  sync_state: z.enum(['queued', 'discovering', 'ready', 'failed']),
  failure: z.string().nullable(),
  cursor: z.object({ page: z.string().nullable(), pages: z.number().int() }).nullable(),
  pass: z.coerce.number().int(),
  generation: z.coerce.number().int(),
  lease_token: uuidSchema.nullable(),
  next_attempt_at: z.date(),
  discovered_at: z.date().nullable(),
  attempts: z.number().int(),
  user_id: uuidSchema,
  group_failures: z.array(z.object({ title: z.string(), failure: z.string() })),
});
const atlassianCursorSchema = z.strictObject({ site: z.number().int().min(0), page: z.string().nullable() });
// A site that refuses access is skipped for this pass; the account's other sites still sync.
const groupFailures = ['forbidden', 'not-found', 'insufficient-scope', 'invalid-selection'];
const skippedFailures = ['too-large', 'unsupported', 'thread-too-large', 'item-too-large', 'excluded'];
const quotaFailures = ['resource-limited', 'quota'];
const failureCode = (error: unknown) => {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : error instanceof AccessDenied
        ? 'not-linked'
        : 'provider';
  return /^[a-z][a-z-]{0,63}$/.test(code) ? code : 'provider';
};
const retryAfter = (error: unknown) =>
  error && typeof error === 'object' && 'retryAfterMs' in error && typeof error.retryAfterMs === 'number'
    ? error.retryAfterMs
    : 0;

function isoDay(at: Date, offsetDays = 0) {
  return new Date(at.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

export function createDefaultKnowledge({
  runtime,
  engines,
  featureFlags = knowledgeFeatureFlags,
  enabled = (workspaceId, userId) => featureFlags.enabled('default-connection-knowledge', userId, workspaceId),
  clock = systemClock,
  now = () => new Date(clock.now()),
}: {
  runtime: Runtime;
  engines: Engines;
  featureFlags?: FeatureFlags<'default-connection-knowledge'>;
  clock?: Clock;
  enabled?: (workspaceId: string, userId: string) => Promise<boolean>;
  now?: () => Date;
}) {
  async function transaction<T>(workspaceId: string, operation: (tx: Tx) => Promise<T>) {
    return runtime.transaction(uuidSchema.parse(workspaceId), commonCompatibility, async tx => {
      await lockAuthorization(tx, 'write');
      return operation(tx);
    });
  }
  async function intent(tx: Tx, intentId: string) {
    const row = intentSchema
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT i.*,m.user_id FROM ${table(tx, 'default_intents')} i JOIN ${qualified(tx.schema, 'tf_memberships')} m ON m.id=i.membership_id WHERE i.id=$1`,
            [intentId],
          )
        ).rows[0],
      );
    if (!row) throw new AccessDenied();
    return row;
  }

  type Adapter = {
    discover(
      workspaceId: string,
      i: Intent,
      page: string | null,
    ): Promise<{
      scopes: DefaultScope[];
      nextCursor: string | null;
      groupFailure?: { title: string; failure: string };
    }>;
    covered(tx: Tx, i: Intent, scopes: DefaultScope[]): Promise<Set<string>>;
    groupSize: number;
    /** Scopes belong to one account (a mailbox, a Drive), so another account's assignment never covers them. */
    perAccount?: true;
    /** Present when one group (an Atlassian site) can refuse access independently; the refusal is shown and the other groups still configure. */
    groupTitle?(workspaceId: string, i: Intent, scopes: DefaultScope[]): Promise<string>;
    selection(i: Intent, scopes: DefaultScope[], at: Date): unknown;
    configure(workspaceId: string, i: Intent, commandId: string, selection: unknown): Promise<unknown>;
  };
  const owned = (tx: Tx, sql: string, params: unknown[]) =>
    tx.client.query(sql, params).then(
      r =>
        new Set(
          z
            .array(z.object({ key: z.string() }))
            .parse(r.rows)
            .map(row => row.key),
        ),
    );
  const required = <T>(engine: T | undefined) => {
    if (!engine) throw new KnowledgeError('adapter-required');
    return engine;
  };
  const adapters: Record<DefaultKnowledgeProduct, Adapter> = {
    // One source per account follows every repository it can read; the source's own passes add new repositories.
    github: {
      groupSize: 1,
      perAccount: true,
      async discover(ws, i) {
        await required(engines.github).discover(ws, i.user_id, i.account_key);
        return { scopes: [{ key: 'all-repositories', group: '', title: 'All repositories' }], nextCursor: null };
      },
      // Any all-repositories source of this account, in any state, is the member's own choice; it is never recreated.
      covered: (tx, i) =>
        owned(
          tx,
          `SELECT 'all-repositories' AS key FROM ${table(tx, 'github_sources')} g JOIN ${table(tx, 'sources')} s ON s.id=g.source_id
        WHERE s.owner_membership_id=$1 AND g.binding->>'accountId'=$2 AND g.selection->>'scope'='all' LIMIT 1`,
          [i.membership_id, i.account_key],
        ),
      selection: () => ({ scope: 'all', repositories: [], kinds: [...githubCorpusKinds].sort() }),
      configure: (ws, i, commandId, selection) =>
        required(engines.github).configure(ws, i.user_id, {
          commandId,
          accountId: i.account_key,
          selection,
          memberIds: [],
        }),
    },
    slack: {
      // The intent belongs to one Slack account; a replacement identity never inherits its policy, so its channels are never listed or covered here.
      groupSize: defaultKnowledgeLimits.groups.slack,
      perAccount: true,
      async discover(ws, i, page) {
        const result = await required(engines.slack).discover(ws, i.user_id, 'channels', page ?? undefined);
        if (slackAccountKey(result.binding) !== i.account_key) throw new KnowledgeAccountChanged();
        return {
          scopes: result.items
            .filter(c => c.kind === 'public' || c.kind === 'private')
            .map(c => ({ key: c.conversationId, group: '', title: c.title })),
          nextCursor: result.nextCursor,
        };
      },
      covered: (tx, i, scopes) =>
        owned(
          tx,
          `SELECT DISTINCT c.conversation_id AS key FROM ${table(tx, 'slack_conversations')} c JOIN ${table(tx, 'slack_sources')} g ON g.source_id=c.source_id JOIN ${table(tx, 'sources')} s ON s.id=c.source_id
        WHERE s.owner_membership_id=$1 AND (g.binding->>'teamId')||':'||(g.binding->>'slackUserId')=$3 AND c.conversation_id=ANY($2::text[])`,
          [i.membership_id, scopes.map(s => s.key), i.account_key],
        ),
      selection: (_i, scopes, at) => ({
        kind: 'channels',
        conversationIds: scopes.map(s => s.key).sort((a, b) => (a < b ? -1 : 1)),
        after: isoDay(at, -defaultKnowledgeLimits.windowDays),
        window: 'rolling-90d',
      }),
      configure: (ws, i, commandId, selection) =>
        required(engines.slack).configure(ws, i.user_id, {
          commandId,
          selection,
          memberIds: [],
          accountId: i.account_key,
        }),
    },
    jira: atlassian('jira', 'projects'),
    confluence: atlassian('confluence', 'spaces'),
    'google-drive': {
      groupSize: 1,
      perAccount: true,
      discover: async () => ({
        scopes: [{ key: 'drive-all', group: '', title: 'All accessible Drive files' }],
        nextCursor: null,
      }),
      // Any Drive source of this account, in any state, is the member's own choice; the default never widens or recreates it.
      covered: (tx, i) =>
        owned(
          tx,
          `SELECT 'drive-all' AS key FROM ${table(tx, 'google_sources')} g JOIN ${table(tx, 'sources')} s ON s.id=g.source_id WHERE s.owner_membership_id=$1 AND s.account_namespace=$2 AND g.selection->>'kind'<>'gmail' LIMIT 1`,
          [i.membership_id, i.account_key],
        ),
      selection: () => ({ kind: 'drive-all' }),
      configure: (ws, i, commandId, selection) =>
        required(engines.google).configure(ws, i.user_id, {
          commandId,
          selection,
          memberIds: [],
          accountId: i.account_key,
        }),
    },
    gmail: {
      groupSize: 1,
      perAccount: true,
      discover: async () => ({
        scopes: [{ key: 'mailbox', group: '', title: 'Mail from the last 90 days' }],
        nextCursor: null,
      }),
      covered: (tx, i) =>
        owned(
          tx,
          `SELECT 'mailbox' AS key FROM ${table(tx, 'google_sources')} g JOIN ${table(tx, 'sources')} s ON s.id=g.source_id WHERE s.owner_membership_id=$1 AND s.account_namespace=$2 AND g.selection->>'kind'='gmail' LIMIT 1`,
          [i.membership_id, i.account_key],
        ),
      selection: (_i, _s, at) => ({
        kind: 'gmail',
        labelId: null,
        after: isoDay(at, -defaultKnowledgeLimits.windowDays),
        before: isoDay(at, 1),
        window: 'rolling-90d',
        excludeSpamTrash: true,
      }),
      configure: (ws, i, commandId, selection) =>
        required(engines.google).configure(ws, i.user_id, {
          commandId,
          selection,
          memberIds: [],
          accountId: i.account_key,
        }),
    },
  };
  function atlassian(product: 'jira' | 'confluence', kind: 'projects' | 'spaces'): Adapter {
    return {
      groupSize: defaultKnowledgeLimits.groups.atlassian,
      async discover(ws, i, page) {
        const engine = required(engines.atlassian);
        const cursor = atlassianCursorSchema.parse(page ? JSON.parse(page) : { site: 0, page: null });
        const scope = { account: i.account_key };
        const sites = (await engine.sites(ws, i.user_id, scope)).items
          .slice()
          .sort((a, b) => (a.cloudId < b.cloudId ? -1 : 1));
        const site = sites[cursor.site];
        if (!site) return { scopes: [], nextCursor: null };
        const following = cursor.site + 1 < sites.length ? JSON.stringify({ site: cursor.site + 1, page: null }) : null;
        let result;
        try {
          result = await engine.discover(ws, i.user_id, site.cloudId, kind, undefined, cursor.page ?? undefined, scope);
        } catch (error) {
          const code = failureCode(error);
          if (!groupFailures.includes(code)) throw error;
          return { scopes: [], nextCursor: following, groupFailure: { title: site.name.slice(0, 256), failure: code } };
        }
        const next = result.nextCursor
          ? { site: cursor.site, page: result.nextCursor }
          : cursor.site + 1 < sites.length
            ? { site: cursor.site + 1, page: null }
            : null;
        return {
          scopes: result.items.map(t => ({
            key: `${site.cloudId}/${atlassianTargetKey(t)}`,
            group: site.cloudId,
            title: `${site.name}: ${t.title}`.slice(0, 512),
          })),
          nextCursor: next ? JSON.stringify(next) : null,
        };
      },
      covered: (tx, i, scopes) =>
        owned(
          tx,
          `SELECT DISTINCT (a.selection->>'cloudId')||'/'||t.target_id AS key FROM ${table(tx, 'atlassian_targets')} t JOIN ${table(tx, 'atlassian_sources')} a ON a.source_id=t.source_id JOIN ${table(tx, 'sources')} s ON s.id=t.source_id
        WHERE s.owner_membership_id=$1 AND a.product=$2 AND a.binding->>'accountId'=$4 AND (a.selection->>'cloudId')||'/'||t.target_id=ANY($3::text[])`,
          [i.membership_id, product, scopes.map(s => s.key), i.account_key],
        ),
      selection: (_i, scopes) => ({
        product,
        cloudId: scopes[0]?.group,
        targets: scopes
          .map(s => {
            const [k = '', id = ''] = (s.key.split('/')[1] ?? '').split(':');
            return { kind: k, id, descendants: false };
          })
          .sort((a, b) => (atlassianTargetKey(a) < atlassianTargetKey(b) ? -1 : 1)),
      }),
      configure: (ws, i, commandId, selection) =>
        required(engines.atlassian).configure(ws, i.user_id, {
          commandId,
          selection,
          memberIds: [],
          accountId: i.account_key,
        }),
      async groupTitle(ws, i, scopes) {
        const cloudId = scopes[0]?.group;
        const site = await required(engines.atlassian)
          .sites(ws, i.user_id, { account: i.account_key })
          .then(
            r => r.items.find(s => s.cloudId === cloudId),
            () => undefined,
          );
        // A site that no longer lists keeps the name its scopes were discovered under.
        return (site?.name ?? scopes[0]?.title.split(': ')[0] ?? 'Atlassian site').slice(0, 256);
      },
    };
  }

  const held = createDefaultKnowledgeGate({ runtime, enabled });

  async function due(workspaceId: string): Promise<DefaultKnowledgeWork[]> {
    // Disabled owners are filtered before the limit, so their intents never starve others.
    return transaction(workspaceId, async tx => {
      if (!(await installed(tx))) return [];
      const disabled = await disabledOwners(tx, workspaceId, enabled);
      await tx.client.query(
        `UPDATE ${table(tx, 'default_intents')} SET generation=generation+1,lease_token=NULL,lease_until=NULL WHERE lease_until<=clock_timestamp()`,
      );
      return z
        .array(z.object({ id: uuidSchema, generation: z.coerce.number().int() }))
        .parse(
          (
            await tx.client.query(
              `SELECT i.id,i.generation FROM ${table(tx, 'default_intents')} i JOIN ${qualified(tx.schema, 'tf_memberships')} m ON m.id=i.membership_id AND m.removed_at IS NULL
        WHERE i.state='active' AND i.lease_token IS NULL AND i.next_attempt_at<=$1 AND (i.product=ANY($3::text[]) OR NOT m.user_id=ANY($2::text[])) ORDER BY i.next_attempt_at,i.id LIMIT 20`,
              [now(), disabled, ungatedDefaultKnowledgeProducts],
            )
          ).rows,
        )
        .map(row => ({ workspaceId, intentId: row.id, generation: row.generation }));
    });
  }

  async function fenced<T>(work: DefaultKnowledgeWork, token: string, operation: (tx: Tx, i: Intent) => Promise<T>) {
    return transaction(work.workspaceId, async tx => {
      const i = await intent(tx, work.intentId);
      if (i.generation !== work.generation || i.lease_token !== token || i.state !== 'active')
        throw new KnowledgeError('superseded');
      await currentMember(tx, { kind: 'human', membershipId: i.membership_id, userId: i.user_id });
      return operation(tx, i);
    });
  }

  async function plan(work: DefaultKnowledgeWork, token: string, adapter: Adapter) {
    await fenced(work, token, async (tx, i) => {
      const pending = z
        .array(z.object({ scope_key: z.string(), group_key: z.string(), title: z.string() }))
        .parse(
          (
            await tx.client.query(
              `SELECT scope_key,group_key,title FROM ${table(tx, 'default_scopes')} WHERE intent_id=$1 AND disposition='pending' AND source_id IS NULL AND seen_pass=$2 ORDER BY group_key,scope_key`,
              [i.id, i.pass],
            )
          ).rows,
        )
        .map(r => ({ key: r.scope_key, group: r.group_key, title: r.title }));
      if (!pending.length) return;
      // Manual, paused or removed choices of this member keep their scopes; discovery never recreates or expands them.
      const covered = await adapter.covered(tx, i, pending);
      if (!adapter.perAccount)
        for (const key of await owned(
          tx,
          `SELECT DISTINCT s.scope_key AS key FROM ${table(tx, 'default_scopes')} s JOIN ${table(tx, 'default_intents')} o ON o.id=s.intent_id
        WHERE o.membership_id=$1 AND o.product=$2 AND o.id<>$3 AND s.disposition='assigned' AND s.scope_key=ANY($4::text[])`,
          [i.membership_id, i.product, i.id, pending.map(s => s.key)],
        ))
          covered.add(key);
      if (covered.size)
        await tx.client.query(
          `UPDATE ${table(tx, 'default_scopes')} SET disposition='existing' WHERE intent_id=$1 AND scope_key=ANY($2::text[])`,
          [i.id, [...covered]],
        );
      const groups = new Map<string, DefaultScope[]>();
      for (const scope of pending)
        if (!covered.has(scope.key)) groups.set(scope.group, [...(groups.get(scope.group) ?? []), scope]);
      let ordinal = z
        .object({ n: z.number().int() })
        .parse(
          (
            await tx.client.query(
              `SELECT COALESCE(max(ordinal),0)::int AS n FROM ${table(tx, 'default_sources')} WHERE intent_id=$1`,
              [i.id],
            )
          ).rows[0],
        ).n;
      for (const members of groups.values())
        for (let start = 0; start < members.length; start += adapter.groupSize) {
          const chunk = members.slice(start, start + adapter.groupSize);
          ordinal++;
          const sourceId = identity(`default-source:${i.id}:${ordinal}`);
          await tx.client.query(
            `INSERT INTO ${table(tx, 'default_sources')} (source_id,intent_id,ordinal,selection) VALUES ($1,$2,$3,$4)`,
            [sourceId, i.id, ordinal, JSON.stringify(adapter.selection(i, chunk, now()))],
          );
          await tx.client.query(
            `UPDATE ${table(tx, 'default_scopes')} SET disposition='assigned',source_id=$3 WHERE intent_id=$1 AND scope_key=ANY($2::text[])`,
            [i.id, chunk.map(s => s.key), sourceId],
          );
        }
    });
  }

  /** Creates planned sources with a deterministic command ID, so a crash or replay converges on one source. Returns false while more remain. */
  async function create(work: DefaultKnowledgeWork, token: string, adapter: Adapter) {
    const planned = await fenced(work, token, async (tx, i) => ({
      i,
      rows: z
        .array(z.object({ source_id: uuidSchema, selection: z.unknown() }))
        .parse(
          (
            await tx.client.query(
              `SELECT source_id,selection FROM ${table(tx, 'default_sources')} WHERE intent_id=$1 AND state='planned' ORDER BY ordinal LIMIT $2`,
              [i.id, defaultKnowledgeLimits.configuresPerStep + 1],
            )
          ).rows,
        ),
    }));
    for (const row of planned.rows.slice(0, defaultKnowledgeLimits.configuresPerStep)) {
      // A manual choice made after planning wins; its scopes move to it and the rest return to the next discovery pass.
      const check = await fenced(work, token, async (tx, i) => {
        if ((await tx.client.query(`SELECT 1 FROM ${table(tx, 'sources')} WHERE id=$1`, [row.source_id])).rowCount)
          return { yielded: false, scopes: [] };
        const scopes = z
          .array(z.object({ scope_key: z.string(), group_key: z.string(), title: z.string() }))
          .parse(
            (
              await tx.client.query(
                `SELECT scope_key,group_key,title FROM ${table(tx, 'default_scopes')} WHERE source_id=$1`,
                [row.source_id],
              )
            ).rows,
          )
          .map(r => ({ key: r.scope_key, group: r.group_key, title: r.title }));
        const covered = await adapter.covered(tx, i, scopes);
        if (!covered.size) return { yielded: false, scopes };
        await tx.client.query(
          `UPDATE ${table(tx, 'default_sources')} SET state='failed',failure='existing' WHERE source_id=$1`,
          [row.source_id],
        );
        await tx.client.query(
          `UPDATE ${table(tx, 'default_scopes')} SET disposition=CASE WHEN scope_key=ANY($2::text[]) THEN 'existing' ELSE 'pending' END,source_id=NULL WHERE source_id=$1`,
          [row.source_id, [...covered]],
        );
        return { yielded: true, scopes };
      });
      if (check.yielded) continue;
      try {
        await adapter.configure(work.workspaceId, planned.i, row.source_id, row.selection);
        await fenced(work, token, tx =>
          tx.client.query(
            `UPDATE ${table(tx, 'default_sources')} SET state='created',failure=NULL WHERE source_id=$1`,
            [row.source_id],
          ),
        );
      } catch (error) {
        const code = failureCode(error);
        const refused = adapter.groupTitle && groupFailures.includes(code) && code !== 'invalid-selection';
        if (code !== 'invalid-selection' && code !== 'conflict' && !refused) throw error;
        const groupFailure = refused
          ? { title: await adapter.groupTitle!(work.workspaceId, planned.i, check.scopes), failure: code }
          : null;
        // The selection drifted (renamed, archived or lost access). Its scopes wait for the next discovery pass, which revisits or retires them; nothing imported is removed.
        await fenced(work, token, async (tx, i) => {
          await tx.client.query(
            `UPDATE ${table(tx, 'default_sources')} SET state='failed',failure=$2 WHERE source_id=$1`,
            [row.source_id, code],
          );
          await tx.client.query(
            `UPDATE ${table(tx, 'default_scopes')} SET disposition='pending',source_id=NULL,seen_pass=$2 WHERE source_id=$1`,
            [row.source_id, i.pass - 1],
          );
          if (groupFailure)
            await tx.client.query(
              `UPDATE ${table(tx, 'default_intents')} SET group_failures=group_failures||$2::jsonb WHERE id=$1 AND jsonb_array_length(group_failures)<256`,
              [i.id, JSON.stringify([groupFailure])],
            );
        });
      }
    }
    return planned.rows.length <= defaultKnowledgeLimits.configuresPerStep;
  }

  async function process(value: DefaultKnowledgeWork): Promise<{ disposition: 'ready' | 'retry' | 'stale' | 'busy' }> {
    denyMcpEgress();
    const work = defaultKnowledgeWorkSchema.parse(value);
    const token = randomUUID();
    const claim = await transaction(work.workspaceId, async tx => {
      const i = await intent(tx, work.intentId);
      if (i.generation !== work.generation || i.state !== 'active') return 'stale' as const;
      if (i.lease_token || i.next_attempt_at.getTime() > now().getTime()) return 'busy' as const;
      return i;
    });
    if (typeof claim === 'string') return { disposition: claim };
    if (!ungatedDefaultKnowledgeProducts.includes(claim.product) && !(await enabled(work.workspaceId, claim.user_id)))
      return { disposition: 'stale' };
    const leased = await transaction(
      work.workspaceId,
      async tx =>
        (
          await tx.client.query(
            `UPDATE ${table(tx, 'default_intents')} SET lease_token=$3,lease_until=clock_timestamp()+interval '15 minutes',sync_state='discovering' WHERE id=$1 AND generation=$2 AND lease_token IS NULL`,
            [work.intentId, work.generation, token],
          )
        ).rowCount === 1,
    );
    if (!leased) return { disposition: 'busy' };
    const adapter = adapters[claim.product];
    try {
      let cursor = claim.cursor;
      let pass = claim.pass;
      if (!cursor) {
        pass++;
        cursor = { page: null, pages: 0 };
        await fenced(work, token, tx =>
          tx.client.query(
            `UPDATE ${table(tx, 'default_intents')} SET pass=$2,cursor=$3,group_failures='[]'::jsonb WHERE id=$1`,
            [work.intentId, pass, cursor],
          ),
        );
      }
      let complete = cursor.pages < 0;
      let limited = false;
      for (let step = 0; !complete && step < defaultKnowledgeLimits.pagesPerStep; step++) {
        const page = await adapter.discover(work.workspaceId, claim, cursor.page);
        if (page.nextCursor && page.nextCursor === cursor.page) throw new KnowledgeError('incomplete');
        limited = await fenced(work, token, async (tx, i) => {
          for (const scope of page.scopes)
            await tx.client.query(
              `INSERT INTO ${table(tx, 'default_scopes')} (intent_id,scope_key,group_key,title,seen_pass) VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT (intent_id,scope_key) DO UPDATE SET title=EXCLUDED.title,group_key=EXCLUDED.group_key,seen_pass=EXCLUDED.seen_pass`,
              [i.id, scope.key.slice(0, 512), scope.group.slice(0, 256), scope.title.slice(0, 512), i.pass],
            );
          if (page.groupFailure)
            await tx.client.query(
              `UPDATE ${table(tx, 'default_intents')} SET group_failures=group_failures||$2::jsonb WHERE id=$1 AND jsonb_array_length(group_failures)<256`,
              [i.id, JSON.stringify([page.groupFailure])],
            );
          return (
            z
              .object({ n: z.number().int() })
              .parse(
                (
                  await tx.client.query(
                    `SELECT count(*)::int AS n FROM ${table(tx, 'default_scopes')} WHERE intent_id=$1`,
                    [i.id],
                  )
                ).rows[0],
              ).n >= defaultKnowledgeLimits.scopes
          );
        });
        cursor = { page: page.nextCursor, pages: cursor.pages + 1 };
        // A capped pass stops early and stays visible; earlier scopes still sync.
        complete = !page.nextCursor || limited;
        if (complete) cursor = { page: null, pages: -1 };
        await fenced(work, token, tx =>
          tx.client.query(`UPDATE ${table(tx, 'default_intents')} SET cursor=$2 WHERE id=$1`, [work.intentId, cursor]),
        );
      }
      if (!complete) {
        await fenced(work, token, tx =>
          tx.client.query(
            `UPDATE ${table(tx, 'default_intents')} SET generation=generation+1,lease_token=NULL,lease_until=NULL,next_attempt_at=$2 WHERE id=$1`,
            [work.intentId, now()],
          ),
        );
        return { disposition: 'retry' };
      }
      await plan(work, token, adapter);
      const done = await create(work, token, adapter);
      limited = await fenced(
        work,
        token,
        async (tx, i) =>
          z
            .object({ n: z.number().int() })
            .parse(
              (
                await tx.client.query(
                  `SELECT count(*)::int AS n FROM ${table(tx, 'default_scopes')} WHERE intent_id=$1`,
                  [i.id],
                )
              ).rows[0],
            ).n >= defaultKnowledgeLimits.scopes,
      );
      await fenced(work, token, tx =>
        tx.client.query(
          `UPDATE ${table(tx, 'default_intents')} SET generation=generation+1,lease_token=NULL,lease_until=NULL,attempts=0,
        cursor=CASE WHEN $2 THEN NULL ELSE cursor END,sync_state=CASE WHEN $3 THEN 'failed' WHEN $2 THEN 'ready' ELSE 'discovering' END,failure=CASE WHEN $3 THEN 'scope-limit' ELSE NULL END,
        discovered_at=CASE WHEN $2 THEN $4::timestamptz ELSE discovered_at END,next_attempt_at=$4::timestamptz+CASE WHEN $2 THEN $5::double precision*interval '1 millisecond' ELSE interval '0' END WHERE id=$1`,
          [work.intentId, done, limited, now(), defaultKnowledgeLimits.rediscoverMs],
        ),
      );
      return { disposition: done ? 'ready' : 'retry' };
    } catch (error) {
      if (error instanceof KnowledgeError && error.code === 'superseded') return { disposition: 'stale' };
      const code = failureCode(error);
      // Discovery never deletes anything, so a failed page keeps every earlier scope and source.
      return transaction(work.workspaceId, async tx => {
        const current = await intent(tx, work.intentId);
        if (current.generation !== work.generation || current.lease_token !== token)
          return { disposition: 'stale' as const };
        const backoff = Math.max(
          30_000,
          retryAfter(error),
          Math.min(3_600_000, 30_000 * 2 ** Math.min(current.attempts, 7)),
        );
        await tx.client.query(
          `UPDATE ${table(tx, 'default_intents')} SET generation=generation+1,lease_token=NULL,lease_until=NULL,sync_state='failed',failure=$2,attempts=attempts+1,next_attempt_at=$3::timestamptz+$4::double precision*interval '1 millisecond' WHERE id=$1`,
          [work.intentId, code === 'quota' ? 'quota' : code, now(), backoff],
        );
        return { disposition: 'retry' as const };
      });
    }
  }

  async function memberTransaction<T>(
    workspaceId: string,
    userId: string,
    operation: (tx: Tx, actor: HumanActor) => Promise<T>,
  ) {
    return runtime.transaction(uuidSchema.parse(workspaceId), commonCompatibility, async tx => {
      await lockAuthorization(tx, 'write');
      const actor = await resolveHuman(tx, userId);
      return operation(tx, actor);
    });
  }
  async function dto(tx: Tx, i: Intent): Promise<DefaultKnowledgeIntent> {
    const scopes = z
      .object({ discovered: z.number().int(), included: z.number().int(), manual: z.number().int() })
      .parse(
        (
          await tx.client.query(
            `SELECT count(*)::int AS discovered,count(*) FILTER (WHERE disposition='assigned')::int AS included,count(*) FILTER (WHERE disposition='existing')::int AS manual FROM ${table(tx, 'default_scopes')} WHERE intent_id=$1`,
            [i.id],
          )
        ).rows[0],
      );
    const providers = ['google', 'slack', 'github', 'atlassian']
      .map(p => `SELECT source_id,sync_state,failure,reconciliation FROM ${table(tx, `${p}_sources`)}`)
      .join(' UNION ALL ');
    const sources = z
      .array(
        z.object({
          source_id: uuidSchema,
          state: z.enum(['planned', 'created', 'failed']),
          failure: z.string().nullable(),
          source_state: z.enum(['active', 'paused', 'disconnected', 'removed']).nullable(),
          sync_state: z.enum(['queued', 'syncing', 'ready', 'failed']).nullable(),
          sync_failure: z.string().nullable(),
          reconciliation: z.number().int().nullable(),
        }),
      )
      .parse(
        (
          await tx.client.query(
            `SELECT d.source_id,d.state,d.failure,s.state AS source_state,p.sync_state,p.failure AS sync_failure,p.reconciliation FROM ${table(tx, 'default_sources')} d LEFT JOIN ${table(tx, 'sources')} s ON s.id=d.source_id
        LEFT JOIN (${providers}) p ON p.source_id=d.source_id WHERE d.intent_id=$1 ORDER BY d.ordinal`,
            [i.id],
          )
        ).rows,
      );
    const items = ['google', 'slack', 'github', 'atlassian']
      .map(p => `SELECT source_id,document_id,failure FROM ${table(tx, `${p}_items`)}`)
      .join(' UNION ALL ');
    // An item whose document was retired (a rolling window aged it out, or it was removed) is no longer coverage, so it never counts as queued.
    const counts = defaultKnowledgeCountsSchema.parse(
      (
        await tx.client.query(
          `SELECT count(*)::int AS total,count(*) FILTER (WHERE d.lexical_publication_id IS NOT NULL)::int AS ready,
      count(*) FILTER (WHERE x.failure=ANY($2::text[]))::int AS skipped,count(*) FILTER (WHERE x.failure=ANY($3::text[]))::int AS "quotaLimited",
      count(*) FILTER (WHERE x.failure IS NOT NULL AND NOT x.failure=ANY($2::text[]) AND NOT x.failure=ANY($3::text[]))::int AS failed,
      count(*) FILTER (WHERE x.failure IS NULL AND d.lexical_publication_id IS NULL)::int AS queued
      FROM (${items}) x JOIN ${table(tx, 'default_sources')} ds ON ds.source_id=x.source_id LEFT JOIN ${table(tx, 'documents')} d ON d.id=x.document_id WHERE ds.intent_id=$1 AND d.tombstoned_at IS NULL`,
          [i.id, skippedFailures, quotaFailures],
        )
      ).rows[0],
    );
    const active = sources.filter(s => s.state === 'created' && s.source_state === 'active' && s.sync_state);
    const failed = active.filter(s => s.sync_state === 'failed');
    // A source is still being indexed until its provider finishes a first full pass (reconciliation starts at 1).
    const pending = active.filter(s => s.sync_state !== 'failed' && s.sync_state !== 'ready' && s.reconciliation === 1);
    const ingestion = {
      state: failed.length ? 'failed' : pending.length ? 'pending' : active.length ? 'ready' : 'idle',
      pending: pending.length,
      failed: failed.length,
      failure: failed[0]?.sync_failure ?? null,
    };
    return defaultKnowledgeIntentSchema.parse({
      intentId: i.id,
      product: i.product,
      accountKey: i.account_key,
      accountLabel: i.account_label,
      state: i.state,
      syncState: i.sync_state,
      failure: i.failure,
      discoveredAt: i.discovered_at?.toISOString() ?? null,
      nextAttemptAt: i.next_attempt_at.toISOString(),
      scopes,
      sources: sources.map(s => ({
        sourceId: s.source_id,
        state: s.state,
        failure: s.failure,
        sourceState: s.source_state,
        syncState: s.sync_state,
        syncFailure: s.sync_failure,
      })),
      counts,
      ingestion,
      groupFailures: i.group_failures,
    });
  }
  async function list(workspaceId: string, userId: string) {
    return memberTransaction(workspaceId, userId, async (tx, actor) => {
      if (!(await installed(tx))) return { items: [] as DefaultKnowledgeIntent[] };
      const ids = z
        .array(z.object({ id: uuidSchema }))
        .parse(
          (
            await tx.client.query(
              `SELECT id FROM ${table(tx, 'default_intents')} WHERE membership_id=$1 ORDER BY product,created_at,id LIMIT 100`,
              [actor.membershipId],
            )
          ).rows,
        );
      const items: DefaultKnowledgeIntent[] = [];
      for (const row of ids) items.push(await dto(tx, await intent(tx, row.id)));
      return { items };
    });
  }
  // Each product's source engine and the binding field that names the account a source was created with.
  const recovery: Record<
    DefaultKnowledgeProduct,
    { kind: 'google' | 'slack' | 'github' | 'atlassian'; account: string }
  > = {
    'google-drive': { kind: 'google', account: `g.binding->>'accountId'` },
    gmail: { kind: 'google', account: `g.binding->>'accountId'` },
    slack: { kind: 'slack', account: `(g.binding->>'teamId')||':'||(g.binding->>'slackUserId')` },
    github: { kind: 'github', account: `g.binding->>'accountId'` },
    jira: { kind: 'atlassian', account: `g.binding->>'accountId'` },
    confluence: { kind: 'atlassian', account: `g.binding->>'accountId'` },
  };
  /** Failed, active sources this intent created with its own account. Paused, removed and other accounts' sources are never retried here. */
  async function recoverable(tx: Tx, i: Intent) {
    const { kind, account } = recovery[i.product];
    // GitHub Retry may rebind to another account row of the same GitHub user, so it runs only while the intent's own account is usable.
    const usable =
      kind === 'github'
        ? ` AND EXISTS (SELECT 1 FROM ${qualified(tx.schema, 'tf_github_accounts')} a WHERE a.id::text=i.account_key AND a.owner_membership_id=i.membership_id
      AND a.state='active' AND (a.expires_at IS NULL OR a.expires_at>clock_timestamp()))`
        : '';
    return z
      .array(z.object({ source_id: uuidSchema }))
      .parse(
        (
          await tx.client.query(
            `SELECT d.source_id FROM ${table(tx, 'default_sources')} d JOIN ${table(tx, 'default_intents')} i ON i.id=d.intent_id
      JOIN ${table(tx, 'sources')} s ON s.id=d.source_id JOIN ${table(tx, `${kind}_sources`)} g ON g.source_id=d.source_id
      WHERE d.intent_id=$1 AND d.state='created' AND s.state='active' AND g.sync_state='failed' AND ${account}=i.account_key${usable} ORDER BY d.ordinal`,
            [i.id],
          )
        ).rows,
      )
      .map(row => row.source_id);
  }
  /** Opt-out stops future automatic discovery only. Existing sources keep their own pause/remove controls and retention. */
  async function manage(workspaceId: string, userId: string, intentId: string, value: unknown) {
    denyMcpEgress();
    const input = defaultKnowledgeManageSchema.parse(value);
    const owned = async (tx: Tx, actor: HumanActor) => {
      if (!(await installed(tx))) throw new AccessDenied();
      const i = await intent(tx, uuidSchema.parse(intentId));
      if (i.membership_id !== actor.membershipId || i.user_id !== actor.userId) throw new AccessDenied();
      return i;
    };
    const planned = await memberTransaction(workspaceId, userId, async (tx, actor) => {
      const i = await owned(tx, actor);
      if (input.action === 'opt-out') {
        await tx.client.query(
          `UPDATE ${table(tx, 'default_intents')} SET state='opted-out',generation=generation+1,lease_token=NULL,lease_until=NULL WHERE id=$1`,
          [i.id],
        );
        return null;
      }
      if (input.action !== 'resume' && i.state !== 'active') throw new KnowledgeError('conflict');
      await tx.client.query(
        `UPDATE ${table(tx, 'default_intents')} SET state='active',generation=generation+1,lease_token=NULL,lease_until=NULL,next_attempt_at=$2,attempts=0,sync_state=CASE WHEN sync_state='failed' THEN 'queued' ELSE sync_state END WHERE id=$1`,
        [i.id, now()],
      );
      return { kind: recovery[i.product].kind, generation: i.generation + 1, sources: await recoverable(tx, i) };
    });
    // Each source then runs its provider's own Retry, which rebinds it to the account's current authorization and restores its scopes.
    // These run after the intent's authorization lock is released, one source at a time, so one refused source never blocks the others.
    // Command IDs are stable for this Retry, so a replayed source command is not applied twice.
    if (planned)
      for (const sourceId of planned.sources) {
        try {
          const engine = required(engines[planned.kind]);
          if (!engine.manage) throw new KnowledgeError('adapter-required');
          await engine.manage(workspaceId, userId, sourceId, {
            commandId: identity(`default-retry:${intentId}:${planned.generation}:${sourceId}`),
            action: 'retry',
          });
        } catch {
          /* The source keeps its failure, which its row shows with its own Retry. */
        }
      }
    return memberTransaction(workspaceId, userId, async (tx, actor) => dto(tx, await owned(tx, actor)));
  }
  return { due, process, held, list, manage, record: recordDefaultKnowledgeIntent };
}
export type DefaultKnowledge = ReturnType<typeof createDefaultKnowledge>;
