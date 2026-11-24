import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccessDenied, currentMember, lockAndResolveHuman } from '@tulipfarm/access';
import { readReviewPolicy, reviewActionSchema, type ReviewAction } from '@tulipfarm/workspace-storage/action-review';
import {
  commonCompatibility,
  qualified,
  StorageUnavailableError,
  type SqlClient,
} from '@tulipfarm/workspace-storage/runtime';
import { previewReviewSchema, saveReviewSchema } from './action-review-contracts.ts';
import { WorkspaceSettingsError } from './settings.ts';
import type { WorkspaceStore } from './storage.ts';

export class ActionReviewError extends Error {
  constructor(readonly code: 'action-review-admin-required' | 'action-review-clarification-required') {
    super(code);
  }
}

const phrases: Record<ReviewAction, [RegExp, string]> = {
  'create-table': [/^(?:creat(?:e|es|ing)|mak(?:e|es|ing)) (?:a |an? new )?tables?$/, 'creating a table'],
  'create-agent': [/^(?:creat(?:e|es|ing)|mak(?:e|es|ing)) (?:an? |an? new )?agents?$/, 'creating an agent'],
  'create-skill': [/^(?:creat(?:e|es|ing)|mak(?:e|es|ing)) (?:a |a new )?skills?$/, 'creating a skill'],
  'create-workflow': [
    /^(?:creat(?:e|es|ing)|mak(?:e|es|ing)) (?:an? |a new )?(?:inactive )?workflows?$/,
    'creating an inactive workflow',
  ],
  'create-row': [/^(?:creat(?:e|es|ing)|add(?:s|ing)?|insert(?:s|ing)?) (?:a |a new )?rows?$/, 'adding a row'],
  'update-row': [/^(?:updat(?:e|es|ing)|edit(?:s|ing)?) (?:a |an existing )?rows?$/, 'updating a row'],
  'delete-row': [/^(?:delet(?:e|es|ing)|remov(?:e|es|ing)) (?:a |an existing )?rows?$/, 'deleting a row'],
};

function clarify(): never {
  throw new ActionReviewError('action-review-clarification-required');
}
function actionList(text: string) {
  const list = new Set<ReviewAction>();
  let verb = '';
  for (const term of text.split(/,\s*(?:and |or )?| (?:and|or) /)) {
    const active = term.replace(
      /^(?:a |an |new )?(tables?|agents?|skills?|workflows?|rows?) (?:is|are) (created|added|updated|deleted)$/,
      (_, noun: string, operation: string) => `${operation === 'added' ? 'add' : operation.slice(0, -1)} ${noun}`,
    );
    const normalized = active.replace(/^(tables?) creation$/, 'create $1');
    const match = (phrase: string) => reviewActionSchema.options.find(id => phrases[id][0].test(phrase));
    const explicit = match(normalized);
    const action = explicit ?? match(`${verb} ${normalized}`);
    if (!action || list.has(action)) clarify();
    list.add(action);
    if (explicit) verb = normalized.split(' ')[0]!;
  }
  return [...list];
}

/** A closed grammar: every clause must identify complete actions, never guessed predicates. */
function compileRule(rule: string) {
  const text = rule.toLowerCase().replace(/\s+/g, ' ').replace(/\.$/, '');
  const clauses = text
    .replace(/^(?:please )?ask(?: me)? (?:before |when(?:ever)? (?:bud |you )?)/, '')
    .split(/,? but not before /);
  if (clauses.length > 2) clarify();
  const actions = actionList(clauses[0]!);
  const excluded = clauses[1] === undefined ? [] : actionList(clauses[1]);
  if (excluded.some(id => actions.includes(id))) clarify();
  const list = new Intl.ListFormat('en', { type: 'disjunction' });
  const joined = (ids: ReviewAction[]) => list.format(ids.map(id => phrases[id][1]));
  const interpretation = `Bud will ask before ${joined(actions)}.${excluded.length ? ` This rule will not ask before ${joined(excluded)}.` : ''} Other review requirements still apply.`;
  return { actions, interpretation };
}

type Transaction = { client: SqlClient; schema: string; workspaceId: string };
async function preview(tx: Transaction, membershipId: string, revision: number, rule: string) {
  const compiled = compileRule(rule);
  const { rows } = await tx.client.query(
    `SELECT preview_key FROM ${qualified(tx.schema, 'tf_action_review')} WHERE id=1`,
  );
  const confirmation = createHmac('sha256', z.uuid().parse(rows[0]?.preview_key))
    .update(JSON.stringify([tx.workspaceId, membershipId, revision, rule, compiled]))
    .digest('hex');
  return { revision, ...compiled, confirmation };
}

export function createActionReviewService(store: WorkspaceStore) {
  async function run<T>(
    workspaceId: string,
    userId: string,
    access: 'read' | 'interpret' | 'save',
    work: (tx: Transaction, membershipId: string, admin: boolean) => Promise<T>,
  ) {
    try {
      return await store.runtime.transaction(
        z.uuid().parse(workspaceId),
        { minimum: 113, maximum: commonCompatibility.maximum },
        async tx => {
          const actor = await lockAndResolveHuman(tx, z.uuid().parse(userId), access === 'save' ? 'write' : 'read');
          const admin = (await currentMember(tx, actor)).role === 'admin';
          if (!admin && access !== 'read') throw new ActionReviewError('action-review-admin-required');
          return work(tx, actor.membershipId, admin);
        },
      );
    } catch (error) {
      if (error instanceof AccessDenied || (error instanceof StorageUnavailableError && error.code === 'disabled'))
        throw new WorkspaceSettingsError('workspace-settings-not-found', { cause: error });
      throw error;
    }
  }
  return {
    snapshot: (workspaceId: string, userId: string) =>
      run(workspaceId, userId, 'read', async (tx, _, canManage) => ({ ...(await readReviewPolicy(tx)), canManage })),
    preview: (workspaceId: string, userId: string, input: unknown) =>
      run(workspaceId, userId, 'interpret', async (tx, member) =>
        preview(tx, member, (await readReviewPolicy(tx)).revision, previewReviewSchema.parse(input).rule),
      ),
    save: (workspaceId: string, userId: string, input: unknown) =>
      run(workspaceId, userId, 'save', async (tx, member) => {
        const command = saveReviewSchema.parse(input);
        const { revision } = await readReviewPolicy(tx);
        if (revision !== command.expectedRevision)
          throw new WorkspaceSettingsError('workspace-settings-revision-conflict');
        const compiled = command.mode === 'ask' ? await preview(tx, member, revision, command.rule) : null;
        if (command.mode === 'ask' && command.confirmation !== compiled?.confirmation)
          throw new WorkspaceSettingsError('workspace-settings-confirmation-mismatch');
        const result = await tx.client.query(
          `SELECT ${qualified(tx.schema, 'tf_set_action_review')}($1,$2,$3,$4,$5,$6,$7) AS saved`,
          [
            userId,
            member,
            revision,
            command.mode,
            command.mode === 'ask' ? command.rule : null,
            compiled?.actions ?? [],
            compiled?.interpretation ?? null,
          ],
        );
        if (result.rows[0]?.saved !== true) throw new WorkspaceSettingsError('workspace-settings-revision-conflict');
        await tx.client.query(
          `INSERT INTO ${qualified(tx.schema, 'tf_audit_events')}(id,actor_id,operation,subject_id) VALUES($1,$2,'workspace.action-review',$3)`,
          [randomUUID(), member, workspaceId],
        );
        return { ...(await readReviewPolicy(tx)), canManage: true };
      }),
  };
}
