import { createHash } from 'node:crypto';
import { z } from 'zod';
import { commonCompatibility } from '@tulipfarm/workspaces/storage';
import type { SeedContext } from './context.ts';
import { recordEntity } from './manifest.ts';
import type { Target } from './options.ts';
import { stableId } from './random.ts';
import { workspaceUrl } from './workspace.ts';

type Client = { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }> };
type Kind = 'google' | 'github' | 'atlassian';
type Item = { title: string; text: string; ready: boolean; failure?: string };
type Plan = {
  product: 'google-drive' | 'gmail' | 'slack' | 'github' | 'jira' | 'confluence';
  label: string;
  state: 'active' | 'opted-out';
  discovery: 'queued' | 'ready';
  source?: {
    kind: Kind;
    title: string;
    syncState: 'syncing' | 'ready' | 'failed';
    failure?: string;
    items: Item[];
  };
};

const doc = (title: string, text: string, ready = true): Item => ({ title, text, ready });

// One plan per automatic-Knowledge state the Knowledge page shows. Confluence stays unconnected.
const plans: Plan[] = [
  {
    product: 'google-drive',
    label: 'dev@tulipfarm.test',
    state: 'active',
    discovery: 'ready',
    source: {
      kind: 'google',
      title: 'My Drive',
      syncState: 'ready',
      items: [
        doc('Q3 planning', '# Q3 planning\n\nGrow repeat orders by 15% and open the Rotterdam warehouse.'),
        doc('Pricing sheet 2026', '# Pricing\n\nWholesale tulips: $0.42 per stem. Minimum order 500 stems.'),
        doc('Supplier contract — Evergreen Farms', '# Evergreen Farms\n\nWeekly delivery, 14-day payment terms.'),
        doc('Holiday rota', '# Holiday rota\n\nWarehouse cover from 20 December to 3 January.'),
        doc('Brand guidelines', '# Brand\n\nUse the tulip mark on every outbound order slip.'),
        doc('Customer FAQ', '# FAQ\n\nOrders ship within two working days.'),
        doc('Board update — August', '# August update\n\nRevenue up 8% month on month.'),
        doc('Hiring plan', '# Hiring\n\nTwo warehouse leads and one account manager.'),
        { title: 'Warehouse CCTV export.mov', text: 'video', ready: false, failure: 'too-large' },
      ],
    },
  },
  {
    product: 'gmail',
    label: 'dev@tulipfarm.test',
    state: 'opted-out',
    discovery: 'ready',
    source: {
      kind: 'google',
      title: 'Mailbox, last 90 days',
      syncState: 'ready',
      items: [
        doc('Re: delivery window', 'Thursday morning works for the Rotterdam drop.'),
        doc('Invoice 2041', 'Invoice 2041 for 3,000 stems is attached.'),
        doc('Re: holiday orders', 'Please confirm the 18 December cut-off.'),
        doc('Welcome aboard', 'Your account manager is Mia.'),
      ],
    },
  },
  { product: 'slack', label: 'TulipFarm · Dev User', state: 'active', discovery: 'queued' },
  {
    product: 'github',
    label: 'tulipfarm-dev',
    state: 'active',
    discovery: 'ready',
    source: {
      kind: 'github',
      title: 'tulipfarm/demo-shop',
      syncState: 'syncing',
      items: [
        doc('README.md', '# Demo shop\n\nA sample storefront.'),
        doc('docs/deploy.md', '# Deploy\n\nRun `pnpm build` and push to main.'),
        doc('Issue #12: checkout fails on Safari', 'The pay button does nothing on Safari 17.'),
        doc('PR #31: add order export', 'Adds CSV export to the orders page.'),
        doc('docs/architecture.md', '# Architecture\n\nNext.js front end, Postgres back end.'),
        ...['Issue #14: slow search', 'PR #33: bump deps', 'Issue #15: VAT rounding', 'PR #35: dark mode'].map(
          title => ({ title, text: title, ready: false }),
        ),
        ...['docs/api.md', 'CHANGELOG.md', 'Issue #16: refund emails'].map(title => ({
          title,
          text: title,
          ready: false,
        })),
      ],
    },
  },
  {
    product: 'jira',
    label: 'tulipfarm.atlassian.net',
    state: 'active',
    discovery: 'ready',
    source: {
      kind: 'atlassian',
      title: 'OPS project',
      syncState: 'failed',
      failure: 'provider',
      items: [
        doc('OPS-101 Reorder packaging', 'Order 2,000 flat-pack boxes before November.'),
        doc('OPS-102 Fix cold-room sensor', 'Sensor 3 reads 2°C high.'),
        doc('OPS-103 Onboard Harbor Coffee', 'Set up supplier record and payment terms.'),
      ],
    },
  },
];

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
// Keeps the worker from picking seeded work up, since local development has no real provider credentials.
const parked = `clock_timestamp() + interval '100 years'`;

