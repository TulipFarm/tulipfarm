import { z } from 'zod';
import {
  chatLatencyAlerts,
  chatLatencyBounds,
  chatLatencyPhases,
  chatLatencyStates,
  type ChatLatencySnapshot,
} from '@tulipfarm/observability';
import { commonCompatibility, qualified } from '@tulipfarm/workspace-storage/runtime';
import type { ConversationRuntime } from './runtime.ts';

const number = z.number().finite().nonnegative();
const snapshotSchema = z.object({
  durations: z.array(
    z.object({
      phase: z.enum(chatLatencyPhases),
      buckets: z.array(number).length(chatLatencyBounds.length),
      count: number,
      total: number,
    }),
  ),
  states: z.array(z.object({ state: z.enum(chatLatencyStates), count: number })),
  oldest: z.array(z.object({ phase: z.enum(chatLatencyAlerts), seconds: number })),
  slow: z.array(z.object({ phase: z.enum(chatLatencyAlerts), at: number })),
  attempts: number,
});

export function emptyChatLatency(): ChatLatencySnapshot {
  return {
    durations: chatLatencyPhases.map(phase => ({ phase, buckets: chatLatencyBounds.map(() => 0), count: 0, total: 0 })),
    states: chatLatencyStates.map(state => ({ state, count: 0 })),
    oldest: chatLatencyAlerts.map(phase => ({ phase, seconds: 0 })),
    slow: chatLatencyAlerts.map(phase => ({ phase, at: 0 })),
    attempts: 0,
  };
}

export function mergeChatLatency(target: ChatLatencySnapshot, source: ChatLatencySnapshot) {
  for (const item of source.durations) {
    const combined = target.durations.find(value => value.phase === item.phase)!;
    combined.count += item.count;
    combined.total += item.total;
    for (const [index, count] of item.buckets.entries()) combined.buckets[index]! += count;
  }
  for (const item of source.states) target.states.find(value => value.state === item.state)!.count += item.count;
  for (const item of source.oldest) {
    const combined = target.oldest.find(value => value.phase === item.phase)!;
    combined.seconds = Math.max(combined.seconds, item.seconds);
  }
  for (const item of source.slow) {
    const combined = target.slow.find(value => value.phase === item.phase)!;
    combined.at = Math.max(combined.at, item.at);
  }
  target.attempts += source.attempts;
}

