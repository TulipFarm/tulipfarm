import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { ResolvedModel } from '@tulipfarm/config';

const cooldownMs = (failure: string | null, retryAfterMs: number | null) =>
  ['overload', 'unavailable', 'transport', 'timeout'].includes(failure ?? '')
    ? Math.min(86400000, Math.max(1000, retryAfterMs ?? 0))
    : 0;

export function createModelRouteHealth(
  pool: Pick<Pool, 'query'>,
  deploymentKey: (resolution: ResolvedModel) => string,
) {
  const key = (resolution: ResolvedModel) => createHash('sha256').update(deploymentKey(resolution)).digest('hex');
  async function claim(resolution: ResolvedModel, attemptId: string, leaseUntil: Date) {
    const result = await pool.query(
      `WITH expired AS (DELETE FROM app.model_route_health_claims WHERE key=$1 AND expires_at<clock_timestamp()), admitted AS (INSERT INTO app.model_route_health (key) VALUES ($1)
      ON CONFLICT (key) DO UPDATE SET
        probe_id=CASE WHEN model_route_health.until_at IS NULL THEN NULL ELSE $2::uuid END,
        probe_until=CASE WHEN model_route_health.until_at IS NULL THEN NULL ELSE $3::timestamptz END
      WHERE model_route_health.until_at IS NULL OR (model_route_health.until_at<=clock_timestamp() AND (model_route_health.probe_until IS NULL OR model_route_health.probe_until<=clock_timestamp()))
      RETURNING key,epoch) INSERT INTO app.model_route_health_claims (attempt_id,key,epoch,expires_at) SELECT $2,key,epoch,$3 FROM admitted RETURNING key`,
      [key(resolution), attemptId, leaseUntil],
    );
    return result.rowCount === 1;
  }
  async function finish(
    resolution: ResolvedModel,
    attemptId: string,
    failure: string | null,
    retryAfterMs: number | null,
  ) {
    const cooldown = cooldownMs(failure, retryAfterMs);
    await pool.query(
      `WITH claim AS (DELETE FROM app.model_route_health_claims WHERE attempt_id=$2 AND key=$1 RETURNING epoch,expires_at)
      UPDATE app.model_route_health h SET until_at=CASE WHEN $3::integer>0 THEN GREATEST(until_at,clock_timestamp()+($3::integer * interval '1 millisecond')) ELSE NULL END,
        epoch=h.epoch+1,probe_id=NULL,probe_until=NULL
      FROM claim WHERE h.key=$1 AND h.epoch=claim.epoch AND claim.expires_at>clock_timestamp()
        AND ((h.probe_id=$2 AND h.probe_until>clock_timestamp()) OR (h.probe_id IS NULL AND $3::integer>0))`,
      [key(resolution), attemptId, cooldown],
    );
  }
  return { claim, finish };
}
export type ModelRouteHealth = ReturnType<typeof createModelRouteHealth>;

// ponytail: cooldowns live per worker replica; use createModelRouteHealth when replicas must share them.
export function createMemoryRouteHealth(deploymentKey: (resolution: ResolvedModel) => string): ModelRouteHealth {
  const until = new Map<string, number>();
  return {
    claim: async resolution => (until.get(deploymentKey(resolution)) ?? 0) <= Date.now(),
    finish: async (resolution, _attemptId, failure, retryAfterMs) => {
      const cooldown = cooldownMs(failure, retryAfterMs);
      if (cooldown) until.set(deploymentKey(resolution), Date.now() + cooldown);
      else until.delete(deploymentKey(resolution));
    },
  };
}
