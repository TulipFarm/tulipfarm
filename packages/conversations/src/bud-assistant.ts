import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  denyMcpEgress,
  lockAuthorization,
  resolveHuman,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { commonCompatibility, qualified } from '@tulipfarm/workspace-storage/runtime';
import { notifyConversationChange } from './event-publisher.ts';
import { recordConversationActivity } from './activity.ts';
import { readPersonalMemory, replacePersonalMemory } from './personal-memory.ts';
import {
  budCommandSchema,
  budGreeting,
  budNudgeSchema,
  budPreferenceAskSchema,
  budPreferenceProposeSchema,
  budPreferenceSchema,
  budStateSchema,
  type BudState,
} from './bud-contracts.ts';
import type { ConversationRuntime } from './runtime.ts';
import { chatAccess } from './chat-access.ts';
import { createConversations } from './index.ts';
import { recordRecommendationChange, recommendationEventChannel } from '@tulipfarm/workspace-storage/recommendations';

export const budCompatibility = { minimum: 1, maximum: commonCompatibility.maximum };
export class BudConflict extends Error {}
const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, name);
const stateRow = z.object({
  conversation_id: z.uuid().nullable(),
  onboarding: budStateSchema.shape.onboarding,
  bubbles_enabled: z.boolean(),
  snoozed_until: z.date().nullable(),
  last_presented_at: z.date().nullable(),
  active_nudge: z.string().nullable(),
});
const preferenceColumns = `id,conversation_id AS "conversationId",topic,question,value,status,
  expected_revision AS "expectedRevision",saved_revision AS "savedRevision"`;
const snapshotSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        action: budNudgeSchema.shape.action,
        facts: z.string().optional(),
      }),
    )
    .max(5),
});
const fillers = new Set(['follow-ups', 'support', 'week', 'standup', 'process']);
const topics = { 'reply-style': 'Reply style', role: 'Work role', goals: 'Work goals' };

export const budCooldownMs = 30 * 60_000;
export function budCooldownElapsed(lastPresentedAt: Date | null, now: number) {
  return lastPresentedAt === null || now - lastPresentedAt.getTime() >= budCooldownMs;
}
export function preferenceText(previous: string, topic: keyof typeof topics, value: string) {
  return `${previous.trimEnd()}${previous.trim() ? '\n\n' : ''}${topics[topic]}: ${value}`;
}

async function notifyBudChange(tx: AuthorizationTransaction, workspaceId: string, membershipId: string) {
  await tx.client.query(
    `SELECT pg_notify($1,json_build_object('workspaceId',$2::uuid,'membershipId',$3::uuid,
    'version',COALESCE((SELECT generation FROM ${table(tx, 'tf_recommendation_refresh')} WHERE membership_id=$3),0),'kind','changed')::text)`,
    [recommendationEventChannel, workspaceId, membershipId],
  );
}

export async function clearBudConversation(
  tx: AuthorizationTransaction & { commonVersion: number },
  chatId: string,
  workspaceId: string,
) {
  if (tx.commonVersion < budCompatibility.minimum) return;
  const states = await tx.client.query(
    `UPDATE ${table(tx, 'tf_bud_state')} SET conversation_id=NULL,active_nudge=NULL,
    onboarding=CASE WHEN onboarding='active' THEN 'skipped' ELSE onboarding END WHERE conversation_id=$1 RETURNING membership_id`,
    [chatId],
  );
  const preferences = await tx.client.query(
    `DELETE FROM ${table(tx, 'tf_bud_preferences')} WHERE conversation_id=$1 RETURNING membership_id`,
    [chatId],
  );
  for (const membershipId of new Set(
    [...states.rows, ...preferences.rows].map(row => z.uuid().parse(row.membership_id)),
  ))
    await notifyBudChange(tx, workspaceId, membershipId);
}

export async function budPrivateChat(tx: AuthorizationTransaction, actor: HumanActor, chatId: string) {
  denyMcpEgress();
  await currentMember(tx, actor);
  await chatAccess(tx, actor, chatId, 'read', true);
  const own = await tx.client.query(
    `SELECT 1 FROM ${table(tx, 'tf_conversations')} c
    WHERE c.id=$1 AND c.owner_membership_id=$2 AND c.project_id IS NULL AND c.deleted_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM ${table(tx, 'tf_slack_default_turns')} s WHERE s.conversation_id=c.id)`,
    [chatId, actor.membershipId],
  );
  if (!own.rowCount) throw new AccessDenied();
}

