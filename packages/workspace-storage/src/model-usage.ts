import { z } from 'zod';
import { qualified } from './names.ts';
import type { SqlClient } from './transactions.ts';
import {
  usageFilterDimensions,
  type UsageDimension,
  type UsageFilterDimension,
  type UsageMeasures,
  type UsagePaidBy,
  type UsageQuery,
} from './model-usage-contracts.ts';

type Transaction = { client: SqlClient; schema: string; commonVersion?: number };

/** The common migration that adds tf_model_usage. Workspaces not yet migrated record nothing and report credits only. */
export const modelUsageVersion = 87;
const subscriptionConnectionsVersion = 64;
const usageLimitVersion = 85;
const hasModelUsage = (tx: Transaction) => (tx.commonVersion ?? 0) >= modelUsageVersion;
const table = (tx: Transaction, name: string) => qualified(tx.schema, name);

/** One settled model call, as the Usage page reads it. Credits charged stay in tf_credit_usage under the same id. */
export type ModelUsageRecord = {
  id: string;
  activity: string;
  flowId: string | null;
  membershipId: string | null;
  agentId: string | null;
  modelId: string;
  modelProvider: string;
  paidBy: UsagePaidBy;
  connectionId: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** The call at the model's list price, in picodollars; null when the catalog has none. */
  listPicoUsd: string | null;
  pricingRevision: string | null;
  fallback: { reason: string | null; fromModel: string | null; fromConnection: string | null } | null;
};

/** Records settled calls in the caller's transaction. A repeated id is ignored, so a retried settlement writes once. */
export async function recordModelUsage(tx: Transaction, records: readonly ModelUsageRecord[]) {
  if (!records.length || !hasModelUsage(tx)) return;
  const columns = [
    'id',
    'activity',
    'flow_id',
    'membership_id',
    'agent_id',
    'model_id',
    'model_provider',
    'paid_by',
    'connection_id',
    'input_tokens',
    'output_tokens',
    'cached_tokens',
    'list_pico_usd',
    'pricing_revision',
    'fallback',
    'fallback_reason',
    'fallback_from_model',
    'fallback_from_connection',
  ];
  const values: unknown[] = [];
  const tuples = records.map(record => {
    const row = [
      record.id,
      record.activity,
      record.flowId,
      record.membershipId,
      record.agentId,
      record.modelId,
      record.modelProvider,
      record.paidBy,
      record.connectionId,
      Math.max(0, Math.round(record.inputTokens)),
      Math.max(0, Math.round(record.outputTokens)),
      Math.max(0, Math.round(record.cachedTokens)),
      record.listPicoUsd,
      record.pricingRevision,
      record.fallback !== null,
      record.fallback?.reason ?? null,
      record.fallback?.fromModel ?? null,
      record.fallback?.fromConnection ?? null,
    ];
    const start = values.length;
    values.push(...row);
    return `(${row.map((_, index) => `$${start + index + 1}`).join(',')})`;
  });
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_model_usage')} (${columns.join(',')}) VALUES ${tuples.join(',')} ON CONFLICT (id) DO NOTHING`,
    values,
  );
}

const uuidPattern = `'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'`;
const uuidOf = (text: string) => `(CASE WHEN ${text} ~ ${uuidPattern} THEN (${text})::uuid END)`;

// A provider failure reason as the chat's fallback reasons name it; mirrors modelFallbackReason in @tulipfarm/config.
const fallbackReasonSql = (reason: string) => `CASE
  WHEN ${reason} IS NULL THEN NULL
  WHEN ${reason} = 'quota' OR ${reason} LIKE '%-usage-limit' THEN 'quota'
  WHEN ${reason} = 'rate-limit' THEN 'rate-limit'
  WHEN ${reason} = 'timeout' THEN 'timeout'
  WHEN ${reason} IN ('unavailable','overload','transport') THEN 'outage'
  WHEN ${reason} = 'authentication' OR ${reason} LIKE '%-reconnect' THEN 'sign-in'
  WHEN ${reason} IN ('configuration','permission') OR ${reason} LIKE '%-not-eligible' OR ${reason} LIKE '%-member-required' THEN 'model-unavailable'
END`;

/**
 * Every metered call in the range, one row each: chat calls with their recorded detail, agent runs and tasks with the
 * tokens of their model attempt, and other credit spend (Knowledge, table search, app builds) with what the ledger
 * knows. The member a call ran for comes from its flow when the call did not record one.
 */
