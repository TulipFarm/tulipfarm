import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import { table, loadIntegration, type GoogleOperationRuntime } from './operation-store.ts';
import { digest } from './lifecycle-internals.ts';
import {
  heartbeatCommandSchema,
  heartbeatPageSchema,
  heartbeatResultsSchema,
  heartbeatRetrySchema,
  heartbeatViewSchema,
  heartbeatWorkSchema,
  HeartbeatError,
  type HeartbeatWork,
} from './heartbeat-contracts.ts';
import { createHeartbeatProvider, heartbeatMessageSchema } from './heartbeat-provider.ts';
import {
  heartbeatTransactions,
  heartbeatRowSchema,
  heartbeatScopes,
  heartbeatFence,
  heartbeatView,
  currentHeartbeat,
  loadHeartbeat,
  historyCheckpoint,
  type Checkpoint,
} from './heartbeat-store.ts';
import type { createGoogleWorkspaceService } from './service.ts';

type ProcessingGuard = (tx: Parameters<typeof loadHeartbeat>[0]) => Promise<void>;
export type HeartbeatProcessor = (input: {
  work: HeartbeatWork;
  itemId: string;
  epoch: number;
  instructions: string;
  message: z.infer<typeof heartbeatMessageSchema>;
  authorize: (guard?: ProcessingGuard) => Promise<void>;
  dispatch: (run: () => Promise<string>) => Promise<string>;
}) => Promise<string | { kind: 'blocked'; reason: 'model-configuration' | 'model-disabled' | 'credits-exhausted' }>;

