import { AsyncLocalStorage } from 'node:async_hooks';
import { escapeIdentifier } from 'pg';
import { z } from 'zod';
import { AccessDenied, type Actor, type AuthorizationTransaction } from './index.ts';
import {
  fileReadReceiptSchema,
  sourceDependencySchema,
  mcpSourceDependencySchema,
  taskGoogleFileSourceSchema,
  type SourceDependency,
} from './source-dependencies.ts';
import { uuidSchema } from './contracts.ts';
import { githubTaskContext, withoutGitHubSourcesBefore } from './github-task.ts';

const referenceSchema = z.union([
  sourceDependencySchema,
  z.strictObject({ kind: z.literal('task'), taskId: uuidSchema, throughSequence: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal('attachment'), conversationId: uuidSchema, attachmentId: uuidSchema }),
  z.strictObject({ kind: z.literal('file'), fileId: uuidSchema, read: fileReadReceiptSchema.optional() }),
  taskGoogleFileSourceSchema,
]);
const referencesSchema = z.array(referenceSchema).max(1000);
const installedSchema = z.object({ installed: z.boolean() });
const allowedSchema = z.object({ allowed: z.boolean() });
const skillReferencesSchema = z.array(z.object({ id: z.string(), revision: z.string() }));
const webPagesSchema = z.array(z.object({ url: z.string() }));
const tableIdsSchema = z.array(z.object({ id: uuidSchema }));
const unboundedReferencesSchema = z.array(referenceSchema);
type McpSource = z.infer<typeof mcpSourceDependencySchema>;
const context = new AsyncLocalStorage<readonly McpSource[]>();
const table = (tx: AuthorizationTransaction, name: string) =>
  `${escapeIdentifier(tx.schema)}.${escapeIdentifier(name)}`;

export async function mcpSourceClosure(tx: AuthorizationTransaction, sources: unknown): Promise<McpSource[]> {
  const retained = await sourceClosure(tx, sources, false);
  const mcp = retained.filter(source => source.kind === 'mcp-integration');
  if (
    mcp.length &&
    retained.some(
      source => source.kind === 'unknown' || source.kind === 'unavailable' || source.kind === 'personal-memory',
    )
  )
    throw new AccessDenied();
  return mcp;
}

export async function protectedSourceClosure(
  tx: AuthorizationTransaction,
  sources: unknown,
): Promise<SourceDependency[]> {
  return sourceClosure(tx, sources, true);
}

