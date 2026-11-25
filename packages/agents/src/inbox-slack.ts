import { z } from 'zod';
import { AccessDenied, requireTablePermission, type HumanActor } from '@tulipfarm/access';
import { openBotDirectMessage, postBotMessage, type slackCredentialCipher } from '@tulipfarm/slack';
import { formatTaskKey, taskNumberOf } from '@tulipfarm/tables/task-keys';
import { rowTitle } from './row-assignments.ts';
import { tasksTableId, tasksUpgradeEnabled } from './task-reminders.ts';
import { agentCompatibility, relation, type AgentStorage } from './store.ts';

const kindText: Record<string, string> = {
  assigned: 'Assigned to you',
  waiting: 'Waiting for you',
  finished: 'Agent finished',
  mention: 'You were mentioned',
  reminder: 'Reminder',
};

const claimedSchema = z.object({
  id: z.uuid(),
  kind: z.string(),
  table_id: z.uuid(),
  row_id: z.uuid(),
  summary: z.string().nullable(),
  membership_id: z.uuid(),
  user_id: z.string(),
  slack_user_id: z.string(),
});

const plain = (value: string) =>
  value
    .replace(/[[\]<>*_`~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Sends each new Inbox item to its member as a Slack direct message, once. Items older than an hour, items for
 * members without a Slack identity, and kinds the member turned off are marked without a message.
 */
export function createInboxSlackNotifier(options: {
  runtime: AgentStorage;
  appId: string;
  cipher: ReturnType<typeof slackCredentialCipher>;
  rowLink: (workspaceId: string, tableId: string, rowId: string) => Promise<string | undefined>;
  /** The web address of a task's page, such as /acme/tasks/TUL-007. */
  taskLink?: (workspaceId: string, key: string) => Promise<string | undefined>;
  fetcher?: typeof fetch;
}) {
  const { runtime } = options;

  async function claim(workspaceId: string, taskKeys: boolean) {
    return runtime.transaction(workspaceId, agentCompatibility, async tx => {
      if (
        !(await tx.client.query('SELECT to_regclass($1) IS NOT NULL AS ok', [relation(tx, 'tf_inbox_slack_muted')]))
          .rows[0]?.ok
      )
        return null;
      const installed = z
        .object({ id: z.uuid(), generation: z.number(), bot_credential: z.unknown() })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT id,generation,bot_credential FROM ${relation(tx, 'tf_slack_installations')} WHERE app_id=$1 AND state='active'`,
              [options.appId],
            )
          ).rows[0],
        );
      // Without Slack, or for items nobody was told about within the hour, there is nothing left to send.
      await tx.client.query(
        `UPDATE ${relation(tx, 'tf_inbox_items')} SET notified_at=clock_timestamp()
        WHERE notified_at IS NULL AND (done_at IS NOT NULL OR resolved_at IS NOT NULL OR created_at<clock_timestamp()-interval '1 hour' OR $1)`,
        [!installed],
      );
      if (!installed) return null;
      const items = z.array(claimedSchema).parse(
        (
          await tx.client.query(
            `WITH due AS (
              SELECT i.id FROM ${relation(tx, 'tf_inbox_items')} i
              WHERE i.notified_at IS NULL AND i.done_at IS NULL AND i.resolved_at IS NULL
              ORDER BY i.created_at LIMIT 20 FOR UPDATE SKIP LOCKED
            ), marked AS (
              UPDATE ${relation(tx, 'tf_inbox_items')} i SET notified_at=clock_timestamp() FROM due WHERE i.id=due.id
              RETURNING i.*
            )
            SELECT m.id,m.kind,m.table_id,m.row_id,m.summary,m.membership_id,ms.user_id,s.slack_user_id
            FROM marked m
            JOIN ${relation(tx, 'tf_memberships')} ms ON ms.id=m.membership_id AND ms.removed_at IS NULL
            JOIN ${relation(tx, 'tf_slack_identities')} s ON s.membership_id=m.membership_id AND s.installation_id=$1
              AND s.generation=$2 AND s.state<>'revoked'
            WHERE NOT EXISTS (SELECT 1 FROM ${relation(tx, 'tf_inbox_slack_muted')} x WHERE x.membership_id=m.membership_id AND x.kind=m.kind)
            ORDER BY m.created_at`,
            [installed.id, installed.generation],
          )
        ).rows,
      );
      const messages = [];
      const tasksId = taskKeys ? await tasksTableId(tx) : null;
      for (const item of items) {
        const actor: HumanActor = { kind: 'human', userId: item.user_id, membershipId: item.membership_id };
        // Behavior 60: a message names only a row the member can still read.
        const readable = await requireTablePermission(tx, actor, item.table_id, 'table.row.read').then(
          () => true,
          error => {
            if (error instanceof AccessDenied) return false;
            throw error;
          },
        );
        const row = readable ? await rowTitle(tx, item.table_id, item.row_id) : null;
        const number = row && item.table_id === tasksId ? await taskNumberOf(tx, item.table_id, item.row_id) : null;
        if (row) messages.push({ item, row, key: number === null ? null : formatTaskKey(number) });
      }
      return { installed, messages };
    });
  }

  async function retry(workspaceId: string, itemId: string) {
    await runtime.transaction(workspaceId, agentCompatibility, tx =>
      tx.client.query(`UPDATE ${relation(tx, 'tf_inbox_items')} SET notified_at=NULL WHERE id=$1`, [itemId]),
    );
  }

  /** Sends what is due in one workspace and returns how many messages went out. */
  async function notify(workspaceId: string) {
    const claimed = await claim(workspaceId, Boolean(options.taskLink) && (await tasksUpgradeEnabled(workspaceId)));
    if (!claimed?.messages.length) return 0;
    // A credential that no longer decrypts drops this batch, which was already marked, instead of retrying forever.
    const token = options.cipher.decrypt(
      { workspaceId, installationId: claimed.installed.id, generation: claimed.installed.generation, kind: 'bot' },
      claimed.installed.bot_credential,
    );
    let sent = 0;
    for (const { item, row, key } of claimed.messages) {
      try {
        const link =
          key && options.taskLink
            ? await options.taskLink(workspaceId, key)
            : await options.rowLink(workspaceId, item.table_id, item.row_id);
        const name = plain(key ? `${key} ${row.title ?? 'Untitled task'}` : (row.title ?? 'Untitled row'));
        const text = [
          `*${kindText[item.kind] ?? 'Inbox'}*: ${plain(item.summary ?? '')}`.replace(/: $/, ''),
          `${link ? `[${name}](${link})` : name} in ${plain(row.table)}`,
        ].join('\n');
        const channel = await openBotDirectMessage(token, item.slack_user_id, options.fetcher);
        const outcome = await postBotMessage({
          token,
          channel,
          text,
          ...(options.fetcher ? { fetcher: options.fetcher } : {}),
        });
        if (outcome.kind === 'sent') sent += 1;
        else if (outcome.kind === 'retry') await retry(workspaceId, item.id);
      } catch {
        // One member's closed DMs or an unrenderable title must not hold back the others.
      }
    }
    return sent;
  }

  return { notify };
}