function factsSql(tx: Transaction) {
  const flow = uuidOf('u.flow_id');
  const owner = `COALESCE(
      (SELECT c.owner_membership_id FROM ${table(tx, 'tf_conversations')} c WHERE c.id=${flow}),
      (SELECT r.membership_id FROM ${table(tx, 'tf_agent_runs')} r WHERE r.id=${flow} AND r.kind='delegated'),
      (SELECT t.owner_membership_id FROM ${table(tx, 'tf_agent_tasks')} t WHERE t.flow_id=${flow}),
      (SELECT r.sponsor_membership_id FROM ${table(tx, 'tf_agent_runs')} r WHERE r.id=${flow} AND r.kind='scheduled'),
      (SELECT h.membership_id FROM ${table(tx, 'tf_google_heartbeat_items')} h WHERE h.id=${flow}),
      (SELECT q.membership_id FROM ${table(tx, 'tf_table_query_translations')} q WHERE q.billing_flow_id=u.flow_id LIMIT 1))`;
  const activity = `CASE WHEN u.activity <> 'agent' THEN u.activity
      WHEN EXISTS (SELECT 1 FROM ${table(tx, 'tf_agent_tasks')} t WHERE t.flow_id=${flow}) THEN 'task'
      WHEN EXISTS (SELECT 1 FROM ${table(tx, 'tf_agent_runs')} r WHERE r.id=${flow} AND r.kind='scheduled') THEN 'scheduled'
      ELSE 'agent' END`;
  const tokens = (key: string) => `COALESCE((a.usage #>> '{tokens,${key}}')::bigint,0)`;
  const attemptInput = `(${['input', 'cacheRead', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h'].map(tokens).join('+')})`;
  const primaryReason = `(SELECT p.outcome->>'reason' FROM ${table(tx, 'tf_model_attempts')} p WHERE p.run_id=a.run_id AND p.generation=a.generation AND p.role='primary' ORDER BY p.ordinal DESC LIMIT 1)`;
  const recorded = hasModelUsage(tx)
    ? table(tx, 'tf_model_usage')
    : `(SELECT NULL::text AS id,NULL::timestamptz AS occurred_at,NULL::text AS activity,NULL::uuid AS membership_id,NULL::uuid AS agent_id,NULL::text AS model_id,NULL::text AS model_provider,NULL::text AS paid_by,NULL::uuid AS connection_id,NULL::bigint AS input_tokens,NULL::bigint AS output_tokens,NULL::bigint AS list_pico_usd,NULL::boolean AS fallback,NULL::text AS fallback_reason,NULL::uuid AS fallback_from_connection WHERE false)`;
  const ledger = `
    SELECT COALESCE(m.occurred_at,u.created_at) AS at,
      COALESCE(m.activity,${activity}) AS activity,
      COALESCE(m.membership_id,${owner}) AS member_id,
      COALESCE(m.agent_id,u.agent_id) AS agent_id,
      COALESCE(m.model_id,u.model_id) AS model_id,
      COALESCE(m.model_provider,a.resolution #>> '{route,provider}') AS provider,
      COALESCE(m.paid_by,'credits') AS paid_by,
      m.connection_id,
      COALESCE(m.input_tokens,${attemptInput}) AS input_tokens,
      COALESCE(m.output_tokens,${tokens('output')}) AS output_tokens,
      u.charged::numeric AS charged,
      COALESCE(m.list_pico_usd::numeric,u.provider_pico_usd::numeric,0) AS list_pico_usd,
      COALESCE(m.fallback,a.role='fallback',false) AS fallback,
      COALESCE(m.fallback_reason,CASE WHEN a.role='fallback' THEN ${fallbackReasonSql(primaryReason)} END) AS fallback_reason,
      m.fallback_from_connection AS fallback_from
    FROM ${table(tx, 'tf_credit_usage')} u
    LEFT JOIN ${recorded} m ON m.id=u.id
    LEFT JOIN ${table(tx, 'tf_model_attempts')} a ON a.id=${uuidOf('u.id')}
    WHERE u.created_at >= $1 AND u.created_at < $2 AND u.charged IS NOT NULL
      -- A chat hold that funded no call settles at zero and is not a call.
      AND NOT (m.id IS NULL AND a.id IS NULL AND u.activity='chat' AND u.charged=0 AND COALESCE(u.provider_pico_usd,0)=0)`;
  const knowledge = `
    SELECT o.observed_at AS at,'knowledge-' || k.purpose AS activity,
      CASE WHEN k.attribution_kind='member' THEN ${uuidOf('k.attribution_id')} END AS member_id,
      NULL::uuid AS agent_id,k.model_id,NULL::text AS provider,'credits' AS paid_by,NULL::uuid AS connection_id,
      o.input_tokens::bigint AS input_tokens,0::bigint AS output_tokens,o.charged::numeric AS charged,
      o.provider_pico_usd::numeric AS list_pico_usd,false AS fallback,NULL::text AS fallback_reason,NULL::uuid AS fallback_from
    FROM ${table(tx, 'tf_knowledge_credit_observations')} o JOIN ${table(tx, 'tf_knowledge_credit_attempts')} k ON k.id=o.attempt_id
    WHERE o.observed_at >= $1 AND o.observed_at < $2`;
  // Calls recorded without a ledger row, such as calls on an API key the workspace does not meter in credits.
  const unmetered = hasModelUsage(tx)
    ? `
    SELECT m.occurred_at,m.activity,m.membership_id,m.agent_id,m.model_id,m.model_provider,m.paid_by,m.connection_id,
      m.input_tokens,m.output_tokens,0::numeric,COALESCE(m.list_pico_usd,0)::numeric,m.fallback,m.fallback_reason,m.fallback_from_connection
    FROM ${table(tx, 'tf_model_usage')} m
    WHERE m.occurred_at >= $1 AND m.occurred_at < $2
      AND NOT EXISTS (SELECT 1 FROM ${table(tx, 'tf_credit_usage')} u WHERE u.id=m.id)`
    : '';
  return [ledger, knowledge, unmetered].filter(Boolean).join('\n UNION ALL \n');
}