export function createBudAssistant(runtime: ConversationRuntime) {
  const conversations = createConversations(runtime);
  async function human<T>(
    workspaceId: string,
    userId: string,
    write: boolean,
    operation: (tx: AuthorizationTransaction & { commonVersion: number }, actor: HumanActor) => Promise<T>,
  ) {
    denyMcpEgress();
    return runtime.transaction(z.uuid().parse(workspaceId), budCompatibility, async tx => {
      await lockAuthorization(tx, write ? 'write' : 'read');
      const actor = await resolveHuman(tx, userId);
      return operation(tx, actor);
    });
  }
  async function state(tx: AuthorizationTransaction, actor: HumanActor) {
    const row = stateRow
      .optional()
      .parse(
        (
          await tx.client.query(`SELECT * FROM ${table(tx, 'tf_bud_state')} WHERE membership_id=$1`, [
            actor.membershipId,
          ])
        ).rows[0],
      );
    if (!row) throw new BudConflict('bud-not-initialized');
    return row;
  }
  async function append(tx: AuthorizationTransaction, actor: HumanActor, chatId: string, text: string) {
    await budPrivateChat(tx, actor, chatId);
    const chat = (
      await tx.client.query(
        `SELECT next_message_sequence FROM ${table(tx, 'tf_conversations')} WHERE id=$1 FOR UPDATE`,
        [chatId],
      )
    ).rows[0];
    const id = randomUUID();
    await tx.client.query(
      `INSERT INTO ${table(tx, 'tf_conversation_messages')}(id,conversation_id,sequence,author_kind)
      VALUES($1,$2,$3,'assistant')`,
      [id, chatId, chat.next_message_sequence],
    );
    await tx.client.query(
      `INSERT INTO ${table(tx, 'tf_conversation_parts')}(conversation_id,message_id,ordinal,kind,text)
      VALUES($1,$2,0,'text',$3)`,
      [chatId, id, text],
    );
    await tx.client.query(
      `UPDATE ${table(tx, 'tf_conversations')} SET next_message_sequence=next_message_sequence+1 WHERE id=$1`,
      [chatId],
    );
    await recordConversationActivity(tx, chatId);
    return id;
  }
  async function ensureThread(tx: AuthorizationTransaction, actor: HumanActor, welcome: boolean) {
    const prior = await state(tx, actor);
    if (prior.conversation_id) {
      await budPrivateChat(tx, actor, prior.conversation_id);
      return prior.conversation_id;
    }
    const id = randomUUID();
    await tx.client.query(
      `INSERT INTO ${table(tx, 'tf_conversations')}(id,owner_user_id,owner_membership_id,title,title_manual)
      VALUES($1,$2,$3,'Bud',true)`,
      [id, actor.userId, actor.membershipId],
    );
    await tx.client.query(`UPDATE ${table(tx, 'tf_bud_state')} SET conversation_id=$2 WHERE membership_id=$1`, [
      actor.membershipId,
      id,
    ]);
    if (welcome) await append(tx, actor, id, budGreeting);
    return id;
  }
  async function candidate(tx: AuthorizationTransaction, actor: HumanActor, row: z.infer<typeof stateRow>) {
    if (!row.bubbles_enabled || row.onboarding === 'active' || (row.snoozed_until && row.snoozed_until > new Date()))
      return null;
    const pending = z
      .object({ id: z.uuid(), question: z.string() })
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT id,question FROM ${table(tx, 'tf_bud_preferences')} WHERE membership_id=$1 AND status IN ('asking','proposed')`,
            [actor.membershipId],
          )
        ).rows[0],
      );
    const saved = snapshotSchema.optional().parse(
      (
        await tx.client.query(
          `SELECT s.items FROM ${table(tx, 'tf_recommendation_snapshots')} s
      JOIN ${table(tx, 'tf_recommendation_refresh')} r USING(membership_id)
      WHERE s.membership_id=$1 AND r.status='ready' AND s.generation=r.generation AND s.policy='event-driven-v1'`,
          [actor.membershipId],
        )
      ).rows[0],
    );
    const items = pending
      ? [
          {
            id: `preference-${pending.id}`,
            label: pending.question,
            action: { kind: 'prompt' as const, prompt: pending.question },
          },
        ]
      : saved?.items;
    if (!items) return null;
    const fingerprintOf = (item: z.infer<typeof snapshotSchema>['items'][number]) =>
      createHash('sha256')
        .update(JSON.stringify({ label: item.label, action: item.action, facts: item.facts }))
        .digest('hex');
    const seen = z
      .array(z.object({ fingerprint: z.string(), status: z.string() }))
      .parse(
        (
          await tx.client.query(
            `SELECT fingerprint,status FROM ${table(tx, 'tf_bud_nudges')} WHERE membership_id=$1 AND fingerprint=ANY($2::text[])`,
            [actor.membershipId, items.map(fingerprintOf)],
          )
        ).rows,
      );
    const active = items.some(item => fingerprintOf(item) === row.active_nudge) ? row.active_nudge : null;
    for (const item of items) {
      if (fillers.has(item.id)) continue;
      const fingerprint = fingerprintOf(item);
      const prior = seen.find(entry => entry.fingerprint === fingerprint);
      if (prior && (prior.status !== 'presented' || row.active_nudge !== fingerprint)) continue;
      if (
        active &&
        active !== fingerprint &&
        seen.some(entry => entry.fingerprint === active && ['presented', 'opened'].includes(entry.status))
      )
        continue;
      if (!prior && !budCooldownElapsed(row.last_presented_at, Date.now())) continue;
      return {
        fingerprint,
        suggestionId: item.id,
        question: pending?.question ?? `Would you like to ${item.label[0]!.toLowerCase()}${item.label.slice(1)}?`,
        action: item.action,
        presented: !!prior,
      };
    }
    return null;
  }
  async function view(tx: AuthorizationTransaction, actor: HumanActor): Promise<BudState> {
    const row = await state(tx, actor);
    const preferences = z.array(budPreferenceSchema).parse(
      (
        await tx.client.query(
          `SELECT ${preferenceColumns}
      FROM ${table(tx, 'tf_bud_preferences')} WHERE membership_id=$1 AND status IN ('asking','proposed','saved')
      ORDER BY created_at DESC,id LIMIT 20`,
          [actor.membershipId],
        )
      ).rows,
    );
    return budStateSchema.parse({
      conversationId: row.conversation_id,
      onboarding: row.onboarding,
      bubblesEnabled: row.bubbles_enabled,
      snoozedUntil: row.snoozed_until?.toISOString() ?? null,
      nudge: await candidate(tx, actor, row),
      preferences,
    });
  }
  async function completeSetup(tx: AuthorizationTransaction, actor: HumanActor) {
    const result = await tx.client.query(
      `UPDATE ${table(tx, 'tf_bud_state')} b SET onboarding='completed'
      WHERE b.membership_id=$1 AND b.onboarding='active' AND (
        EXISTS(SELECT 1 FROM ${table(tx, 'tf_bud_preferences')} p WHERE p.membership_id=$1 AND p.conversation_id=b.conversation_id AND p.status='saved')
        OR EXISTS(SELECT 1 FROM ${table(tx, 'tf_conversation_tool_calls')} c JOIN ${table(tx, 'tf_conversation_execution_steps')} e ON e.call_id=c.id
          JOIN ${table(tx, 'tf_files')} f ON f.id::text=e.output->'result'->'file'->>'id'
          WHERE c.conversation_id=b.conversation_id AND c.tool='files.create' AND c.status='completed'
            AND f.creator_membership_id=$1 AND f.ready AND f.trashed_at IS NULL AND f.deleting_at IS NULL)
        OR EXISTS(SELECT 1 FROM ${table(tx, 'tf_conversation_tool_calls')} c JOIN ${table(tx, 'tf_conversation_execution_steps')} e ON e.call_id=c.id
          WHERE c.conversation_id=b.conversation_id AND c.status='completed' AND e.output IS NOT NULL AND e.output->'result'->>'error' IS NULL AND (
            EXISTS(SELECT 1 FROM jsonb_array_elements(e.output->'sources') s JOIN ${table(tx, 'tf_google_integrations')} g ON g.id::text=s->>'integrationId'
              WHERE s->>'kind'='google-integration' AND g.membership_id=$1 AND g.status='connected' AND g.generation::text=s->>'generation'
                AND NOT b.initial_integrations ? ('google:'||g.id||':'||g.generation))
            OR EXISTS(SELECT 1 FROM jsonb_array_elements(e.output->'sources') s JOIN ${table(tx, 'tf_github_accounts')} g ON g.id::text=s->>'accountId'
              WHERE s->>'kind'='github-personal' AND g.owner_membership_id=$1 AND g.state='active' AND g.generation::text=s->>'generation'
                AND NOT b.initial_integrations ? ('github:'||g.id||':'||g.generation))
            OR (c.tool LIKE 'slack.%' AND EXISTS(SELECT 1 FROM ${table(tx, 'tf_slack_identities')} s
              JOIN ${table(tx, 'tf_slack_installations')} i ON i.id=s.installation_id AND i.generation=s.generation
              WHERE s.membership_id=$1 AND s.state='authorized' AND i.state='active'
                AND NOT b.initial_integrations ? ('slack:'||s.id||':'||s.generation)))))
        OR EXISTS(SELECT 1 FROM ${table(tx, 'tf_table_proposals')} p WHERE p.conversation_id=b.conversation_id AND p.membership_id=$1
          AND jsonb_array_length(p.manifest->'plans')>0 AND
          (SELECT count(*) FROM ${table(tx, 'tf_table_proposal_receipts')} r WHERE r.proposal_id=p.id AND r.receipt->>'status'='completed')>=jsonb_array_length(p.manifest->'plans'))
        OR EXISTS(SELECT 1 FROM ${table(tx, 'tf_chat_authoring_drafts')} d JOIN ${table(tx, 'tf_chat_authoring_decisions')} c ON c.draft_id=d.id
          WHERE d.conversation_id=b.conversation_id AND d.membership_id=$1 AND
          (c.outcome->>'kind' IN ('skill','workflow','row') OR (c.outcome->>'kind'='agent' AND c.outcome->'receipt'->>'status'='accepted'))))`,
      [actor.membershipId],
    );
    return !!result.rowCount;
  }
  async function preference(
    tx: AuthorizationTransaction,
    actor: HumanActor,
    input: Extract<z.infer<typeof budCommandSchema>, { id: string }>,
  ) {
    const row = budPreferenceSchema
      .extend({ previous_content: z.string().nullable() })
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT ${preferenceColumns},previous_content FROM ${table(tx, 'tf_bud_preferences')} WHERE id=$1 AND membership_id=$2 FOR UPDATE`,
            [input.id, actor.membershipId],
          )
        ).rows[0],
      );
    if (!row) throw new AccessDenied();
    await budPrivateChat(tx, actor, row.conversationId);
    if (input.kind === 'dismiss-preference') {
      await tx.client.query(
        `UPDATE ${table(tx, 'tf_bud_preferences')} SET status='dismissed',previous_content=NULL
        WHERE id=$1 AND status IN ('asking','proposed')`,
        [row.id],
      );
      return;
    }
    if (input.kind === 'undo-preference') {
      if (row.status === 'undone') return;
      if (row.status !== 'saved' || row.savedRevision === null || row.previous_content === null)
        throw new BudConflict('preference-changed');
      await replacePersonalMemory(tx, actor, row.previous_content, row.savedRevision);
      await tx.client.query(
        `UPDATE ${table(tx, 'tf_bud_preferences')} SET status='undone',previous_content=NULL WHERE id=$1`,
        [row.id],
      );
      return;
    }
    if (row.status === 'saved') {
      if ('value' in input && input.value !== row.value) throw new BudConflict('preference-changed');
      return;
    }
    if (
      (input.kind === 'answer-preference' && row.status !== 'asking') ||
      (input.kind === 'accept-preference' && row.status !== 'proposed')
    )
      throw new BudConflict('preference-changed');
    const value = input.kind === 'answer-preference' ? input.value : row.value;
    if (!value) throw new BudConflict('preference-value-required');
    const memory = await readPersonalMemory(tx, actor);
    const next = await replacePersonalMemory(
      tx,
      actor,
      preferenceText(memory.content, row.topic, value),
      row.expectedRevision,
    );
    await tx.client.query(
      `UPDATE ${table(tx, 'tf_bud_preferences')} SET status='saved',value=$2,previous_content=$3,saved_revision=$4 WHERE id=$1`,
      [row.id, value, memory.content, next.revision],
    );
  }
  return {
    read: (workspaceId: string, userId: string) => human(workspaceId, userId, false, view),
    async command(workspaceId: string, userId: string, value: unknown) {
      const input = budCommandSchema.parse(value);
      return human(workspaceId, userId, true, async (tx, actor) => {
        if (input.kind === 'bootstrap') {
          await tx.client.query(
            `INSERT INTO ${table(tx, 'tf_bud_state')}(membership_id,onboarding,initial_integrations)
            SELECT $1,CASE WHEN EXISTS(SELECT 1 FROM ${table(tx, 'tf_conversations')} WHERE owner_membership_id=$1)
              OR EXISTS(SELECT 1 FROM ${table(tx, 'tf_conversation_messages')} WHERE membership_id=$1)
              THEN 'ineligible' ELSE 'active' END,
              (SELECT COALESCE(jsonb_agg(integration),'[]'::jsonb) FROM (
                SELECT 'google:'||id||':'||generation AS integration FROM ${table(tx, 'tf_google_integrations')} WHERE membership_id=$1 AND status='connected'
                UNION ALL SELECT 'github:'||id||':'||generation FROM ${table(tx, 'tf_github_accounts')} WHERE owner_membership_id=$1 AND state='active'
                UNION ALL SELECT 'slack:'||id||':'||generation FROM ${table(tx, 'tf_slack_identities')} WHERE membership_id=$1 AND state='authorized'
              ) integrations)
            ON CONFLICT(membership_id) DO NOTHING`,
            [actor.membershipId],
          );
        } else {
          const row = await state(tx, actor);
          if (input.kind === 'open') await ensureThread(tx, actor, row.onboarding === 'active');
          else if (input.kind === 'skip')
            await tx.client.query(
              `UPDATE ${table(tx, 'tf_bud_state')} SET onboarding='skipped' WHERE membership_id=$1 AND onboarding='active'`,
              [actor.membershipId],
            );
          else if (input.kind === 'settings') {
            if (
              input.snoozedUntil &&
              (Date.parse(input.snoozedUntil) < Date.now() ||
                Date.parse(input.snoozedUntil) > Date.now() + 49 * 60 * 60_000)
            )
              throw new BudConflict('invalid-snooze');
            await tx.client.query(
              `UPDATE ${table(tx, 'tf_bud_state')} SET bubbles_enabled=COALESCE($2,bubbles_enabled),
              snoozed_until=CASE WHEN $3 THEN $4::timestamptz ELSE snoozed_until END WHERE membership_id=$1`,
              [actor.membershipId, input.enabled ?? null, 'snoozedUntil' in input, input.snoozedUntil ?? null],
            );
          } else if ('id' in input) await preference(tx, actor, input);
          else if (input.kind !== 'sync') {
            const row = await state(tx, actor);
            const prior = (
              await tx.client.query(
                `SELECT status FROM ${table(tx, 'tf_bud_nudges')} WHERE membership_id=$1 AND fingerprint=$2`,
                [actor.membershipId, input.fingerprint],
              )
            ).rows[0];
            if (
              (input.kind === 'open-nudge' && ['opened', 'answered'].includes(prior?.status)) ||
              (input.kind === 'dismiss' && prior?.status === 'dismissed')
            )
              return view(tx, actor);
            const current = await candidate(tx, actor, row);
            if (!current || current.fingerprint !== input.fingerprint) throw new BudConflict('suggestion-changed');
            if (input.kind === 'present') {
              await tx.client.query(
                `INSERT INTO ${table(tx, 'tf_bud_nudges')}(membership_id,fingerprint,suggestion_id,status)
                VALUES($1,$2,$3,'presented') ON CONFLICT DO NOTHING`,
                [actor.membershipId, input.fingerprint, current.suggestionId],
              );
              if (!current.presented)
                await tx.client.query(
                  `UPDATE ${table(tx, 'tf_bud_state')} SET active_nudge=$2,last_presented_at=clock_timestamp() WHERE membership_id=$1`,
                  [actor.membershipId, input.fingerprint],
                );
            } else if (input.kind === 'dismiss') {
              await tx.client.query(
                `UPDATE ${table(tx, 'tf_bud_nudges')} SET status='dismissed' WHERE membership_id=$1 AND fingerprint=$2`,
                [actor.membershipId, input.fingerprint],
              );
              await tx.client.query(
                `UPDATE ${table(tx, 'tf_bud_state')} SET active_nudge=NULL WHERE membership_id=$1`,
                [actor.membershipId],
              );
              if (current.suggestionId.startsWith('preference-'))
                await preference(tx, actor, {
                  kind: 'dismiss-preference',
                  id: current.suggestionId.slice('preference-'.length),
                });
            } else if (input.kind === 'open-nudge') {
              if (!current.presented) throw new BudConflict('suggestion-not-presented');
              const chatId = await ensureThread(tx, actor, false);
              const startsReply = current.action.kind === 'prompt' && !current.suggestionId.startsWith('preference-');
              const messageId = startsReply ? randomUUID() : await append(tx, actor, chatId, current.question);
              await tx.client.query(
                `UPDATE ${table(tx, 'tf_bud_nudges')} SET status='opened' WHERE membership_id=$1 AND fingerprint=$2 AND status='presented'`,
                [actor.membershipId, input.fingerprint],
              );
              if (startsReply && current.action.kind === 'prompt') {
                await conversations.sendInTransaction(tx, actor, workspaceId, chatId, {
                  commandId: randomUUID(),
                  messageId,
                  parts: [{ kind: 'text', text: current.action.prompt }],
                });
              }
              await tx.client.query(
                `UPDATE ${table(tx, 'tf_bud_nudges')} SET message_id=$3 WHERE membership_id=$1 AND fingerprint=$2`,
                [actor.membershipId, input.fingerprint, messageId],
              );
            }
          }
        }
        const completed = await completeSetup(tx, actor);
        const next = await view(tx, actor);
        if (input.kind !== 'sync' || completed) {
          await notifyBudChange(tx, workspaceId, actor.membershipId);
          if (next.conversationId)
            await notifyConversationChange(tx, { workspaceId, conversationId: next.conversationId });
        }
        return next;
      });
    },
    async propose(
      workspaceId: string,
      actor: HumanActor,
      callId: string,
      origin: { conversationId: string; turnId: string },
      value: unknown,
    ) {
      const input = z.union([budPreferenceAskSchema, budPreferenceProposeSchema]).parse(value);
      return human(workspaceId, actor.userId, true, async (tx, current) => {
        if (current.membershipId !== actor.membershipId) throw new AccessDenied();
        await budPrivateChat(tx, actor, origin.conversationId);
        const turn = await tx.client.query(
          `SELECT 1 FROM ${table(tx, 'tf_conversation_turns')}
          WHERE id=$1 AND conversation_id=$2 AND status='processing'`,
          [origin.turnId, origin.conversationId],
        );
        if (!turn.rowCount) throw new AccessDenied();
        const memory = await readPersonalMemory(tx, actor);
        const pending = (
          await tx.client.query(
            `SELECT id FROM ${table(tx, 'tf_bud_preferences')} WHERE membership_id=$1 AND status IN ('asking','proposed')`,
            [actor.membershipId],
          )
        ).rows[0];
        if (pending && pending.id !== callId) throw new BudConflict('preference-question-pending');
        await tx.client.query(
          `INSERT INTO ${table(tx, 'tf_bud_preferences')}(id,membership_id,conversation_id,turn_id,topic,question,value,status,expected_revision)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING`,
          [
            callId,
            actor.membershipId,
            origin.conversationId,
            origin.turnId,
            input.topic,
            input.question,
            'value' in input ? input.value : null,
            'value' in input ? 'proposed' : 'asking',
            memory.revision,
          ],
        );
        await recordRecommendationChange(tx, {
          id: callId,
          kind: 'memory',
          sourceId: actor.membershipId,
          membershipIds: [actor.membershipId],
        });
        return {
          id: callId,
          status: 'value' in input ? 'proposed' : 'asking',
          instruction:
            'The private preference card is ready. Ask only this question and stop. Nothing has been remembered yet. The human answers or confirms on the card; do not save or approve on their behalf.',
        };
      });
    },
  };
}