export async function readChatLatency(runtime: ConversationRuntime, workspaceId: string): Promise<ChatLatencySnapshot> {
  return runtime.transaction(workspaceId, { minimum: 1, maximum: commonCompatibility.maximum }, async tx => {
    const result = await tx.client.query(
      `WITH clock AS (SELECT statement_timestamp() AS stamp), turns AS (
      SELECT status,timing_started_at,timing_state_since,timing_claimed_at,timing_dispatched_at,timing_first_text_at,
        timing_first_text_seconds,timing_finished_at,timing_queue_seconds,timing_processing_seconds,
        timing_human_wait_seconds,timing_external_wait_seconds,timing_inactive_seconds,timing_attempts,stamp,
        CASE WHEN status='waiting' AND COALESCE(error_code,'') NOT IN ('slack-action-waiting','mcp-action-waiting') THEN 'human-wait'
          WHEN status='waiting' THEN 'external-wait' ELSE status END AS state,
        greatest(0,extract(epoch FROM stamp-timing_state_since))::double precision AS elapsed
      FROM ${qualified(tx.schema, 'tf_conversation_turns')} t CROSS JOIN clock
      WHERE timing_started_at IS NOT NULL AND (timing_finished_at IS NULL OR timing_finished_at>=stamp-interval '24 hours')
    ), measured AS (
      SELECT *,
        greatest(0,extract(epoch FROM COALESCE(timing_finished_at,stamp)-timing_started_at)
          -timing_human_wait_seconds-timing_inactive_seconds-CASE WHEN state='human-wait' THEN elapsed ELSE 0 END)::double precision AS active,
        timing_queue_seconds+CASE WHEN state='queued' THEN elapsed ELSE 0 END AS queue,
        state IN ('queued','processing','external-wait','reconciling') AS running
      FROM turns
    ), samples AS (
      SELECT phase,seconds FROM measured CROSS JOIN LATERAL (VALUES
        ('wall',CASE WHEN timing_finished_at IS NOT NULL THEN extract(epoch FROM timing_finished_at-timing_started_at)::double precision END),
        ('active',CASE WHEN timing_finished_at IS NOT NULL THEN active END),
        ('queue',CASE WHEN timing_finished_at IS NOT NULL THEN queue END),
        ('processing',CASE WHEN timing_finished_at IS NOT NULL THEN timing_processing_seconds END),
        ('human-wait',CASE WHEN timing_finished_at IS NOT NULL THEN timing_human_wait_seconds END),
        ('external-wait',CASE WHEN timing_finished_at IS NOT NULL THEN timing_external_wait_seconds END),
        ('first-text',timing_first_text_seconds),
        ('dispatch',CASE WHEN timing_dispatched_at IS NOT NULL THEN greatest(0,extract(epoch FROM timing_dispatched_at-timing_started_at)::double precision) END),
        ('worker-start',CASE WHEN timing_claimed_at>=timing_dispatched_at THEN extract(epoch FROM timing_claimed_at-timing_dispatched_at)::double precision END)
      ) AS durations(phase,seconds) WHERE seconds IS NOT NULL
    ), distributions AS (
      SELECT p.phase,count(s.seconds)::integer AS count,COALESCE(sum(s.seconds),0) AS total
      FROM unnest($1::text[]) p(phase) LEFT JOIN samples s ON s.phase=p.phase GROUP BY p.phase
    )
    SELECT jsonb_build_object(
      'durations',(SELECT jsonb_agg(jsonb_build_object('phase',d.phase,'count',d.count,'total',d.total,
        'buckets',(SELECT jsonb_agg(n ORDER BY ordinal) FROM (
          SELECT b.ordinal,count(s.seconds)::integer AS n FROM unnest($2::double precision[]) WITH ORDINALITY b(bound,ordinal)
          LEFT JOIN samples s ON s.phase=d.phase AND s.seconds<=b.bound GROUP BY b.ordinal
        ) b))) FROM distributions d),
      'states',(SELECT jsonb_agg(jsonb_build_object('state',state,'count',n)) FROM (SELECT state,count(*)::integer AS n FROM measured GROUP BY state) s),
      'oldest',jsonb_build_array(
        jsonb_build_object('phase','queue','seconds',COALESCE((SELECT max(elapsed) FROM measured WHERE state='queued'),0)),
        jsonb_build_object('phase','first-text','seconds',COALESCE((SELECT max(active) FROM measured WHERE running AND timing_first_text_at IS NULL),0)),
        jsonb_build_object('phase','active','seconds',COALESCE((SELECT max(active) FROM measured WHERE running),0))),
      'slow',jsonb_build_array(
        jsonb_build_object('phase','queue','at',COALESCE((SELECT max(extract(epoch FROM CASE WHEN running THEN stamp ELSE timing_finished_at END)) FROM measured WHERE queue>5 AND state<>'human-wait'),0)),
        jsonb_build_object('phase','first-text','at',COALESCE((SELECT max(extract(epoch FROM timing_first_text_at)) FROM measured WHERE timing_first_text_seconds>10),0)),
        jsonb_build_object('phase','active','at',COALESCE((SELECT max(extract(epoch FROM CASE WHEN running THEN stamp ELSE timing_finished_at END)) FROM measured WHERE active>30 AND state<>'human-wait'),0))),
      'attempts',COALESCE((SELECT sum(timing_attempts)::integer FROM measured),0)
    ) AS snapshot`,
      [chatLatencyPhases, chatLatencyBounds.map(bound => (Number.isFinite(bound) ? bound : 'Infinity'))],
    );
    const parsed = snapshotSchema.parse({ ...result.rows[0].snapshot, states: result.rows[0].snapshot.states ?? [] });
    const snapshot = emptyChatLatency();
    mergeChatLatency(snapshot, parsed);
    return snapshot;
  });
}
