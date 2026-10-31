import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { classifyEvent, eventEnvelopeSchema, type SlackEvent, type SlackReactionEvent } from './contracts.ts';
import { slackCompatibility, type SlackRuntime, type createSlackInstallations } from './installations.ts';
import { lockAuthorization, type AuthorizationTransaction } from '@tulipfarm/access';
import { watchIntegrationRecommendations } from '@tulipfarm/integrations/authorization';
import { slackRecommendations } from './recommendations.ts';

type Route = NonNullable<Awaited<ReturnType<ReturnType<typeof createSlackInstallations>['route']>>>;
export function createSlackInbox(
  runtime: SlackRuntime,
  freeze?: (
    tx: AuthorizationTransaction,
    eventId: string,
    payload: unknown,
    installationId: string,
    generation: number,
    workspaceId: string,
  ) => Promise<unknown>,
  /** Turns a reaction into a held request payload when the channel has a rule for it, otherwise null. */
  react?: (
    tx: AuthorizationTransaction,
    event: SlackReactionEvent,
    installationId: string,
    generation: number,
    workspaceId: string,
  ) => Promise<Record<string, unknown> | null>,
) {
  async function accept(route: Route, input: SlackEvent) {
    const envelope = eventEnvelopeSchema.parse(input);
    if (envelope.type !== 'event_callback') throw new Error('slack-event-invalid');
    const classified = classifyEvent(envelope);
    return runtime.transaction(route.workspaceId, slackCompatibility, async tx => {
      await lockAuthorization(tx);
      const table = (name: string) => qualified(tx.schema, name);
      const installation = z
        .object({
          bot_user_id: z.string(),
          state: z.string(),
          generation: z.number().int(),
          accepts_events_after: z.coerce.number().int(),
        })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT bot_user_id,state,generation,accepts_events_after FROM ${table('tf_slack_installations')} WHERE id=$1 AND app_id=$2 AND team_id=$3 FOR UPDATE`,
              [route.installationId, envelope.api_app_id, envelope.team_id],
            )
          ).rows[0],
        );
      if (!installation) throw new Error('slack-installation-unavailable');
      if (
        (await tx.client.query(`SELECT id FROM ${table('tf_slack_events')} WHERE event_id=$1`, [envelope.event_id]))
          .rowCount
      )
        return { accepted: true, duplicate: true, execution: 'disabled' };
      if (
        installation.generation !== route.generation ||
        !['active', 'scope-missing'].includes(installation.state) ||
        envelope.event_time < installation.accepts_events_after
      )
        throw new Error('slack-installation-unavailable');
      const isMessage = classified.kind === 'message' && classified.event.user !== installation.bot_user_id;
      const reaction =
        classified.kind === 'reaction' && react && classified.event.user !== installation.bot_user_id
          ? await react(tx, classified.event, route.installationId, route.generation, route.workspaceId)
          : null;
      const semantic = isMessage
        ? `message:${classified.event.channel}:${classified.event.ts}`
        : reaction && classified.kind === 'reaction'
          ? `reaction:${classified.event.item.channel}:${classified.event.item.ts}:${classified.event.reaction}:${classified.event.user}`
          : `event:${envelope.event_id}`;
      const disposition =
        isMessage || reaction
          ? 'held'
          : ['uninstall', 'revocation'].includes(classified.kind)
            ? 'lifecycle'
            : 'ignored';
      const receipt = await tx.client.query(
        `INSERT INTO ${table('tf_slack_events')} (id,installation_id,generation,event_id,semantic_key,event_time,payload,disposition)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id`,
        [
          randomUUID(),
          route.installationId,
          route.generation,
          envelope.event_id,
          semantic,
          envelope.event_time,
          reaction ??
            (classified.kind === 'message' || classified.kind === 'revocation' || classified.kind === 'message-change'
              ? classified.event
              : { type: envelope.event.type }),
          disposition,
        ],
      );
      if (!receipt.rowCount) return { accepted: true, duplicate: true, execution: 'disabled' };
      const recommendations =
        classified.kind === 'revocation' || classified.kind === 'uninstall'
          ? await watchIntegrationRecommendations(tx, route.installationId, () =>
              slackRecommendations(tx, route.installationId),
            )
          : null;
      if (classified.kind === 'message-change') {
        const change = classified.event;
        const deleted = change.subtype === 'message_deleted';
        const ts = deleted ? change.deleted_ts : change.message.ts;
        const message = deleted ? null : { type: 'message', channel: change.channel, ...change.message };
        await tx.client.query(
          `INSERT INTO ${table('tf_slack_message_changes')} (installation_id,generation,channel,message_ts,changed_at,message) VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (installation_id,generation,channel,message_ts) DO UPDATE SET changed_at=EXCLUDED.changed_at,message=EXCLUDED.message
          WHERE tf_slack_message_changes.message IS NOT NULL AND (EXCLUDED.message IS NULL OR EXCLUDED.changed_at>tf_slack_message_changes.changed_at)`,
          [
            route.installationId,
            route.generation,
            change.channel,
            ts,
            deleted ? change.event_ts : (change.message.edited?.ts ?? change.event_ts),
            message,
          ],
        );
      }
      if ((isMessage || reaction) && freeze)
        await freeze(
          tx,
          z.uuid().parse(receipt.rows[0]?.id),
          reaction ?? (classified.kind === 'message' ? classified.event : null),
          route.installationId,
          route.generation,
          route.workspaceId,
        );
      if (classified.kind === 'revocation') {
        for (const user of new Set(classified.event.tokens.oauth)) {
          await tx.client.query(
            `INSERT INTO ${table('tf_slack_user_revocations')} (installation_id,generation,slack_user_id,event_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
            [route.installationId, route.generation, user, envelope.event_id],
          );
          await tx.client.query(
            `UPDATE ${table('tf_slack_identities')} SET state='revoked',credential=NULL WHERE installation_id=$1 AND generation=$2 AND slack_user_id=$3`,
            [route.installationId, route.generation, user],
          );
          await tx.client.query(
            `UPDATE ${table('tf_slack_continuations')} SET state='cancelled' WHERE identity_id IN (SELECT id FROM ${table('tf_slack_identities')} WHERE installation_id=$1 AND generation=$2 AND slack_user_id=$3)`,
            [route.installationId, route.generation, user],
          );
        }
      }
      if (
        classified.kind === 'uninstall' ||
        (classified.kind === 'revocation' && classified.event.tokens.bot.includes(installation.bot_user_id))
      ) {
        await tx.client.query(
          `UPDATE ${table('tf_slack_installations')} SET state='revoked',generation=generation+1,bot_credential=NULL WHERE id=$1 AND generation=$2`,
          [route.installationId, route.generation],
        );
        await tx.client.query(
          `UPDATE ${table('tf_slack_identities')} SET state='revoked',credential=NULL WHERE installation_id=$1`,
          [route.installationId],
        );
        await tx.client.query(
          `UPDATE ${table('tf_slack_continuations')} SET state='cancelled' WHERE identity_id IN (SELECT id FROM ${table('tf_slack_identities')} WHERE installation_id=$1)`,
          [route.installationId],
        );
      }
      await recommendations?.();
      return { accepted: true, duplicate: false, execution: 'disabled' };
    });
  }
  return { accept };
}