/** Seeds automatic Knowledge for the workspace owner: intents, their sources and indexed documents, without provider calls. */
export async function ensureDefaultKnowledge(context: SeedContext, target: Target) {
  const { workspace, owner } = target;
  await context.runtime.transaction(workspace.id, commonCompatibility, async ({ client, schema }) => {
    const db = client as unknown as Client;
    const t = (name: string) => `"${schema}".tf_knowledge_${name}`;
    const membership = z
      .object({ id: z.uuid() })
      .parse(
        (
          await db.query(`SELECT id FROM "${schema}".tf_memberships WHERE user_id=$1 AND removed_at IS NULL`, [
            owner.id,
          ])
        ).rows[0],
      ).id;
    for (const plan of plans) {
      const intentId = stableId(workspace.id, 'default-knowledge', plan.product);
      const inserted = await db.query(
        `INSERT INTO ${t('default_intents')} (id,product,membership_id,account_key,account_label,state,sync_state,discovered_at,next_attempt_at,pass)
        VALUES ($1,$2,$3,$4,$5,$6,$7,CASE WHEN $7='ready' THEN clock_timestamp() END,${parked},1) ON CONFLICT DO NOTHING`,
        [intentId, plan.product, membership, stableId(intentId, 'account'), plan.label, plan.state, plan.discovery],
      );
      recordEntity(workspace, 'knowledge', {
        id: intentId,
        label: `Automatic Knowledge: ${plan.product}`,
        url: workspaceUrl(workspace.slug, 'knowledge'),
      });
      if (!inserted.rowCount || !plan.source) continue;
      await seedSource(db, t, { intentId, membership, plan, source: plan.source });
    }
  });
}

async function seedSource(
  db: Client,
  t: (name: string) => string,
  input: { intentId: string; membership: string; plan: Plan; source: NonNullable<Plan['source']> },
) {
  const { intentId, membership, plan, source } = input;
  const sourceId = stableId(intentId, 'source');
  const accountId = stableId(intentId, 'account');
  const shape = sourceShape(source.kind, plan.product, accountId);
  await db.query(
    `INSERT INTO ${t('sources')} (id,provider,account_namespace,selection,owner_membership_id) VALUES ($1,$2,$3,$4,$5)`,
    [sourceId, shape.provider, accountId, JSON.stringify(shape.selection), membership],
  );
  const extra = source.kind === 'atlassian' ? ',product' : '';
  await db.query(
    `INSERT INTO ${t(`${source.kind}_sources`)} (source_id,binding,selection,title,fingerprint,cursor,sync_state,failure,reconciliation,next_attempt_at${extra})
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,${parked}${source.kind === 'atlassian' ? ',$10' : ''})`,
    [
      sourceId,
      shape.binding,
      shape.selection,
      source.title,
      sha(sourceId),
      shape.cursor,
      source.syncState,
      source.failure ?? null,
      // A provider source counts as still indexing until its first full pass finishes.
      source.syncState === 'syncing' ? 1 : 2,
      ...(source.kind === 'atlassian' ? [plan.product] : []),
    ],
  );
  await db.query(`INSERT INTO ${t(`${source.kind}_members`)} (source_id,membership_id) VALUES ($1,$2)`, [
    sourceId,
    membership,
  ]);
  if (source.kind === 'github')
    await db.query(
      `INSERT INTO ${t('github_repositories')} (source_id,repository_id,full_name,visibility,title) VALUES ($1,'4242',$2,'private',$2)`,
      [sourceId, source.title],
    );
  if (source.kind === 'atlassian')
    await db.query(
      `INSERT INTO ${t('atlassian_targets')} (source_id,target_id,kind,key,title) VALUES ($1,'project:10001','project','OPS',$2)`,
      [sourceId, source.title],
    );
  await db.query(
    `INSERT INTO ${t('default_sources')} (source_id,intent_id,ordinal,selection,state) VALUES ($1,$2,1,$3,'created')`,
    [sourceId, intentId, shape.selection],
  );
  await db.query(
    `INSERT INTO ${t('default_scopes')} (intent_id,scope_key,group_key,title,seen_pass,disposition,source_id) VALUES ($1,$2,'',$3,1,'assigned',$4)`,
    [intentId, `seed:${sourceId}`, source.title, sourceId],
  );
  for (const [index, item] of source.items.entries())
    await seedItem(db, t, { sourceId, kind: source.kind, index, item, title: source.title });
}

