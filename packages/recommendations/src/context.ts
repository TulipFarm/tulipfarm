import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  canAccessAsset,
  canAccessTable,
  currentMember,
  definitionGrantPredicate,
  humanTableGrantPredicate,
  lockAuthorization,
  protectedSourceClosure,
  requireMcpSource,
  requireProtectedSource,
  sourceDependenciesSchema,
  type AuthorizationTransaction,
  type HumanActor,
  type SourceDependency,
} from '@tulipfarm/access';
import { readPersonalMemory } from '@tulipfarm/conversations/personal-memory';
import { projectReaders } from '@tulipfarm/conversations/project-membership';
import { projectSourceFile, recheckProjectContext } from '@tulipfarm/conversations/projects';
import { requireReadableFile } from '@tulipfarm/files';
import { readableWorkflow } from '@tulipfarm/workflows/authorization';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { recommendationCompatibility } from '@tulipfarm/workspace-storage/recommendations';
import {
  generatedPromptsSchema,
  recommendationPolicy,
  recommendationSourceSchema,
  type Recommendation,
  type RecommendationSource,
} from './contracts.ts';
import type { RecommendationSignals } from './rules.ts';

export const recommendationContextLimits = {
  entries: 100,
  bytes: 64 * 1024,
  candidates: 12,
  excerpt: 2000,
  sources: 200,
} as const;
const providerSchema = z.enum(['google', 'github', 'slack', 'atlassian', 'mcp']);
const entrySchema = recommendationSourceSchema.extend({
  key: z.string().max(300),
  label: z.string().max(160),
  content: z.string().max(16000),
  digest: z.string().max(256),
  provider: providerSchema.optional(),
  capabilities: z.array(z.string().max(200)).max(20),
});
export type RecommendationContextEntry = z.infer<typeof entrySchema>;
export type RecommendationContext = {
  policy: typeof recommendationPolicy;
  signals: RecommendationSignals;
  entries: RecommendationContextEntry[];
};
type Transaction = AuthorizationTransaction & { workspaceId: string; commonVersion: number };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const boundedText = (text: string, limit: number) => text.slice(0, limit).replace(/[\uD800-\uDBFF]$/, '');
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => compare(a, b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
};

/** Revisions fence retained sources; their counters alone do not justify another model call. */
export function recommendationContextFingerprint(context: RecommendationContext) {
  return hash(
    canonical({
      policy: context.policy,
      signals: context.signals,
      entries: context.entries
        .map(({ revision: _revision, ...entry }) => ({
          ...entry,
          capabilities: [...new Set(entry.capabilities)].sort(compare),
        }))
        .sort((a, b) => compare(a.key, b.key)),
    }),
  );
}

export function recommendationFacts(
  context: RecommendationContext,
  item: Recommendation,
  sourceKeys?: readonly string[],
) {
  const kinds: Record<string, string[]> = {
    'personalize-bud': ['memory'],
    'connect-apps': ['integration'],
    'create-table': ['table'],
    'create-workflow': ['workflow'],
    'add-knowledge': ['knowledge', 'file'],
    'invite-teammate': ['membership'],
  };
  const picker = item.action.kind === 'open' ? item.action.sourcePicker : undefined;
  return hash(
    context.entries
      .filter(entry =>
        sourceKeys
          ? sourceKeys.includes(entry.key)
          : picker
            ? entry.kind === 'integration' && entry.provider === picker
            : kinds[item.id]?.includes(entry.kind),
      )
      .map(({ key, revision, digest }) => ({ key, revision, digest }))
      .sort((a, b) => compare(a.key, b.key)),
  );
}

const candidateSchema = z.object({
  id: z.string(),
  label: z.string(),
  revision: z.string(),
  content: z.string(),
  digest: z.string(),
});
const integrationSchema = z.object({ id: z.string(), scopes: z.array(z.string()), account_key: z.string().nullable() });
const googleScope = (name: string) => `https://www.googleapis.com/auth/${name}`;
function googleCapabilities(scopes: string[]) {
  const has = (...names: string[]) => names.some(name => scopes.includes(googleScope(name)));
  return [
    ...(has('gmail.modify', 'gmail.readonly') || scopes.includes('https://mail.google.com/') ? ['gmail.read'] : []),
    ...(has('calendar', 'calendar.readonly', 'calendar.events', 'calendar.events.readonly') ? ['calendar.read'] : []),
    ...(has('drive') ? ['drive.read'] : []),
    ...(has('documents', 'documents.readonly') ? ['documents.read'] : []),
    ...(has('spreadsheets', 'spreadsheets.readonly') ? ['spreadsheets.read'] : []),
    ...(has('presentations', 'presentations.readonly') ? ['presentations.read'] : []),
  ];
}
async function readable(check: () => Promise<unknown>) {
  try {
    await check();
    return true;
  } catch (error) {
    if (error instanceof AccessDenied) return false;
    throw error;
  }
}