export function createGmailHeartbeat(options: {
  runtime: GoogleOperationRuntime;
  integrations: Pick<ReturnType<typeof createGoogleWorkspaceService>, 'withCredential'>;
  providerFetch?: typeof fetch;
}) {
  const db = heartbeatTransactions(options.runtime);
  const provider = createHeartbeatProvider(options.integrations, options.providerFetch);
  const ownRow = async (tx: Parameters<typeof loadHeartbeat>[0], membershipId: string) =>
    heartbeatRowSchema
      .optional()
      .parse(
        (
          await tx.client.query(`SELECT * FROM ${table(tx, 'heartbeats')} WHERE membership_id=$1 FOR UPDATE`, [
            membershipId,
          ])
        ).rows[0],
      );
  return {
    async read(workspaceId: string, userId: string) {
      return db.owner(workspaceId, userId, async (tx, actor) => {
        const row = await ownRow(tx, actor.membershipId);
        if (!row) return heartbeatView();
        try {
          await currentHeartbeat(tx, row);
          return heartbeatView(row);
        } catch {
          return heartbeatView(row, false);
        }
      });
    },
    async configure(workspaceId: string, userId: string, input: z.input<typeof heartbeatCommandSchema>) {
      const command = heartbeatCommandSchema.parse(input);
      const { commandId, revision, ...settings } = command;
      const hash = digest(command);
      const prepare = await db.owner(workspaceId, userId, async (tx, actor) => {
        const saved = (
          await tx.client.query(
            `SELECT digest,result FROM ${table(tx, 'heartbeat_commands')} WHERE membership_id=$1 AND command_id=$2`,
            [actor.membershipId, commandId],
          )
        ).rows[0];
        if (saved) {
          if (saved.digest !== hash) throw new HeartbeatError('heartbeat-conflict');
          return { kind: 'replay' as const, result: heartbeatViewSchema.parse(saved.result) };
        }
        const row = await ownRow(tx, actor.membershipId);
        if ((row?.revision ?? 0) !== revision) throw new HeartbeatError('heartbeat-conflict');
        const integration =
          !settings.enabled && row
            ? { integrationId: row.integration_id, accountId: row.account_id, generation: row.generation }
            : await loadIntegration(tx, actor, heartbeatScopes);
        const reset =
          !row ||
          row.integration_id !== integration.integrationId ||
          row.account_id !== integration.accountId ||
          row.generation !== integration.generation;
        return {
          kind: 'prepare' as const,
          actor,
          row,
          integration,
          reset,
          baseline: settings.enabled && (reset || !row?.enabled),
        };
      });
      if (prepare.kind === 'replay') return prepare.result;
      const enabledAt = new Date();
      const baseline = prepare.baseline
        ? await provider.profile({
            workspaceId,
            actor: prepare.actor,
            ...prepare.integration,
            requiredScopes: heartbeatScopes,
          })
        : null;
      return db.owner(workspaceId, userId, async (tx, actor) => {
        if (actor.membershipId !== prepare.actor.membershipId) throw new AccessDenied();
        const replay = (
          await tx.client.query(
            `SELECT digest,result FROM ${table(tx, 'heartbeat_commands')} WHERE membership_id=$1 AND command_id=$2`,
            [actor.membershipId, commandId],
          )
        ).rows[0];
        if (replay) {
          if (replay.digest !== hash) throw new HeartbeatError('heartbeat-conflict');
          return heartbeatViewSchema.parse(replay.result);
        }
        const row = await ownRow(tx, actor.membershipId);
        if ((row?.revision ?? 0) !== revision) throw new HeartbeatError('heartbeat-conflict');
        if (settings.enabled) {
          const current = await loadIntegration(tx, actor, heartbeatScopes);
          if (
            current.integrationId !== prepare.integration.integrationId ||
            current.accountId !== prepare.integration.accountId ||
            current.generation !== prepare.integration.generation
          )
            throw new HeartbeatError('heartbeat-stale');
        }
        const id = row?.id ?? randomUUID();
        const cursor = baseline ?? row?.checkpoint.cursor ?? '0';
        const checkpoint: Checkpoint = { kind: 'idle', cursor };
        await tx.client.query(
          `INSERT INTO ${table(tx, 'heartbeats')} (id,membership_id,user_id,integration_id,account_id,generation,revision,settings,enabled,enabled_at,checkpoint)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (membership_id) DO UPDATE SET integration_id=$4,account_id=$5,generation=$6,revision=$7,settings=$8,enabled=$9,enabled_at=$10,checkpoint=$11,epoch=${table(tx, 'heartbeats')}.epoch+1,lease_until=NULL,due_at=clock_timestamp(),last_error=NULL`,
          [
            id,
            actor.membershipId,
            actor.userId,
            prepare.integration.integrationId,
            prepare.integration.accountId,
            prepare.integration.generation,
            revision + 1,
            settings,
            settings.enabled,
            prepare.reset || row?.checkpoint.cursor === '0' ? enabledAt : (row?.enabled_at ?? enabledAt),
            checkpoint,
          ],
        );
        await tx.client.query(`DELETE FROM ${table(tx, 'heartbeat_candidates')} WHERE heartbeat_id=$1`, [id]);
        await tx.client.query(
          `UPDATE ${table(tx, 'heartbeat_items')} SET status='cancelled',error='configuration-changed' WHERE heartbeat_id=$1 AND status IN ('queued','processing')`,
          [id],
        );
        const result = heartbeatView(await loadHeartbeat(tx, id));
        await tx.client.query(
          `INSERT INTO ${table(tx, 'heartbeat_commands')} (membership_id,command_id,digest,result) VALUES ($1,$2,$3,$4)`,
          [actor.membershipId, commandId, hash, result],
        );
        return result;
      });
    },
    async results(workspaceId: string, userId: string, input: z.input<typeof heartbeatPageSchema> = {}) {
      const page = heartbeatPageSchema.parse(input);
      return db.owner(workspaceId, userId, async (tx, actor) => {
        await tx.client.query(
          `SELECT id FROM ${table(tx, 'integrations')} WHERE membership_id=$1 AND user_id=$2 FOR SHARE`,
          [actor.membershipId, actor.userId],
        );
        const integration = await loadIntegration(tx, actor, heartbeatScopes);
        const rows = (
          await tx.client.query(
            `SELECT * FROM ${table(tx, 'heartbeat_items')} WHERE membership_id=$1 AND user_id=$2 AND integration_id=$3 AND account_id=$4 AND generation=$5 AND ($6::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM ${table(tx, 'heartbeat_items')} WHERE id=$6 AND membership_id=$1 AND user_id=$2 AND integration_id=$3 AND account_id=$4 AND generation=$5)) ORDER BY created_at DESC,id DESC LIMIT $7`,
            [
              actor.membershipId,
              actor.userId,
              integration.integrationId,
              integration.accountId,
              integration.generation,
              page.before ?? null,
              page.limit + 1,
            ],
          )
        ).rows;
        return heartbeatResultsSchema.parse({
          results: rows.slice(0, page.limit).map(row => ({
            id: row.id,
            messageId: row.message_id,
            revision: row.revision,
            instructions: row.instructions,
            status: row.status,
            answer: row.answer,
            error: row.error,
            createdAt: z.date().parse(row.created_at).toISOString(),
          })),
          nextCursor: rows.length > page.limit ? rows[page.limit - 1]?.id : null,
        });
      });
    },
    async due(workspaceId: string): Promise<HeartbeatWork[]> {
      return db.transaction(workspaceId, async tx =>
        (
          await tx.client.query(
            `SELECT id FROM ${table(tx, 'heartbeats')} WHERE enabled AND due_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp()) ORDER BY due_at,id LIMIT 20`,
          )
        ).rows.map(row => heartbeatWorkSchema.parse({ workspaceId, heartbeatId: row.id })),
      );
    },
    async retry(workspaceId: string, userId: string, input: z.input<typeof heartbeatRetrySchema>) {
      const command = heartbeatRetrySchema.parse(input);
      return db.owner(workspaceId, userId, async (tx, actor) => {
        const row = await ownRow(tx, actor.membershipId);
        if (!row) throw new AccessDenied();
        await currentHeartbeat(tx, row);
        if (!row.enabled || row.revision !== command.revision) throw new HeartbeatError('heartbeat-stale');
        const item = (
          await tx.client.query(
            `SELECT * FROM ${table(tx, 'heartbeat_items')} WHERE id=$1 AND heartbeat_id=$2 AND membership_id=$3 AND user_id=$4 AND integration_id=$5 AND account_id=$6 AND generation=$7 FOR UPDATE`,
            [
              command.itemId,
              row.id,
              actor.membershipId,
              actor.userId,
              row.integration_id,
              row.account_id,
              row.generation,
            ],
          )
        ).rows[0];
        if (!item) throw new AccessDenied();
        if (item.revision !== row.revision) throw new HeartbeatError('heartbeat-stale');
        const saved = (
          await tx.client.query(
            `SELECT digest FROM ${table(tx, 'heartbeat_retries')} WHERE membership_id=$1 AND command_id=$2`,
            [actor.membershipId, command.commandId],
          )
        ).rows[0];
        if (saved) {
          if (saved.digest !== digest(command)) throw new HeartbeatError('heartbeat-conflict');
          return { accepted: true as const };
        }
        if (item.status !== 'failed') throw new HeartbeatError('heartbeat-conflict');
        await tx.client.query(
          `UPDATE ${table(tx, 'heartbeat_items')} SET status='queued',epoch=epoch+1,error=NULL,lease_until=NULL,retry_at=clock_timestamp() WHERE id=$1`,
          [command.itemId],
        );
        await tx.client.query(
          `INSERT INTO ${table(tx, 'heartbeat_retries')} (membership_id,command_id,digest) VALUES ($1,$2,$3)`,
          [actor.membershipId, command.commandId, digest(command)],
        );
        await tx.client.query(`UPDATE ${table(tx, 'heartbeats')} SET due_at=clock_timestamp() WHERE id=$1`, [row.id]);
        return { accepted: true as const };
      });
    },
    async poll(raw: HeartbeatWork) {
      const work = heartbeatWorkSchema.parse(raw);
      const claimed = await db.transaction(work.workspaceId, async tx => {
        const row = await loadHeartbeat(tx, work.heartbeatId);
        if (!row?.enabled || (row.lease_until && row.lease_until.getTime() > Date.now())) return null;
        try {
          await currentHeartbeat(tx, row);
        } catch {
          await tx.client.query(
            `UPDATE ${table(tx, 'heartbeats')} SET last_error='integration-or-membership-unavailable',due_at=clock_timestamp()+interval '15 minutes' WHERE id=$1`,
            [row.id],
          );
          return null;
        }
        const updated = await tx.client.query(
          `UPDATE ${table(tx, 'heartbeats')} SET epoch=epoch+1,lease_until=clock_timestamp()+interval '5 minutes' WHERE id=$1 RETURNING *`,
          [row.id],
        );
        return heartbeatRowSchema.parse(updated.rows[0]);
      });
      if (!claimed) return;
      const epoch = claimed.epoch;
      const fence = heartbeatFence(work.workspaceId, claimed);
      let checkpoint = claimed.checkpoint;
      try {
        if (checkpoint.kind === 'idle') checkpoint = historyCheckpoint(checkpoint.cursor);
        if (checkpoint.kind === 'history') {
          const current = checkpoint;
          try {
            const page = await provider.history(fence, current.cursor, current.token);
            const ids = [
              ...new Set(page.history.flatMap(event => event.messagesAdded?.map(item => item.message.id) ?? [])),
            ];
            if (ids.length > 1000) throw new HeartbeatError('heartbeat-unavailable');
            await db.fenced(work, epoch, async tx => {
              for (const id of ids)
                await tx.client.query(
                  `INSERT INTO ${table(tx, 'heartbeat_candidates')} (heartbeat_id,cycle_id,message_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
                  [work.heartbeatId, current.cycle, id],
                );
              const hasCandidates =
                (
                  await tx.client.query(
                    `SELECT 1 FROM ${table(tx, 'heartbeat_candidates')} WHERE heartbeat_id=$1 AND cycle_id=$2 LIMIT 1`,
                    [work.heartbeatId, current.cycle],
                  )
                ).rows.length !== 0;
              const next: Checkpoint = page.nextPageToken
                ? { ...current, token: page.nextPageToken }
                : hasCandidates
                  ? {
                      kind: 'matching',
                      cursor: current.cursor,
                      anchor: page.historyId,
                      cycle: current.cycle,
                      token: null,
                      recovery: false,
                    }
                  : { kind: 'idle', cursor: page.historyId };
              await tx.client.query(`UPDATE ${table(tx, 'heartbeats')} SET checkpoint=$2,last_error=NULL WHERE id=$1`, [
                work.heartbeatId,
                next,
              ]);
            });
          } catch (error) {
            if (!(error instanceof HeartbeatError) || error.code !== 'history-expired') throw error;
            const anchor = await provider.profile(fence);
            await db.fenced(work, epoch, async tx => {
              await tx.client.query(`DELETE FROM ${table(tx, 'heartbeat_candidates')} WHERE heartbeat_id=$1`, [
                work.heartbeatId,
              ]);
              await tx.client.query(
                `UPDATE ${table(tx, 'heartbeats')} SET checkpoint=$2,gap_notice='history-expired-deleted-mail-unavailable' WHERE id=$1`,
                [
                  work.heartbeatId,
                  {
                    kind: 'matching',
                    cursor: current.cursor,
                    anchor,
                    cycle: randomUUID(),
                    token: null,
                    recovery: true,
                  },
                ],
              );
            });
          }
        } else {
          const current = checkpoint;
          const page = await provider.matching(fence, {
            ...claimed.settings,
            enabledAt: claimed.enabled_at,
            token: current.token,
          });
          const selected = await db.fenced(work, epoch, async tx => {
            const ids = page.messages.map(message => message.id);
            const candidates = current.recovery
              ? ids
              : (
                  await tx.client.query(
                    `SELECT message_id FROM ${table(tx, 'heartbeat_candidates')} WHERE heartbeat_id=$1 AND cycle_id=$2 AND message_id=ANY($3::text[])`,
                    [work.heartbeatId, current.cycle, ids],
                  )
                ).rows.map(row => z.string().parse(row.message_id));
            const existing = new Set(
              (
                await tx.client.query(
                  `SELECT message_id FROM ${table(tx, 'heartbeat_items')} WHERE integration_id=$1 AND account_id=$2 AND message_id=ANY($3::text[])`,
                  [claimed.integration_id, claimed.account_id, candidates],
                )
              ).rows.map(row => row.message_id),
            );
            return candidates.filter(id => !existing.has(id));
          });
          const messages: z.infer<typeof heartbeatMessageSchema>[] = [];
          for (const id of selected) {
            await db.fenced(work, epoch, async () => undefined);
            const message = await provider.message(fence, id);
            if (message && Number(message.internalDate) >= claimed.enabled_at.getTime()) messages.push(message);
          }
          const next: Checkpoint = page.nextPageToken
            ? { ...current, token: page.nextPageToken }
            : current.recovery
              ? historyCheckpoint(current.anchor)
              : { kind: 'idle', cursor: current.anchor };
          await db.fenced(work, epoch, async tx => {
            for (const message of messages)
              await tx.client.query(
                `INSERT INTO ${table(tx, 'heartbeat_items')} (id,heartbeat_id,membership_id,user_id,integration_id,account_id,generation,message_id,revision,instructions,message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (integration_id,account_id,message_id) DO NOTHING`,
                [
                  randomUUID(),
                  claimed.id,
                  claimed.membership_id,
                  claimed.user_id,
                  claimed.integration_id,
                  claimed.account_id,
                  claimed.generation,
                  message.id,
                  claimed.revision,
                  claimed.settings.instructions,
                  message,
                ],
              );
            await tx.client.query(`UPDATE ${table(tx, 'heartbeats')} SET checkpoint=$2,last_error=NULL WHERE id=$1`, [
              work.heartbeatId,
              next,
            ]);
            if (!page.nextPageToken)
              await tx.client.query(
                `DELETE FROM ${table(tx, 'heartbeat_candidates')} WHERE heartbeat_id=$1 AND cycle_id=$2`,
                [work.heartbeatId, current.cycle],
              );
          });
        }
      } catch (error) {
        if (!(error instanceof HeartbeatError && error.code === 'heartbeat-stale'))
          await db.transaction(work.workspaceId, async tx => {
            await tx.client.query(
              `UPDATE ${table(tx, 'heartbeats')} SET last_error='poll-unavailable' WHERE id=$1 AND epoch=$2`,
              [work.heartbeatId, epoch],
            );
          });
      } finally {
        await db.transaction(work.workspaceId, async tx => {
          await tx.client.query(
            `UPDATE ${table(tx, 'heartbeats')} SET lease_until=NULL,due_at=clock_timestamp()+CASE WHEN checkpoint->>'kind'='idle' THEN (settings->>'cadenceMinutes')::integer * interval '1 minute' ELSE interval '1 second' END WHERE id=$1 AND epoch=$2`,
            [work.heartbeatId, epoch],
          );
        });
      }
    },
    async process(raw: HeartbeatWork, processor: HeartbeatProcessor) {
      const work = heartbeatWorkSchema.parse(raw);
      for (let count = 0; count < 2; count++) {
        const claim = await db.transaction(work.workspaceId, async tx => {
          const row = await loadHeartbeat(tx, work.heartbeatId);
          if (!row?.enabled) return null;
          try {
            await currentHeartbeat(tx, row);
          } catch {
            return null;
          }
          await tx.client.query(
            `UPDATE ${table(tx, 'heartbeat_items')} SET status='failed',error='processing-outcome-unknown',lease_until=NULL WHERE heartbeat_id=$1 AND status='processing' AND lease_until<=clock_timestamp()`,
            [row.id],
          );
          const item = (
            await tx.client.query(
              `SELECT * FROM ${table(tx, 'heartbeat_items')} WHERE heartbeat_id=$1 AND revision=$2 AND status='queued' AND retry_at<=clock_timestamp() ORDER BY created_at,id LIMIT 1 FOR UPDATE`,
              [row.id, row.revision],
            )
          ).rows[0];
          if (!item) return null;
          await tx.client.query(
            `UPDATE ${table(tx, 'heartbeat_items')} SET status='processing',epoch=epoch+1,attempts=attempts+1,lease_until=clock_timestamp()+interval '2 minutes' WHERE id=$1`,
            [item.id],
          );
          return {
            id: z.uuid().parse(item.id),
            epoch: z.number().int().parse(item.epoch) + 1,
            revision: row.revision,
            instructions: z.string().parse(item.instructions),
            message: heartbeatMessageSchema.parse(item.message),
          };
        });
        if (!claim) break;
        let publicationGuard: ProcessingGuard = async () => undefined;
        const authorized = <T>(run: (tx: Parameters<typeof loadHeartbeat>[0]) => Promise<T>) =>
          db.transaction(work.workspaceId, async tx => {
            const row = await loadHeartbeat(tx, work.heartbeatId);
            if (!row?.enabled || row.revision !== claim.revision) throw new HeartbeatError('heartbeat-stale');
            await currentHeartbeat(tx, row);
            const exists = await tx.client.query(
              `SELECT id FROM ${table(tx, 'heartbeat_items')} WHERE id=$1 AND epoch=$2 AND status='processing' AND lease_until>clock_timestamp() FOR UPDATE`,
              [claim.id, claim.epoch],
            );
            if (!exists.rowCount) throw new HeartbeatError('heartbeat-stale');
            return run(tx);
          });
        try {
          const result = await processor({
            work,
            itemId: claim.id,
            epoch: claim.epoch,
            instructions: claim.instructions,
            message: claim.message,
            authorize: guard =>
              authorized(async tx => {
                if (guard) publicationGuard = guard;
                await publicationGuard(tx);
              }),
            dispatch: async run => {
              const started = await authorized(async tx => {
                await publicationGuard(tx);
                const result = run();
                void result.catch(() => undefined);
                return { result };
              });
              return started.result;
            },
          });
          if (typeof result !== 'string') {
            await authorized(async tx => {
              await tx.client.query(
                `UPDATE ${table(tx, 'heartbeat_items')} SET status='queued',attempts=attempts-1,error=$2,lease_until=NULL,retry_at=clock_timestamp()+interval '5 minutes' WHERE id=$1`,
                [claim.id, result.reason],
              );
            });
            continue;
          }
          const answer = z.string().min(1).max(16000).parse(result);
          await authorized(async tx => {
            await publicationGuard(tx);
            await tx.client.query(
              `UPDATE ${table(tx, 'heartbeat_items')} SET status='succeeded',answer=$2,error=NULL WHERE id=$1`,
              [claim.id, answer],
            );
          });
        } catch (error) {
          if (error instanceof HeartbeatError && error.code === 'heartbeat-stale') continue;
          await authorized(async tx => {
            await tx.client.query(
              `UPDATE ${table(tx, 'heartbeat_items')} SET status='failed',error='processing-unavailable',lease_until=NULL WHERE id=$1`,
              [claim.id],
            );
          }).catch(() => undefined);
        }
      }
      await db.transaction(work.workspaceId, async tx => {
        await tx.client.query(
          `UPDATE ${table(tx, 'heartbeats')} h SET due_at=LEAST(due_at,(SELECT min(GREATEST(clock_timestamp()+interval '1 second',CASE WHEN i.status='queued' THEN i.retry_at ELSE i.lease_until END)) FROM ${table(tx, 'heartbeat_items')} i WHERE i.heartbeat_id=h.id AND i.revision=h.revision AND i.status IN ('queued','processing'))) WHERE id=$1 AND enabled`,
          [work.heartbeatId],
        );
      });
    },
  };
}