/**
 * What the viewer may see. Admins see every call. A member sees their own calls in full; other members' calls paid by
 * credits or an API key count toward the workspace as "others", without agent, plan or fallback detail; other members'
 * plan calls are left out.
 */
function visibleSql(tx: Transaction) {
  return `
  facts AS (${factsSql(tx)}),
  scoped AS (
    SELECT f.*, COALESCE($3::boolean OR f.member_id=$4::uuid,false) AS own FROM facts f
    WHERE $3::boolean OR f.member_id=$4::uuid OR f.paid_by <> 'plan'
  ),
  v AS (
    SELECT at AT TIME ZONE $5::text AS local_at,activity,COALESCE($6::jsonb ->> model_id,model_id) AS model_id,provider,paid_by,input_tokens,output_tokens,charged,list_pico_usd,
      CASE WHEN own THEN member_id::text WHEN member_id IS NULL THEN NULL ELSE 'others' END AS member,
      CASE WHEN own THEN agent_id::text END AS agent,
      CASE WHEN own THEN connection_id::text END AS connection_id,
      own AND fallback AS fallback,
      CASE WHEN own THEN fallback_reason END AS fallback_reason,
      CASE WHEN own THEN fallback_from::text END AS fallback_from
    FROM scoped
  )`;
}

const dimensionSql: Record<UsageDimension, string> = {
  model: 'model_id',
  provider: `COALESCE(provider,'unknown')`,
  paidBy: 'paid_by',
  connection: `CASE WHEN paid_by='credits' THEN 'credits' ELSE COALESCE(connection_id,paid_by) END`,
  usedBy: `CASE WHEN agent IS NOT NULL THEN 'agent:' || agent ELSE 'member:' || COALESCE(member,'workspace') END`,
  member: `COALESCE(member,'workspace')`,
  agent: `COALESCE(agent,'none')`,
  activity: 'activity',
  fallback: `CASE WHEN fallback THEN COALESCE(fallback_reason,'unknown') || '|' || COALESCE(fallback_from,'') ELSE 'none' END`,
  day: `to_char(local_at::date,'YYYY-MM-DD')`,
  week: `to_char(date_trunc('week',local_at)::date,'YYYY-MM-DD')`,
};

const measuresSql = `count(*)::text AS requests,
  COALESCE(sum(input_tokens),0)::text AS input_tokens,
  COALESCE(sum(output_tokens),0)::text AS output_tokens,
  COALESCE(sum(charged),0)::text AS charged,
  COALESCE(sum(list_pico_usd) FILTER (WHERE paid_by <> 'plan'),0)::text AS billed,
  COALESCE(sum(list_pico_usd) FILTER (WHERE paid_by = 'plan'),0)::text AS plan_value,
  (count(*) FILTER (WHERE fallback))::text AS fallbacks`;

const measureRow = z.object({
  requests: z.string(),
  input_tokens: z.string(),
  output_tokens: z.string(),
  charged: z.string(),
  billed: z.string(),
  plan_value: z.string(),
  fallbacks: z.string(),
});
const pico = (value: string) => Number(value) / 1e12;
function measures(row: z.infer<typeof measureRow>): UsageMeasures {
  const inputTokens = Number(row.input_tokens);
  const outputTokens = Number(row.output_tokens);
  return {
    requests: Number(row.requests),
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    credits: pico(row.charged),
    billedUsd: pico(row.billed),
    planValueUsd: pico(row.plan_value),
    fallbacks: Number(row.fallbacks),
  };
}

const rowLimit = 2000;
const seriesLimit = 10_000;