function sourceShape(kind: Kind, product: Plan['product'], accountId: string) {
  if (kind === 'google')
    return {
      provider: 'google',
      binding: { integrationId: accountId, accountId, generation: 1, requiredScopes: ['seed'] },
      selection:
        product === 'gmail'
          ? { kind: 'gmail', labelId: null, after: '2026-01-01', before: '2026-04-01', window: 'rolling-90d' }
          : { kind: 'drive-all' },
      cursor: { phase: 'listing', page: null, folders: [], visited: [], after: null, pages: 0 },
    };
  if (kind === 'github')
    return {
      provider: 'github',
      binding: { accountId, accountGeneration: 1, githubUserId: '4242', login: 'tulipfarm-dev' },
      selection: { scope: 'all', repositories: [], kinds: ['doc', 'issue', 'pull'] },
      cursor: {},
    };
  return {
    provider: 'jira',
    binding: { accountId, atlassianAccountId: 'seed-account', cloudId: accountId },
    selection: { product: 'jira', cloudId: accountId, targets: [{ kind: 'project', id: '10001', descendants: false }] },
    cursor: {},
  };
}

async function seedItem(
  db: Client,
  t: (name: string) => string,
  input: { sourceId: string; kind: Kind; index: number; item: Item; title: string },
) {
  const { sourceId, kind, index, item } = input;
  const nativeId = kind === 'atlassian' ? `issue:${100 + index}` : `seed-${index + 1}`;
  const documentId = stableId(sourceId, 'document', index);
  await db.query(`INSERT INTO ${t('documents')} (id,source_id,native_id) VALUES ($1,$2,$3)`, [
    documentId,
    sourceId,
    nativeId,
  ]);
  if (item.ready) {
    const revisionId = stableId(documentId, 'revision');
    const publicationId = stableId(documentId, 'publication');
    const tokens = Math.max(1, Math.ceil(item.text.length / 4));
    await db.query(
      `INSERT INTO ${t('revisions')} (id,document_id,source_revision,title,original,original_bytes,parser_profile,sources,fingerprint)
      VALUES ($1,$2,'1',$3,$4,$5,$6,'[]',$7)`,
      [
        revisionId,
        documentId,
        item.title,
        { kind: 'text', text: item.text },
        Buffer.byteLength(item.text),
        { name: 'seed' },
        sha(item.text),
      ],
    );
    await db.query(
      `INSERT INTO ${t('publications')} (id,document_id,revision_id,markdown,pages,tokens,chunk_count,fingerprint) VALUES ($1,$2,$3,$4,0,$5,1,$6)`,
      [publicationId, documentId, revisionId, item.text, tokens, sha(item.text)],
    );
    await db.query(
      `INSERT INTO ${t('chunks')} (publication_id,ordinal,heading,passage,tokens,source_offset,input_hash) VALUES ($1,0,$2,$3,$4,'{}',$5)`,
      [publicationId, item.title, item.text, tokens, sha(item.text)],
    );
    await db.query(`UPDATE ${t('documents')} SET observed_revision_id=$2,lexical_publication_id=$3 WHERE id=$1`, [
      documentId,
      revisionId,
      publicationId,
    ]);
  }
  const values = [sourceId, nativeId, documentId, item.failure ?? null];
  if (kind === 'google')
    await db.query(
      `INSERT INTO ${t('google_items')} (source_id,native_id,document_id,source_revision,seen_generation,failure) VALUES ($1,$2,$3,'1',1,$4)`,
      values,
    );
  else if (kind === 'github')
    await db.query(
      `INSERT INTO ${t('github_items')} (source_id,native_id,repository_id,kind,document_id,source_revision,seen_generation,failure) VALUES ($1,$2,'4242','doc',$3,'1',1,$4)`,
      values,
    );
  else
    await db.query(
      `INSERT INTO ${t('atlassian_items')} (source_id,native_id,target_id,document_id,source_revision,seen_generation,failure) VALUES ($1,$2,'project:10001',$3,'1',1,$4)`,
      values,
    );
}