async function sourceClosure(
  tx: AuthorizationTransaction,
  sources: unknown,
  full: boolean,
): Promise<SourceDependency[]> {
  const pending = referencesSchema.parse(sources);
  const visited = new Set<string>();
  const edges = new Map<string, string[]>();
  let parent: string | undefined;
  const retained = new Map<string, SourceDependency>();
  const installed = new Map<string, boolean>();
  async function has(name: string) {
    if (!installed.has(name))
      installed.set(
        name,
        installedSchema.parse(
          (await tx.client.query('SELECT to_regclass($1) IS NOT NULL AS installed', [table(tx, name)])).rows[0],
        ).installed,
      );
    return installed.get(name);
  }
  function append(value: unknown) {
    const children = referencesSchema.parse(value);
    if (parent) edges.set(parent, [...(edges.get(parent) ?? []), ...children.map(child => JSON.stringify(child))]);
    pending.push(...children);
  }
  for (let index = 0; index < pending.length; index++) {
    const source = pending[index];
    if (!source) throw new AccessDenied();
    const key = JSON.stringify(source);
    if (visited.has(key)) continue;
    visited.add(key);
    parent = key;
    if (visited.size > 1000 || pending.length > 10000) throw new AccessDenied();
    if (
      !full &&
      source.kind !== 'mcp-integration' &&
      source.kind !== 'knowledge-document' &&
      !(await has('tf_mcp_integrations'))
    )
      continue;
    if (source.kind === 'task') retained.set(`task:${source.taskId}`, { kind: 'private-task', taskId: source.taskId });
    // A task's Files or Google Drive input is checked against its owner's current access where it is read, so it adds no retained dependency.
    else if (source.kind !== 'attachment' && source.kind !== 'file' && source.kind !== 'google-drive-file')
      retained.set(key, source);
    switch (source.kind) {
      case 'file':
      case 'tulipfarm-file':
        if (await has('tf_file_skill_sources')) {
          const row = (
            await tx.client.query(`SELECT sources FROM ${table(tx, 'tf_file_skill_sources')} WHERE file_id=$1`, [
              source.fileId,
            ])
          ).rows[0];
          if (row) append(row.sources);
        }
        break;
      case 'knowledge-document':
        if (!tx.knowledgeSourceDependencies) throw new AccessDenied();
        append(await tx.knowledgeSourceDependencies(source));
        break;
      case 'attachment':
        if (
          full &&
          !(
            await tx.client.query(
              `SELECT 1 FROM ${table(tx, 'tf_conversation_attachments')} a JOIN ${table(tx, 'tf_conversation_parts')} p ON p.conversation_id=a.conversation_id AND p.message_id=a.message_id AND p.attachment_id=a.id WHERE a.id=$1 AND a.conversation_id=$2 AND a.state='bound'`,
              [source.attachmentId, source.conversationId],
            )
          ).rowCount
        )
          throw new AccessDenied();
        append([{ kind: 'private-conversation', conversationId: source.conversationId }]);
        break;
      case 'workspace-skill': {
        const row = (
          await tx.client.query(
            `SELECT definition FROM ${table(tx, 'tf_workspace_skill_revisions')} WHERE skill_id=$1 AND revision=$2`,
            [source.skillId, source.revision],
          )
        ).rows[0];
        if (!row) throw new AccessDenied();
        append(row.definition.sources ?? []);
        if (await has('tf_chat_authoring_drafts')) {
          const drafts = await tx.client.query(
            `SELECT d.sources FROM ${table(tx, 'tf_chat_authoring_drafts')} d JOIN ${table(tx, 'tf_chat_authoring_decisions')} c ON c.draft_id=d.id WHERE d.proposal->>'targetId'=$1 AND c.outcome->>'kind'='skill' AND c.outcome->'receipt'->>'savedRevision'=$2`,
            [source.skillId, source.revision],
          );
          for (const draft of drafts.rows) append(draft.sources);
        }
        break;
      }
      case 'workflow-definition':
        if (await has('tf_chat_authoring_drafts')) {
          const drafts = await tx.client.query(
            `SELECT d.sources FROM ${table(tx, 'tf_chat_authoring_drafts')} d JOIN ${table(tx, 'tf_chat_authoring_decisions')} c ON c.draft_id=d.id WHERE d.proposal->>'kind'='workflow' AND c.outcome->>'kind'='workflow' AND c.outcome->>'workflowId'=$1 AND c.outcome->>'revision'=$2`,
            [source.workflowId, source.revision],
          );
          for (const draft of drafts.rows) append(draft.sources);
        }
        break;
      case 'agent-definition': {
        const definitions = await tx.client.query(
          `SELECT DISTINCT d.definition FROM ${table(tx, 'tf_agent_definitions')} d LEFT JOIN ${table(tx, 'tf_agent_saved_revisions')} s ON s.agent_id=d.agent_id AND s.definition_revision=d.revision WHERE d.agent_id=$1 AND (s.soul_revision=$2 OR d.revision=$2)`,
          [source.agentId, source.revision],
        );
        if (!definitions.rowCount) throw new AccessDenied();
        for (const row of definitions.rows) {
          append(row.definition.sources ?? []);
          const skills = skillReferencesSchema.parse(row.definition.skills ?? []);
          append(
            skills
              .filter(skill => uuidSchema.safeParse(skill.id).success)
              .map(skill => ({ kind: 'workspace-skill', skillId: skill.id, revision: skill.revision })),
          );
        }
        if (await has('tf_chat_authoring_drafts')) {
          const drafts = await tx.client.query(
            `SELECT d.sources FROM ${table(tx, 'tf_chat_authoring_drafts')} d JOIN ${table(tx, 'tf_chat_authoring_decisions')} c ON c.draft_id=d.id JOIN ${table(tx, 'tf_agent_commands')} a ON a.id::text=c.outcome->'receipt'->>'commandId' LEFT JOIN ${table(tx, 'tf_agent_saved_revisions')} s ON s.agent_id=a.agent_id AND s.soul_revision=a.accepted_revision WHERE a.agent_id=$1 AND (a.accepted_revision=$2 OR s.definition_revision=$2) AND c.outcome->>'kind'='agent'`,
            [source.agentId, source.revision],
          );
          for (const draft of drafts.rows) append(draft.sources);
        }
        break;
      }
      case 'private-task':
        append([{ kind: 'task', taskId: source.taskId, throughSequence: 2147483647 }]);
        break;
      case 'task': {
        const github = await githubTaskContext(tx, source.taskId);
        if (source.throughSequence < github.sequence) throw new AccessDenied();
        const task = (
          await tx.client.query(
            `SELECT agent_id,definition_revision,skills FROM ${table(tx, 'tf_agent_tasks')} WHERE id=$1`,
            [source.taskId],
          )
        ).rows[0];
        if (!task) throw new AccessDenied();
        if (
          full &&
          source.throughSequence !== 2147483647 &&
          !(
            await tx.client.query(
              `SELECT 1 FROM ${table(tx, 'tf_agent_task_messages')} WHERE task_id=$1 AND sequence=$2`,
              [source.taskId, source.throughSequence],
            )
          ).rowCount
        )
          throw new AccessDenied();
        const definitions = await tx.client.query(
          `SELECT soul_revision FROM ${table(tx, 'tf_agent_saved_revisions')} WHERE agent_id=$1 AND definition_revision=$2`,
          [task.agent_id, task.definition_revision],
        );
        if (!definitions.rowCount) throw new AccessDenied();
        for (const definition of definitions.rows)
          append([{ kind: 'agent-definition', agentId: task.agent_id, revision: definition.soul_revision }]);
        const skills = skillReferencesSchema.parse(task.skills);
        append(
          skills
            .filter(skill => uuidSchema.safeParse(skill.id).success)
            .map(skill => ({ kind: 'workspace-skill', skillId: skill.id, revision: skill.revision })),
        );
        const messages = await tx.client.query(
          `SELECT sources FROM ${table(tx, 'tf_agent_task_messages')} WHERE task_id=$1 AND sequence<=$2 AND sequence>=$3 ORDER BY sequence LIMIT 1001`,
          [source.taskId, source.throughSequence, github.sequence],
        );
        if (!messages.rowCount || messages.rows.length > 1000) throw new AccessDenied();
        for (const message of messages.rows) append(message.sources);
        if (await has('tf_conversation_model_sources')) {
          const models = await tx.client.query(
            `SELECT mcp_sources FROM ${table(tx, 'tf_agent_task_steps')} WHERE task_id=$1 LIMIT 1001`,
            [source.taskId],
          );
          if (models.rows.length > 1000) throw new AccessDenied();
          for (const model of models.rows)
            append(withoutGitHubSourcesBefore(model.mcp_sources, source.taskId, github.generation));
        }
        if (await has('tf_agent_task_steps')) {
          const receipts = await tx.client.query(
            `SELECT c.call,c.result FROM ${table(tx, 'tf_agent_tool_calls')} c JOIN ${table(tx, 'tf_agent_task_runs')} b ON b.run_id=c.run_id WHERE b.task_id=$1 AND b.generation>=$2 LIMIT 1001`,
            [source.taskId, github.generation],
          );
          if (receipts.rows.length > 1000) throw new AccessDenied();
          for (const receipt of receipts.rows) {
            if (receipt.result?.kind === 'public-web')
              // Web results list the pages they read, not source dependencies; each page is a public-web dependency.
              append(
                webPagesSchema.parse(receipt.result.sources ?? []).map(page => ({ kind: 'public-web', url: page.url })),
              );
            else if (receipt.result?.sources) append(receipt.result.sources);
            if (full && receipt.call.tableId) append([{ kind: 'table', tableId: receipt.call.tableId }]);
            if (full && receipt.call.tool === 'tables.list' && receipt.result?.tables) {
              const tables = tableIdsSchema.parse(receipt.result.tables);
              append(tables.map(item => ({ kind: 'table', tableId: item.id })));
            }
          }
          if (full) {
            const admitted = await tx.client.query(
              `SELECT source_tables FROM ${table(tx, 'tf_agent_task_steps')} WHERE task_id=$1 LIMIT 1001`,
              [source.taskId],
            );
            if (admitted.rows.length > 1000) throw new AccessDenied();
            for (const row of admitted.rows)
              append(
                z
                  .array(uuidSchema)
                  .parse(row.source_tables)
                  .map(tableId => ({ kind: 'table', tableId })),
              );
          }
        }
        if (await has('tf_mcp_actions')) {
          const actions = await tx.client.query(
            `SELECT a.integration_id,a.authorization_epoch,a.sources,r.sources AS result_sources FROM ${table(tx, 'tf_mcp_actions')} a LEFT JOIN ${table(tx, 'tf_mcp_receipts')} r ON r.action_id=a.id WHERE a.origin->>'kind'='named-task' AND a.origin->>'taskId'=$1 LIMIT 1001`,
            [source.taskId],
          );
          if (actions.rows.length > 1000) throw new AccessDenied();
          for (const action of actions.rows) {
            append([
              {
                kind: 'mcp-integration',
                integrationId: action.integration_id,
                authorizationEpoch: action.authorization_epoch,
              },
            ]);
            append(action.sources);
            if (action.result_sources) append(action.result_sources);
          }
        }
        break;
      }
      case 'private-conversation':
        if (await has('tf_conversation_model_sources')) {
          const models = await tx.client.query(
            `SELECT s.sources FROM ${table(tx, 'tf_conversation_model_sources')} s JOIN ${table(tx, 'tf_conversation_turns')} t ON t.id=s.turn_id WHERE t.conversation_id=$1 LIMIT 1001`,
            [source.conversationId],
          );
          if (models.rows.length > 1000) throw new AccessDenied();
          for (const model of models.rows) append(model.sources);
          const steps = await tx.client.query(
            `SELECT s.sources,s.output FROM ${table(tx, 'tf_conversation_execution_steps')} s JOIN ${table(tx, 'tf_conversation_turns')} t ON t.id=s.turn_id WHERE t.conversation_id=$1 LIMIT 1001`,
            [source.conversationId],
          );
          if (steps.rows.length > 1000) throw new AccessDenied();
          for (const step of steps.rows) {
            append(step.sources);
            if (step.output !== null) append(step.output.sources);
          }
        }
        if (await has('tf_conversation_results')) {
          const readable = allowedSchema.parse(
            (
              await tx.client.query("SELECT has_table_privilege(current_user,$1,'SELECT') AS allowed", [
                table(tx, 'tf_conversation_results'),
              ])
            ).rows[0],
          ).allowed;
          if (!readable) throw new AccessDenied();
          const results = await tx.client.query(
            `SELECT sources FROM ${table(tx, 'tf_conversation_results')} WHERE conversation_id=$1 LIMIT 1001`,
            [source.conversationId],
          );
          if (results.rows.length > 1000) throw new AccessDenied();
          for (const result of results.rows) append(result.sources);
        }
        if (await has('tf_mcp_actions')) {
          const actions = await tx.client.query(
            `SELECT a.integration_id,a.authorization_epoch,a.sources,r.sources AS result_sources FROM ${table(tx, 'tf_mcp_actions')} a LEFT JOIN ${table(tx, 'tf_mcp_receipts')} r ON r.action_id=a.id WHERE a.origin->>'kind'='private-chat' AND a.origin->>'conversationId'=$1 LIMIT 1001`,
            [source.conversationId],
          );
          if (actions.rows.length > 1000) throw new AccessDenied();
          for (const action of actions.rows) {
            append([
              {
                kind: 'mcp-integration',
                integrationId: action.integration_id,
                authorizationEpoch: action.authorization_epoch,
              },
            ]);
            append(action.sources);
            if (action.result_sources) append(action.result_sources);
          }
        }
        break;
      default:
        break;
    }
  }
  const active = new Map<string, number>(),
    complete = new Set<string>(),
    path: string[] = [];
  function checkCycles(key: string) {
    const start = active.get(key);
    if (start !== undefined) {
      if (path.slice(start).some(item => JSON.parse(item).kind === 'knowledge-document')) throw new AccessDenied();
      return;
    }
    if (complete.has(key)) return;
    active.set(key, path.length);
    path.push(key);
    for (const child of edges.get(key) ?? []) checkCycles(child);
    path.pop();
    active.delete(key);
    complete.add(key);
  }
  for (const key of visited) checkCycles(key);
  return [...retained.values()];
}