function protectedReferences(source: SourceDependency): RecommendationSource[] {
  const reference = (kind: RecommendationSource['kind'], id: string, revision = '') => ({ kind, id, revision });
  switch (source.kind) {
    case 'table':
      return [reference('table', source.tableId)];
    case 'table-rows':
    case 'table-schema':
      return [reference('table', source.tableId, source.revision)];
    case 'integration-source':
      return [reference('integration', source.integrationId), reference('integration', source.sourceId)];
    case 'github-source':
      return [
        reference('integration', source.integrationId, String(source.generation)),
        reference('integration', source.sourceId, String(source.grantsVersion)),
      ];
    case 'atlassian-source':
      return [
        reference('integration', source.accountId, String(source.generation)),
        reference('integration', source.sourceId, String(source.grantsVersion)),
      ];
    case 'google-integration':
      return [reference('integration', source.integrationId, String(source.generation))];
    case 'mcp-integration':
      return [reference('integration', source.integrationId, String(source.authorizationEpoch))];
    case 'knowledge-document':
      return [
        reference('knowledge', source.sourceId, String(source.accessEpoch)),
        reference('knowledge', source.documentId, source.revisionId),
      ];
    case 'agent-definition':
      return [reference('agent', source.agentId, source.revision)];
    case 'workflow-definition':
      return [reference('workflow', source.workflowId, source.revision)];
    case 'workflow-provider':
      return [reference('integration', source.integrationId, String(source.generation))];
    case 'workspace-skill':
      return [reference('skill', source.skillId, source.revision)];
    case 'tulipfarm-file':
      return [reference('file', source.fileId, source.read.sha256), reference('settings', source.conversationId)];
    case 'google-file':
      return [
        reference('integration', source.integrationId, String(source.generation)),
        reference('settings', source.conversationId),
      ];
    case 'github-personal':
      return [
        reference('integration', source.accountId, String(source.generation)),
        reference('settings', source.origin === 'task' ? source.taskId : source.conversationId),
      ];
    case 'private-conversation':
      return [reference('settings', source.conversationId)];
    case 'private-task':
      return [reference('settings', source.taskId)];
    case 'creation-team':
      return [reference('membership', source.teamId)];
    case 'public-web':
      return [];
    case 'shared-slack-turn':
    case 'personal-memory':
    case 'unknown':
    case 'unavailable':
      throw new AccessDenied();
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

export async function collectRecommendationContext(transaction: Transaction, actor: HumanActor) {
  if (transaction.commonVersion < recommendationCompatibility.minimum)
    throw new Error('Recommendation context schema unavailable');
  const unavailable = async (): Promise<never> => {
    throw new AccessDenied();
  };
  const tx: Transaction = {
    ...transaction,
    requireGitHubSource: unavailable,
    requireGitHubSourceAccess: unavailable,
    requireKnowledgeSource: unavailable,
    knowledgeSourceDependencies: unavailable,
    requireTulipFarmFile: unavailable,
  };
  await lockAuthorization(tx);
  const member = await currentMember(tx, actor);
  const table = (name: string) => qualified(tx.schema, name);
  const entries: RecommendationContextEntry[] = [];
  const retained = new Map<string, { kind: RecommendationSource['kind']; id: string; revisions: Set<string> }>();
  const retain = (input: RecommendationSource) => {
    const source = recommendationSourceSchema.extend({ id: z.uuid() }).parse(input);
    const key = `${source.kind}:${source.id}`;
    const prior = retained.get(key);
    if (prior) prior.revisions.add(source.revision);
    else {
      if (retained.size >= recommendationContextLimits.sources)
        throw new RangeError('Recommendation source dependency limit exceeded');
      retained.set(key, { kind: source.kind, id: source.id, revisions: new Set([source.revision]) });
    }
  };
  const fileProvenance = async (fileId: string) => {
    const file = await requireReadableFile(tx, actor, fileId);
    const bound: AuthorizationTransaction = {
      ...tx,
      requireTulipFarmFile: async (human, reference) => {
        await requireReadableFile(tx, human, reference.fileId);
      },
    };
    const closure = await protectedSourceClosure(bound, [{ kind: 'file', fileId }]);
    const sources: RecommendationSource[] = [{ kind: 'file', id: file.id, revision: file.sha256 }];
    for (const source of closure) {
      await requireProtectedSource(bound, actor, source);
      sources.push(...protectedReferences(source));
    }
    return { file, sources };
  };
  const add = (
    kind: RecommendationSource['kind'],
    row: z.infer<typeof candidateSchema>,
    extra: Partial<Pick<RecommendationContextEntry, 'provider' | 'capabilities'>> = {},
    sources: RecommendationSource[] = [{ kind, id: row.id, revision: row.revision }],
  ) => {
    const entry = entrySchema.parse({
      kind,
      ...row,
      label: boundedText(row.label, 160),
      content: boundedText(row.content, kind === 'memory' ? 16000 : recommendationContextLimits.excerpt),
      key: `${kind}:${row.id}`,
      capabilities: [],
      ...extra,
    });
    if (entries.some(prior => prior.key === entry.key)) {
      for (const source of sources) retain(source);
      return;
    }
    if (
      entries.length < recommendationContextLimits.entries &&
      Buffer.byteLength(JSON.stringify([...entries, entry])) <= recommendationContextLimits.bytes - 2048
    ) {
      for (const source of sources) retain(source);
      entries.push(entry);
    }
  };
  const candidates = async (sql: string, parameters: unknown[] = []) =>
    z
      .array(candidateSchema)
      .max(12)
      .parse((await tx.client.query(sql, parameters)).rows);
  const { found: teammates } = z.object({ found: z.boolean() }).parse(
    (
      await tx.client.query(
        `SELECT EXISTS(SELECT 1 FROM ${table('tf_memberships')} WHERE removed_at IS NULL AND id<>$1
      UNION ALL SELECT 1 FROM ${table('tf_invitations')} WHERE revoked_at IS NULL AND consumed_membership_id IS NULL AND expires_at>now()) AS found`,
        [actor.membershipId],
      )
    ).rows[0],
  );
  add('membership', {
    id: actor.membershipId,
    label: 'Workspace collaboration',
    revision: hash(teammates),
    digest: hash(teammates),
    content: teammates ? 'A teammate or pending invitation exists.' : 'There are no teammates or pending invitations.',
  });

  const memory = await readPersonalMemory(tx, actor);
  if (memory.content.trim())
    add('memory', {
      id: actor.membershipId,
      label: 'My personal memory',
      revision: String(memory.revision),
      content: memory.content,
      digest: hash(memory.content),
    });

  const tableGrant =
    member.role === 'admin'
      ? 'true'
      : await humanTableGrantPredicate(tx, {
          membershipId: '$1',
          assetId: 'generation.table_id',
          permissions: "ARRAY['table.row.read']::text[]",
        });
  const tables = z
    .array(candidateSchema.extend({ physical_table: z.string() }))
    .max(12)
    .parse(
      (
        await tx.client.query(
          `SELECT generation.table_id::text AS id,left(COALESCE(generation.definition->>'label','Business table'),120) AS label,
      generation.revision,left(COALESCE(generation.definition->'fields','[]'::jsonb)::text,2000) AS content,
      md5(COALESCE(generation.definition->'fields','[]'::jsonb)::text) AS digest,generation.physical_table
    FROM ${table('tf_table_generations')} generation JOIN ${table('tf_table_catalog')} c ON c.id=generation.table_id
    WHERE generation.state='active' AND c.archived_at IS NULL AND ${tableGrant} ORDER BY generation.table_id LIMIT 12`,
          member.role === 'admin' ? [] : [actor.membershipId],
        )
      ).rows,
    );
  for (const row of tables) {
    if (!(await canAccessTable(tx, actor, row.id, 'table.row.read'))) continue;
    const { found } = z
      .object({ found: z.boolean() })
      .parse(
        (
          await tx.client.query(
            `SELECT EXISTS(SELECT 1 FROM ${qualified(tx.schema, row.physical_table)} LIMIT 1) AS found`,
          )
        ).rows[0],
      );
    const { physical_table: _physical, ...metadata } = row;
    add(
      'table',
      { ...metadata, digest: hash([metadata.digest, found]) },
      { capabilities: [found ? 'rows.present' : 'rows.empty'] },
    );
  }

  // Definitions with retained private inputs need their owning domain's source closure; omit their excerpts here.
  const withoutDraftSources = (id: string) => `NOT EXISTS (SELECT 1 FROM ${table('tf_chat_authoring_drafts')} d
    JOIN ${table('tf_chat_authoring_decisions')} decision ON decision.draft_id=d.id
    WHERE d.proposal->>'targetId'=(${id})::text AND d.sources<>'[]'::jsonb)`;
  for (const row of await candidates(
    `SELECT a.id::text,left(COALESCE(d.definition->>'name',a.display_name),160) AS label,d.revision,
      left(COALESCE(d.definition->>'instructions',''),2000) AS content,md5(d.definition::text) AS digest
    FROM ${table('tf_agents')} a JOIN LATERAL (SELECT v.definition_revision FROM ${table('tf_agent_activations')} v
      WHERE v.agent_id=a.id AND v.revoked_at IS NULL ORDER BY v.activated_at DESC NULLS LAST,v.id DESC LIMIT 1) active ON true
    JOIN ${table('tf_agent_definitions')} d ON d.agent_id=a.id AND d.revision=active.definition_revision
    WHERE a.enabled AND a.deleted_at IS NULL AND a.saved_revision IS NOT NULL
      AND EXISTS (SELECT 1 FROM ${table('tf_agent_saved_revisions')} s WHERE s.agent_id=a.id AND s.definition_revision=d.revision)
      AND ${definitionGrantPredicate(tx, 'agent', 'a.id', '$1', "'read'")}
      AND ${withoutDraftSources('a.id')} AND COALESCE(d.definition->'sources','[]'::jsonb)='[]'::jsonb AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(d.definition->'skills','[]'::jsonb)) selected
        JOIN ${table('tf_workspace_skills')} referenced ON referenced.id::text=selected->>'id')
    ORDER BY a.id LIMIT 12`,
    [actor.membershipId],
  ))
    add('agent', row);
  for (const row of await candidates(
    `SELECT s.id::text,left(COALESCE(r.definition->>'name','Skill'),160) AS label,r.revision,
      left(COALESCE(r.definition->>'description','') || E'\\n' || COALESCE(r.definition->>'instructions',''),2000) AS content,md5(r.definition::text) AS digest
    FROM ${table('tf_workspace_skills')} s JOIN ${table('tf_workspace_skill_revisions')} r ON r.skill_id=s.id AND r.revision=s.active_revision
    WHERE s.enabled AND s.archived_at IS NULL AND s.deleted_at IS NULL AND ${definitionGrantPredicate(tx, 'skill', 's.id', '$1', "'read'")}
      AND ${withoutDraftSources('s.id')} AND COALESCE(r.definition->'sources','[]'::jsonb)='[]'::jsonb
    ORDER BY s.id LIMIT 12`,
    [actor.membershipId],
  ))
    add('skill', row);
  for (const row of await candidates(
    `SELECT w.id::text,left(COALESCE(r.definition->>'name','Workflow'),160) AS label,
      r.id::text AS revision,'' AS content,md5(r.definition::text) AS digest
    FROM ${table('tf_workflows')} w JOIN ${table('tf_workflow_revisions')} r ON r.workflow_id=w.id AND r.id=w.active_revision
    WHERE w.enabled AND w.archived_at IS NULL AND ${readableWorkflow(tx, 'w', '$1')}
    ORDER BY w.id LIMIT 12`,
    [actor.membershipId],
  ))
    add('workflow', row);

  const projects = await candidates(
    `SELECT p.id::text,left(p.name,160) AS label,p.revision::text,
      left(p.instructions,2000) AS content,md5(p.instructions) AS digest
    FROM ${table('tf_projects')} p JOIN ${table('tf_project_members')} pm ON pm.project_id=p.id
    WHERE pm.membership_id=$1 AND pm.removed_at IS NULL AND p.archived_at IS NULL ORDER BY p.id LIMIT 4`,
    [actor.membershipId],
  );
  for (const project of projects) {
    add('project', project);
    const files = z
      .array(
        z.object({
          id: z.uuid(),
          revisionId: z.uuid(),
          title: z.string(),
          pinned: z.boolean(),
          content: z.string(),
          digest: z.string(),
        }),
      )
      .max(4)
      .parse(
        (
          await tx.client.query(
            `SELECT k.id,r.id AS "revisionId",left(k.title,160) AS title,k.pinned,left(r.content,2000) AS content,md5(r.content) AS digest
      FROM ${table('tf_project_knowledge')} k JOIN ${table('tf_project_knowledge_revisions')} r ON r.id=k.current_revision
      WHERE k.project_id=$1 AND k.removed_at IS NULL ORDER BY k.id LIMIT 4`,
            [project.id],
          )
        ).rows,
      );
    const checked = await recheckProjectContext(tx, {
      projectId: project.id,
      revision: 0,
      instructions: '',
      unavailable: [],
      files: files.map(file => ({ ...file, start: 0, end: file.content.length })),
    });
    let readers: HumanActor[] | undefined;
    for (const file of checked.files) {
      const sources: RecommendationSource[] = [
        { kind: 'project', id: project.id, revision: project.revision },
        { kind: 'knowledge', id: file.id, revision: file.revisionId },
      ];
      const sourceFileId = projectSourceFile(project.id, file.id, file.revisionId);
      if (sourceFileId) {
        if (
          !(await readable(async () => {
            sources.push(...(await fileProvenance(sourceFileId)).sources);
          }))
        )
          continue;
        readers ??= await projectReaders(tx, project.id);
        for (const reader of readers) sources.push({ kind: 'membership', id: reader.membershipId, revision: '' });
      }
      add(
        'project',
        {
          id: `${project.id}:${file.id}`,
          revision: file.revisionId,
          label: file.title,
          content: file.content,
          digest: z.string().parse(files.find(candidate => candidate.id === file.id)?.digest),
        },
        {},
        sources,
      );
    }
  }

  const google = z
    .array(integrationSchema)
    .max(12)
    .parse(
      (
        await tx.client.query(
          `SELECT id::text,scopes,account_id AS account_key FROM ${table('tf_google_integrations')} WHERE membership_id=$1 AND user_id=$2
      AND status='connected' AND credential IS NOT NULL ORDER BY id LIMIT 12`,
          [actor.membershipId, actor.userId],
        )
      ).rows,
    );
  for (const row of google) {
    const capabilities = googleCapabilities(row.scopes);
    const digest = hash([row.account_key, capabilities]);
    if (capabilities.length)
      add(
        'integration',
        { id: row.id, label: 'Google', content: '', revision: digest, digest },
        { provider: 'google', capabilities },
      );
  }
  const github = z
    .array(integrationSchema)
    .max(12)
    .parse(
      (
        await tx.client.query(
          `SELECT id::text,scopes,identity->>'id' AS account_key FROM ${table('tf_github_accounts')} WHERE owner_membership_id=$1 AND state='active'
      AND credential IS NOT NULL AND (expires_at IS NULL OR expires_at>now()) ORDER BY id LIMIT 12`,
          [actor.membershipId],
        )
      ).rows,
    );
  for (const row of github) {
    const capabilities = row.scopes.includes('repo')
      ? ['github.private.read', 'github.public.read']
      : row.scopes.includes('public_repo')
        ? ['github.public.read']
        : [];
    const digest = hash([row.account_key, capabilities]);
    if (capabilities.length)
      add(
        'integration',
        { id: row.id, label: 'GitHub', content: '', revision: digest, digest },
        { provider: 'github', capabilities },
      );
  }
  const integrationGrant = (
    permission: 'read' | 'use',
  ) => `(EXISTS (SELECT 1 FROM ${table('tf_integration_person_grants')} g
    WHERE g.integration_id=c.id AND g.membership_id=$1 AND g.permission='${permission}')
    OR EXISTS (SELECT 1 FROM ${table('tf_integration_grants')} g JOIN ${table('tf_member_teams')} mt ON mt.team_id=g.team_id
      WHERE g.integration_id=c.id AND mt.membership_id=$1 AND g.permission='${permission}'))`;
  const teamGithub = await candidates(
    `SELECT c.id::text,left(c.name,160) AS label,'' AS revision,'' AS content,'' AS digest
    FROM ${table('tf_integrations')} c WHERE c.enabled AND c.deleted_at IS NULL
      AND ${integrationGrant('read')} AND ${integrationGrant('use')} ORDER BY c.id LIMIT 12`,
    [actor.membershipId],
  );
  for (const row of teamGithub) {
    if (!(await canAccessAsset(tx, actor, row.id, 'integration.use'))) continue;
    const sources = z
      .array(z.object({ id: z.uuid(), owner: z.string(), repo: z.string() }))
      .max(12)
      .parse(
        (
          await tx.client.query(
            `SELECT s.id,s.owner,s.repo FROM ${table('tf_integration_sources')} s WHERE s.integration_id=$1
      AND (EXISTS (SELECT 1 FROM ${table('tf_integration_source_person_grants')} g WHERE g.source_id=s.id AND g.membership_id=$2 AND g.permission='github.issue.read')
        OR EXISTS (SELECT 1 FROM ${table('tf_integration_source_grants')} g JOIN ${table('tf_member_teams')} mt ON mt.team_id=g.team_id
          WHERE g.source_id=s.id AND mt.membership_id=$2 AND g.permission='github.issue.read'))
      ORDER BY s.id LIMIT 12`,
            [row.id, actor.membershipId],
          )
        ).rows,
      );
    for (const source of sources)
      if (await canAccessAsset(tx, actor, source.id, 'github.issue.read')) {
        const digest = hash([source.owner, source.repo]);
        add(
          'integration',
          {
            id: source.id,
            label: `${source.owner}/${source.repo}`.slice(0, 160),
            revision: digest,
            content: '',
            digest,
          },
          { provider: 'github', capabilities: ['github.issue.read'] },
          [
            { kind: 'integration', id: source.id, revision: digest },
            { kind: 'integration', id: row.id, revision: digest },
          ],
        );
      }
  }

  const slack = await candidates(
    `SELECT i.id::text,'Slack' AS label,'' AS revision,'' AS content,'slack.draft' AS digest
    FROM ${table('tf_slack_installations')} i WHERE i.state='active' AND i.bot_credential IS NOT NULL AND 'chat:write'=ANY(i.scopes)
      AND EXISTS (SELECT 1 FROM ${table('tf_slack_installation_grants')} g WHERE g.installation_id=i.id AND
        (g.membership_id=$1 OR EXISTS(SELECT 1 FROM ${table('tf_member_teams')} mt WHERE mt.team_id=g.team_id AND mt.membership_id=$1)))
    ORDER BY i.id LIMIT 12`,
    [actor.membershipId],
  );
  for (const row of slack) add('integration', row, { provider: 'slack', capabilities: ['slack.draft'] });
  const personalSlack = await candidates(
    `SELECT p.id::text,'Slack account' AS label,p.generation::text AS revision,'' AS content,
      md5(jsonb_build_array(i.id,p.slack_user_id,p.scopes)::text) AS digest
    FROM ${table('tf_slack_identities')} p JOIN ${table('tf_slack_installations')} i ON i.id=p.installation_id AND i.generation=p.generation
    WHERE p.membership_id=$1 AND p.user_id=$2 AND p.state='authorized' AND i.state='active' AND p.credential IS NOT NULL
      AND COALESCE(p.credential->'rotation'->>'state','ready')<>'reconnect-required'
      AND p.scopes && ARRAY['channels:history','groups:history','im:history','mpim:history']::text[]
      AND NOT EXISTS(SELECT 1 FROM ${table('tf_slack_user_revocations')} v WHERE v.installation_id=i.id AND v.generation=i.generation AND v.slack_user_id=p.slack_user_id)
    ORDER BY p.id LIMIT 12`,
    [actor.membershipId, actor.userId],
  );
  for (const row of personalSlack)
    add('integration', row, { provider: 'slack', capabilities: ['slack.knowledge.select'] });
  const atlassian = z
    .array(candidateSchema.extend({ account_id: z.uuid() }))
    .max(12)
    .parse(
      (
        await tx.client.query(
          `SELECT s.id::text,s.account_id,left(s.name,160) AS label,md5(s.binding::text) AS revision,
      left(s.binding::text,2000) AS content,md5(jsonb_build_object('binding',s.binding,'protocol',a.protocol,'account',a.identity->>'id',
        'scopes',ARRAY(SELECT DISTINCT scope FROM unnest(a.scopes) scope WHERE scope NOT IN ('offline_access','openid','profile','email','read:me') ORDER BY scope),
        'resources',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',resource->>'id',
          'scopes',ARRAY(SELECT DISTINCT scope FROM jsonb_array_elements_text(COALESCE(resource->'scopes','[]'::jsonb)) scope ORDER BY scope)) ORDER BY resource->>'id')
          FROM jsonb_array_elements(a.resources) resource WHERE resource->>'id'=COALESCE(s.binding->>'cloudId',s.binding->>'boardId')),'[]'::jsonb))::text) AS digest
    FROM ${table('tf_atlassian_sources')} s JOIN ${table('tf_atlassian_accounts')} a ON a.id=s.account_id
    WHERE s.membership_id=$1 AND s.enabled AND a.state='active' AND a.expires_at>now() AND a.credential IS NOT NULL
      AND ((a.ownership='personal' AND a.owner_membership_id=$1) OR (a.ownership='business' AND
        (EXISTS (SELECT 1 FROM ${table('tf_atlassian_account_member_grants')} g WHERE g.account_id=a.id AND g.membership_id=$1)
        OR EXISTS (SELECT 1 FROM ${table('tf_atlassian_account_team_grants')} g JOIN ${table('tf_member_teams')} mt ON mt.team_id=g.team_id
          WHERE g.account_id=a.id AND mt.membership_id=$1))))
    ORDER BY s.id LIMIT 12`,
          [actor.membershipId],
        )
      ).rows,
    );
  for (const { account_id, ...row } of atlassian)
    add('integration', row, { provider: 'atlassian', capabilities: ['atlassian.source.read'] }, [
      { kind: 'integration', id: row.id, revision: row.revision },
      { kind: 'integration', id: account_id, revision: row.digest },
    ]);
  const mcp = z
    .array(z.object({ id: z.uuid(), name: z.string(), authorization_epoch: z.number().int() }))
    .max(12)
    .parse(
      (
        await tx.client.query(
          `SELECT c.id,left(c.name,160) AS name,c.authorization_epoch FROM ${table('tf_mcp_integrations')} c
    WHERE c.lifecycle='active' AND c.credential IS NOT NULL AND (c.credential_expires_at IS NULL OR c.credential_expires_at>now())
      AND ((c.ownership='personal' AND c.owner_membership_id=$1) OR (c.ownership='shared' AND
        (EXISTS (SELECT 1 FROM ${table('tf_mcp_member_grants')} g WHERE g.integration_id=c.id AND g.membership_id=$1)
        OR EXISTS (SELECT 1 FROM ${table('tf_mcp_team_grants')} g JOIN ${table('tf_member_teams')} mt ON mt.team_id=g.team_id
          WHERE g.integration_id=c.id AND mt.membership_id=$1))))
    ORDER BY c.id LIMIT 12`,
          [actor.membershipId],
        )
      ).rows,
    );
  for (const row of mcp) {
    if (
      !(await readable(() =>
        requireMcpSource(tx, actor, {
          kind: 'mcp-integration',
          integrationId: row.id,
          authorizationEpoch: row.authorization_epoch,
        }),
      ))
    )
      continue;
    const tools = z
      .array(z.object({ name: z.string(), revision: z.string(), standing_exception: z.boolean() }))
      .max(20)
      .parse(
        (
          await tx.client.query(
            `SELECT left(p.name,200) AS name,p.enabled_revision AS revision,p.standing_exception FROM ${table('tf_mcp_tool_policies')} p
      JOIN ${table('tf_mcp_tool_revisions')} r ON r.integration_id=p.integration_id AND r.name=p.name AND r.revision=p.enabled_revision
      WHERE p.integration_id=$1 AND p.present AND p.enabled_revision=p.discovered_revision AND r.compatibility_reason IS NULL
      ORDER BY p.name LIMIT 20`,
            [row.id],
          )
        ).rows,
      );
    if (tools.length)
      add(
        'integration',
        { id: row.id, label: row.name, content: '', revision: hash(tools), digest: hash(tools) },
        { provider: 'mcp', capabilities: tools.map(tool => tool.name) },
      );
  }

  const files = await candidates(
    `SELECT id::text,left(name,160) AS label,sha256 AS revision,
      COALESCE(media_type,'') AS content,sha256 AS digest FROM ${table('tf_files')}
    WHERE creator_membership_id=$1 AND kind='file' AND object_owner='files' AND ready AND trashed_at IS NULL AND deleting_at IS NULL
      AND sha256 IS NOT NULL AND object_key IS NOT NULL ORDER BY id LIMIT 12`,
    [actor.membershipId],
  );
  for (const row of files) {
    let sources: RecommendationSource[] = [];
    if (
      await readable(async () => {
        sources = (await fileProvenance(row.id)).sources;
      })
    )
      add('file', row, {}, sources);
  }
  const knowledge = z
    .array(
      candidateSchema.extend({
        source_id: z.uuid(),
        access_epoch: z.number().int().positive(),
        original: z.unknown(),
        sources: z.unknown(),
        provider: z.enum(['note', 'file']),
      }),
    )
    .max(12)
    .parse(
      (
        await tx.client.query(
          `SELECT d.id::text,s.id AS source_id,s.access_epoch,left(r.title,160) AS label,r.id::text AS revision,'' AS content,r.fingerprint AS digest,
      CASE WHEN s.provider='file' THEN jsonb_build_object('fileId',r.original->>'fileId','sha256',r.original->>'sha256','bytes',r.original->'bytes') ELSE '{}'::jsonb END AS original,r.sources,s.provider
    FROM ${table('tf_knowledge_sources')} s JOIN ${table('tf_knowledge_documents')} d ON d.source_id=s.id
    JOIN ${table('tf_knowledge_publications')} p ON p.id=d.lexical_publication_id
    JOIN ${table('tf_knowledge_revisions')} r ON r.id=p.revision_id
    WHERE s.owner_membership_id=$1 AND s.state='active' AND s.provider IN ('note','file') AND d.tombstoned_at IS NULL
      AND d.observed_revision_id=r.id AND ((s.provider='file' AND r.original->>'kind'='file')
        OR (s.provider='note' AND r.original->>'kind'='object'))
      AND jsonb_array_length(r.sources)<=20 ORDER BY d.id LIMIT 12`,
          [actor.membershipId],
        )
      ).rows,
    );
  for (const row of knowledge) {
    const dependencies = sourceDependenciesSchema.parse(row.sources);
    if (
      dependencies.some(
        source =>
          ![
            'table',
            'table-rows',
            'table-schema',
            'integration-source',
            'github-source',
            'atlassian-source',
            'google-integration',
            'mcp-integration',
            'public-web',
          ].includes(source.kind),
      )
    )
      continue;
    let allowed = true;
    for (const source of dependencies)
      if (!(await readable(() => requireProtectedSource(tx, actor, source)))) {
        allowed = false;
        break;
      }
    if (!allowed) continue;
    const sources: RecommendationSource[] = [
      { kind: 'knowledge', id: row.id, revision: row.revision },
      { kind: 'knowledge', id: row.source_id, revision: String(row.access_epoch) },
      ...dependencies.flatMap(protectedReferences),
    ];
    if (row.provider === 'file') {
      const original = z.object({ fileId: z.uuid(), sha256: z.string(), bytes: z.number().int() }).parse(row.original);
      if (
        !(await readable(async () => {
          const { file, sources: provenance } = await fileProvenance(original.fileId);
          if (file.sha256 !== original.sha256 || file.size !== original.bytes) throw new AccessDenied();
          sources.push(...provenance);
        }))
      )
        continue;
    }
    const {
      original: _original,
      sources: _sources,
      provider: _provider,
      source_id: _sourceId,
      access_epoch: _accessEpoch,
      ...metadata
    } = row;
    add('knowledge', metadata, {}, sources);
  }
  const has = (provider: z.infer<typeof providerSchema>) => entries.some(entry => entry.provider === provider);
  const capability = (name: string) => entries.some(entry => entry.capabilities.includes(name));
  const firstTable = entries.find(entry => entry.kind === 'table');
  const indexedProviders = z
    .array(z.object({ provider: z.string() }))
    .parse(
      (
        await tx.client.query(
          `SELECT DISTINCT provider FROM ${table('tf_knowledge_sources')} WHERE owner_membership_id=$1 AND state='active' AND provider IN ('github','slack','google') ORDER BY provider`,
          [actor.membershipId],
        )
      ).rows,
    )
    .map(row => row.provider);
  const signals: RecommendationSignals = {
    slack: has('slack'),
    google: has('google'),
    github: has('github'),
    table: firstTable ? { label: firstTable.label } : null,
    workflow: entries.some(entry => entry.kind === 'workflow'),
    knowledge: entries.some(entry => ['knowledge', 'file'].includes(entry.kind)),
    teammates,
    connected: entries.some(entry => entry.kind === 'integration'),
    gmail: capability('gmail.read'),
    googleCalendar: capability('calendar.read'),
    personalized: memory.content.trim().length > 0,
    indexedProviders,
    indexableProviders: [
      ...(github.some(row => row.scopes.includes('repo') || row.scopes.includes('public_repo')) ? ['github'] : []),
      ...(personalSlack.length ? ['slack'] : []),
      ...(google.length ? ['google'] : []),
    ],
  };
  const context: RecommendationContext = {
    policy: recommendationPolicy,
    signals,
    entries: entries.sort((a, b) => compare(a.key, b.key)),
  };
  const sources = [...retained.values()]
    .map(({ kind, id, revisions }) => ({
      kind,
      id,
      revision: revisions.size === 1 ? [...revisions][0]! : hash([...revisions].sort(compare)),
    }))
    .sort((a, b) => compare(`${a.kind}:${a.id}`, `${b.kind}:${b.id}`));
  return { signals, context, sources, fingerprint: recommendationContextFingerprint(context) };
}

/** Structural/source validation, not a claim that arbitrary model prose is semantically safe. */
export function validateGeneratedRecommendations(text: string, context: RecommendationContext) {
  if (Buffer.byteLength(text) > 16 * 1024) throw new Error('Recommendation response too large');
  const items = generatedPromptsSchema.parse(JSON.parse(text));
  const available = new Map(context.entries.map(entry => [entry.key, entry]));
  const brands = new Set([
    ...((context.signals.gmail ?? context.signals.google) ? ['gmail'] : []),
    ...((context.signals.googleCalendar ?? context.signals.google) ? ['google-calendar'] : []),
    ...(context.signals.github ? ['github'] : []),
    ...(context.signals.slack ? ['slack'] : []),
  ]);
  const providerWords: [RegExp, boolean][] = [
    [/\bgmail\b/i, brands.has('gmail')],
    [/\bgoogle calendar\b/i, brands.has('google-calendar')],
    [/\bgoogle\b/i, context.signals.google],
    [/\bgithub\b/i, context.signals.github],
    [/\bslack\b/i, context.signals.slack],
    [/\b(?:atlassian|jira|confluence|trello)\b/i, context.entries.some(entry => entry.provider === 'atlassian')],
    [/\bmcp\b/i, context.entries.some(entry => entry.provider === 'mcp')],
  ];
  for (const item of items) {
    const prose = `${item.label}\n${item.action.prompt}`;
    if (
      item.sources.some(source => !available.has(source)) ||
      item.brands.some(brand => !brands.has(brand)) ||
      providerWords.some(([pattern, allowed]) => !allowed && pattern.test(prose)) ||
      item.brands.some(
        brand =>
          !item.sources.some(source => {
            const input = available.get(source);
            return (
              input?.provider === (brand === 'gmail' || brand === 'google-calendar' ? 'google' : brand) &&
              (brand !== 'gmail' || input.capabilities.includes('gmail.read')) &&
              (brand !== 'google-calendar' || input.capabilities.includes('calendar.read'))
            );
          }),
      )
    )
      throw new Error('Unknown recommendation source or capability');
    for (const reference of prose.matchAll(
      /\b(?:table|agent|skill|workflow|integration|memory|knowledge|file|project):[\w:-]+/g,
    )) {
      if (!available.has(reference[0])) throw new Error('Unknown recommendation source');
    }
  }
  return items;
}