/** The viewer's usage in the query's range, grouped and filtered as asked, with each filter's values. */
export async function modelUsageReport(
  tx: Transaction,
  query: UsageQuery,
  viewer: { membershipId: string; admin: boolean },
  canonicalModel: (id: string) => string = id => id,
) {
  // One model's calls can carry different ids, such as its plan family id and the id its metered calls bill under;
  // each groups, filters and is named under its canonical id.
  const aliases: Record<string, string> = {};
  const recordedModels = z
    .array(z.object({ model_id: z.string() }))
    .parse(
      (
        await tx.client.query(
          `WITH facts AS (${factsSql(tx)}) SELECT DISTINCT model_id FROM facts WHERE model_id IS NOT NULL`,
          [query.from, query.to],
        )
      ).rows,
    );
  for (const { model_id: id } of recordedModels) {
    const canonical = canonicalModel(id);
    if (canonical !== id) aliases[id] = canonical;
  }
  const base = [query.from, query.to, viewer.admin, viewer.membershipId, query.timeZone, JSON.stringify(aliases)];
  const params: unknown[] = [...base];
  const where: string[] = [];
  for (const dimension of usageFilterDimensions) {
    const values = query.filters[dimension];
    if (!values?.length) continue;
    params.push(values);
    where.push(`${dimensionSql[dimension]} = ANY($${params.length}::text[])`);
  }
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const keys = query.group.map(dimension => dimensionSql[dimension]);
  const rowsSql = `WITH ${visibleSql(tx)}
    SELECT ARRAY[${keys.join(',')}]::text[] AS keys, ${measuresSql} FROM v ${filter}
    GROUP BY ${keys.join(',')}
    ORDER BY count(*) DESC LIMIT ${rowLimit + 1}`;
  const rows = z
    .array(measureRow.extend({ keys: z.array(z.string().nullable()) }))
    .parse((await tx.client.query(rowsSql, params)).rows);
  const seriesSql = `WITH ${visibleSql(tx)}
    SELECT ${dimensionSql.day} AS date, ${keys[0]} AS key, ${measuresSql} FROM v ${filter}
    GROUP BY 1,2 ORDER BY 1 LIMIT ${seriesLimit}`;
  const series = z
    .array(measureRow.extend({ date: z.string(), key: z.string().nullable() }))
    .parse((await tx.client.query(seriesSql, params)).rows);
  const optionsSql = `WITH ${visibleSql(tx)}
    ${usageFilterDimensions
      .map(
        dimension =>
          `SELECT '${dimension}' AS dimension, ${dimensionSql[dimension]} AS value, ${measuresSql} FROM v GROUP BY 2`,
      )
      .join('\n UNION ALL \n')}`;
  const options = z
    .array(measureRow.extend({ dimension: z.string(), value: z.string().nullable() }))
    .parse((await tx.client.query(optionsSql, base)).rows);
  const optionsByDimension: Partial<Record<UsageFilterDimension, (UsageMeasures & { value: string })[]>> = {};
  for (const option of options) {
    const dimension = option.dimension as UsageFilterDimension;
    (optionsByDimension[dimension] ??= []).push({ value: option.value ?? '', ...measures(option) });
  }
  const detailSince = hasModelUsage(tx)
    ? z
        .object({ since: z.date().nullable() })
        .parse((await tx.client.query(`SELECT min(occurred_at) AS since FROM ${table(tx, 'tf_model_usage')}`)).rows[0])
        .since
    : null;
  return {
    rows: rows.slice(0, rowLimit).map(row => ({ keys: row.keys.map(key => key ?? ''), ...measures(row) })),
    series: series.map(row => ({ date: row.date, key: row.key ?? '', ...measures(row) })),
    options: optionsByDimension,
    detailSince: detailSince?.toISOString() ?? null,
    truncated: rows.length > rowLimit || series.length >= seriesLimit,
  };
}

const connectionRow = z.object({
  id: z.string(),
  provider: z.enum(['chatgpt', 'claude', 'copilot']),
  owner_membership_id: z.string(),
  plan: z.string().nullable(),
  state: z.string(),
  usage_limited_at: z.date().nullable(),
});

/** The plan connections `ids` name, with what replies last said about their usage limit. */
export async function usageConnections(tx: Transaction, ids: readonly string[]) {
  const wanted = ids.filter(id => /^[0-9a-f-]{36}$/i.test(id));
  if (!wanted.length || (tx.commonVersion ?? 0) < subscriptionConnectionsVersion) return [];
  const limited =
    (tx.commonVersion ?? 0) >= usageLimitVersion ? 'usage_limited_at' : 'NULL::timestamptz AS usage_limited_at';
  return z
    .array(connectionRow)
    .parse(
      (
        await tx.client.query(
          `SELECT id::text AS id,provider,owner_membership_id::text AS owner_membership_id,plan,state,${limited} FROM ${table(tx, 'tf_subscription_connections')} WHERE id = ANY($1::uuid[])`,
          [wanted],
        )
      ).rows,
    );
}