export async function withMcpSourceContext<T>(
  tx: AuthorizationTransaction,
  sources: unknown,
  operation: () => Promise<T>,
): Promise<T> {
  const inherited = [...(context.getStore() ?? []), ...(await mcpSourceClosure(tx, sources))];
  return context.run(inherited, operation);
}

export function denyMcpEgress() {
  if (context.getStore()?.length) throw new AccessDenied();
}

export async function requireNoMcpDerived(tx: AuthorizationTransaction, sources: unknown = [], actor?: Actor) {
  denyMcpEgress();
  if (unboundedReferencesSchema.parse(sources).some(source => source.kind === 'private-task')) throw new AccessDenied();
  if ((await mcpSourceClosure(tx, sources)).length) throw new AccessDenied();
  if (actor?.kind === 'agent') {
    const installed = installedSchema.parse(
      (await tx.client.query('SELECT to_regclass($1) IS NOT NULL AS installed', [table(tx, 'tf_agent_task_runs')]))
        .rows[0],
    ).installed;
    if (!installed) return;
    const tasks = await tx.client.query(
      `SELECT r.task_id,max(m.sequence) AS sequence FROM ${table(tx, 'tf_agent_task_runs')} r JOIN ${table(tx, 'tf_agent_task_messages')} m ON m.task_id=r.task_id WHERE r.run_id=$1 GROUP BY r.task_id`,
      [actor.runId],
    );
    for (const task of tasks.rows)
      if ((await mcpSourceClosure(tx, [{ kind: 'task', taskId: task.task_id, throughSequence: task.sequence }])).length)
        throw new AccessDenied();
  }
}
