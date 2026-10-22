import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { retryModelReceiptSchema } from './chat-contracts.ts';
export { retryModelSchema, retryModelReceiptSchema } from './chat-contracts.ts';
import {
  calculateModelCost,
  modelBundleSchema,
  modelUsageSchema,
  parseModelResolution,
  resolvedModelShapeSchema,
  resolveModelBundle,
  usageTokenCounts,
  type ResolvedModel,
  type ModelBundle,
} from '@tulipfarm/config';
import { creditUnitsForProviderCost, recordUsage, type UsageRecord } from '@tulipfarm/extensions';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import { modelNativeTools, type AgentModel } from './model.ts';
import type { InferenceResult } from './inference.ts';
import { AgentError } from './saved-contracts.ts';
import { relation, type AgentTransaction } from './store.ts';
import type { ModelRouteHealth } from './model-health.ts';
import { modelAvailability } from './model-availability.ts';
import { CreditsExhausted, requireCredits, reserveCredits, settleCredits } from '@tulipfarm/workspace-storage/credits';
import { knowledgeTaskSpend } from '@tulipfarm/workspace-storage/knowledge-credits';

type Input = Parameters<AgentModel>[0];
export type ModelContinuity = {
  activeBundle: (
    workspaceId: string,
  ) =>
    | { bundle: ModelBundle; activationRevision: number }
    | Promise<{ bundle: ModelBundle; activationRevision: number }>;
  restrictions: (
    workspaceId: string,
  ) =>
    | { allowedProviders: readonly string[]; allowedLocations: readonly string[] }
    | Promise<{ allowedProviders: readonly string[]; allowedLocations: readonly string[] }>;
  trustedBundle: (bundleId: string) => ModelBundle | Promise<ModelBundle>;
  allowed: (workspaceId: string, resolution: ResolvedModel) => boolean | Promise<boolean>;
  actualModelIds: (resolution: ResolvedModel) => readonly string[];
  health: ModelRouteHealth;
  infer: (resolution: ResolvedModel, input: Input, timeoutMs: number, signal: AbortSignal) => Promise<InferenceResult>;
  budgetPicoUsd: (workspaceId: string) => string | Promise<string>;
  legacyFamily?: (workspaceId: string, agentId: string, definitionRevision: string) => string | undefined;
};
const amount = z.string().regex(/^(0|[1-9]\d{0,29})$/);
const bindingSchema = z.object({
  bundleId: z.string(),
  activationRevision: z.number().int().nonnegative(),
  primary: resolvedModelShapeSchema,
  fallback: resolvedModelShapeSchema.nullable(),
  policyRevision: z.number().int().nonnegative(),
  primaryLastDisabledRevision: z.number().int().nonnegative().default(0),
  fallbackLastDisabledRevision: z.number().int().nonnegative().default(0),
});
const generationSchema = z.object({
  run_id: z.uuid(),
  generation: z.number().int(),
  binding: bindingSchema,
  budget_pico_usd: amount,
  spent_pico_usd: amount,
  deadline: z.date(),
  next_at: z.date(),
  status: z.enum(['pending', 'running', 'failed', 'committed']),
  failure: z.string().nullable(),
  winner: z.uuid().nullable(),
});
const attemptSchema = z.object({
  id: z.uuid(),
  ordinal: z.number().int(),
  role: z.enum(['primary', 'fallback']),
  resolution: resolvedModelShapeSchema,
  reserved_pico_usd: amount,
  status: z.enum(['running', 'succeeded', 'failed', 'abandoned']),
  lease_until: z.date(),
  started_at: z.date(),
  outcome: z.object({ kind: z.string(), reason: z.string().optional() }).nullable(),
});
export type Generation = z.infer<typeof generationSchema>;
export type Attempt = z.infer<typeof attemptSchema>;
export type MeteredUsage = Omit<UsageRecord, 'workspaceId' | 'at'>;
const transient = new Set(['rate-limit', 'overload', 'unavailable', 'timeout', 'transport', 'abandoned']);

async function rule(tx: AgentTransaction, source: string) {
  const row = (
    await tx.client.query(
      `SELECT target_family_id,revision FROM ${relation(tx, 'tf_model_fallback_rules')} WHERE source_family_id=$1`,
      [source],
    )
  ).rows[0];
  return row
    ? z.object({ target_family_id: z.string().nullable(), revision: z.number().int() }).parse(row)
    : { target_family_id: null, revision: 0 };
}

export async function admitGeneration(
  tx: AgentTransaction,
  config: ModelContinuity,
  workspaceId: string,
  runId: string,
  agentId: string,
  revision: string,
  family: string | undefined,
  generation: number,
) {
  try {
    await requireCredits(tx);
  } catch (error) {
    if (error instanceof CreditsExhausted) throw new AgentError('credits-exhausted', 409);
    throw error;
  }
  const requested = family ?? config.legacyFamily?.(workspaceId, agentId, revision);
  if (!requested) throw new AgentError('legacy-model-binding-required', 503);
  const availability = await modelAvailability(tx);
  const primaryAvailability = availability.find(row => row.familyId === requested);
  if (!primaryAvailability?.enabled) throw new AgentError('workspace-disabled', 400);
  const active = await config.activeBundle(workspaceId);
  const bundle = modelBundleSchema.parse(active.bundle);
  const activationRevision = z.number().int().nonnegative().parse(active.activationRevision);
  const restrictions = await config.restrictions(workspaceId);
  const resolve = (familyId: string) => resolveModelBundle({ bundle, familyId, ...restrictions });
  const primary = resolve(requested);
  if (primary.familyId !== requested || !(await config.allowed(workspaceId, primary)))
    throw new AgentError('model-route-unavailable', 503);
  const policy = await rule(tx, requested);
  const fallbackAvailability = availability.find(row => row.familyId === policy.target_family_id);
  const fallback = fallbackAvailability?.enabled ? resolve(fallbackAvailability.familyId) : null;
  if (
    fallback &&
    (fallback.familyId !== policy.target_family_id ||
      fallback.familyId === primary.familyId ||
      !(await config.allowed(workspaceId, fallback)))
  )
    throw new AgentError('model-route-unavailable', 503);
  await tx.client.query(
    `INSERT INTO ${relation(tx, 'tf_model_generations')} (run_id,generation,binding,budget_pico_usd) VALUES ($1,$2,$3,$4)`,
    [
      runId,
      generation,
      {
        bundleId: bundle.id,
        activationRevision,
        primary,
        fallback,
        policyRevision: policy.revision,
        primaryLastDisabledRevision: primaryAvailability.lastDisabledRevision,
        fallbackLastDisabledRevision: fallbackAvailability?.lastDisabledRevision ?? 0,
      },
      amount.parse(await config.budgetPicoUsd(workspaceId)),
    ],
  );
}

export async function latestGeneration(tx: AgentTransaction, runId: string) {
  return generationSchema
    .nullable()
    .parse(
      (
        await tx.client.query(
          `SELECT * FROM ${relation(tx, 'tf_model_generations')} WHERE run_id=$1 ORDER BY generation DESC LIMIT 1 FOR UPDATE`,
          [runId],
        )
      ).rows[0] ?? null,
    );
}

export async function attemptAccounting(tx: AgentTransaction, attemptId: string) {
  const row = (await tx.client.query(`SELECT * FROM ${relation(tx, 'tf_model_attempts')} WHERE id=$1`, [attemptId]))
    .rows[0];
  const attempt = attemptSchema.parse(row);
  const identity = z.object({ run_id: z.uuid(), generation: z.number().int() }).parse(row);
  const generation = generationSchema.parse(
    (
      await tx.client.query(
        `SELECT * FROM ${relation(tx, 'tf_model_generations')} WHERE run_id=$1 AND generation=$2 FOR UPDATE`,
        [identity.run_id, identity.generation],
      )
    ).rows[0],
  );
  return { attempt, generation };
}

export async function failGeneration(tx: AgentTransaction, generation: Generation, reason: string) {
  await tx.client.query(
    `UPDATE ${relation(tx, 'tf_model_attempts')} SET status='abandoned',finished_at=clock_timestamp(),outcome='{"kind":"failure","reason":"abandoned"}' WHERE run_id=$1 AND generation=$2 AND status='running'`,
    [generation.run_id, generation.generation],
  );
  await tx.client.query(
    `UPDATE ${relation(tx, 'tf_model_generations')} SET status='failed',failure=$3 WHERE run_id=$1 AND generation=$2 AND status<>'committed'`,
    [generation.run_id, generation.generation, reason],
  );
  await tx.client.query(
    `UPDATE ${relation(tx, 'tf_agent_chat_turns')} SET status='failed',lease_until=NULL WHERE id=$1 AND decision IS NULL`,
    [generation.run_id],
  );
}

export async function permitted(
  tx: AgentTransaction,
  config: ModelContinuity,
  workspaceId: string,
  generation: Generation,
  resolution: ResolvedModel,
  role: Attempt['role'],
) {
  parseModelResolution(resolution, await config.trustedBundle(generation.binding.bundleId));
  const availability = await modelAvailability(tx);
  const primary = availability.find(row => row.familyId === generation.binding.primary.familyId);
  if (!primary?.enabled || primary.lastDisabledRevision !== generation.binding.primaryLastDisabledRevision)
    return false;
  if (role === 'fallback') {
    const fallback = availability.find(row => row.familyId === resolution.familyId);
    if (!fallback?.enabled || fallback.lastDisabledRevision !== generation.binding.fallbackLastDisabledRevision)
      return false;
  }
  if (!(await config.allowed(workspaceId, resolution))) return false;
  if (role === 'primary') return true;
  const current = await rule(tx, generation.binding.primary.familyId);
  return current.revision === generation.binding.policyRevision && current.target_family_id === resolution.familyId;
}

function reservation(resolution: ResolvedModel, date: string, trustedBundle: ModelBundle, inputTokens: number): string {
  const categories = ['input', 'cacheRead', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h'] as const;
  let maximum = 0n;
  const promptBounds = new Set([
    inputTokens,
    ...resolution.rates.flatMap(rate =>
      rate.promptTokensAbove === null ? [] : [Math.min(rate.promptTokensAbove, inputTokens)],
    ),
  ]);
  for (const promptTokens of promptBounds)
    for (const category of categories) {
      if (!resolution.rates.some(rate => rate.usdPerMillionTokens[category] !== undefined)) continue;
      const tokens = {
        input: 0,
        output: Math.min(4096, resolution.route.maxOutputTokens),
        cacheRead: 0,
        cacheWrite: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        [category]: promptTokens,
      };
      const cost = calculateModelCost({ resolution, usage: { kind: 'known', tokens }, date, trustedBundle });
      if (cost.kind === 'known' && BigInt(cost.providerPicoUsd) > maximum) maximum = BigInt(cost.providerPicoUsd);
    }
  return maximum.toString();
}

export async function claimAttempt(
  tx: AgentTransaction,
  config: ModelContinuity,
  workspaceId: string,
  generation: Generation,
  input: Input,
  task?: { flowId: string; credits: number; timeoutMs: number },
) {
  if (['failed', 'committed'].includes(generation.status)) return null;
  const now = z.date().parse((await tx.client.query('SELECT clock_timestamp() AS now')).rows[0].now);
  const attempts = z
    .array(attemptSchema)
    .parse(
      (
        await tx.client.query(
          `SELECT * FROM ${relation(tx, 'tf_model_attempts')} WHERE run_id=$1 AND generation=$2 ORDER BY ordinal`,
          [generation.run_id, generation.generation],
        )
      ).rows,
    );
  const previous = attempts.at(-1);
  if (previous?.status === 'running') {
    if (previous.lease_until > now && generation.deadline > now) return null;
    await tx.client.query(
      `UPDATE ${relation(tx, 'tf_model_attempts')} SET status='abandoned',finished_at=clock_timestamp(),outcome='{"kind":"failure","reason":"abandoned"}' WHERE id=$1 AND status='running'`,
      [previous.id],
    );
    previous.status = 'abandoned';
    previous.outcome = { kind: 'failure', reason: 'abandoned' };
  }
  if (generation.deadline.getTime() - now.getTime() <= 2000) {
    await failGeneration(tx, generation, 'deadline');
    return null;
  }
  if (generation.next_at > now) return null;
  if (previous && !transient.has(previous.outcome?.reason ?? '')) {
    await failGeneration(tx, generation, previous.outcome?.reason ?? 'invalid-outcome');
    return null;
  }
  const ordinal = attempts.length + 1;
  const role = ordinal <= 2 ? 'primary' : 'fallback';
  const resolution = role === 'primary' ? generation.binding.primary : generation.binding.fallback;
  if (ordinal > 3 || !resolution) {
    await failGeneration(tx, generation, 'attempts-exhausted');
    return null;
  }
  if (!(await permitted(tx, config, workspaceId, generation, resolution, role))) {
    await failGeneration(tx, generation, 'policy-revoked');
    return null;
  }
  const envelopeBytes = Buffer.byteLength(JSON.stringify(modelNativeTools(input).tools), 'utf8') + 2048;
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') + envelopeBytes > resolution.route.maxInputTokens) {
    await failGeneration(tx, generation, 'context-overflow');
    return null;
  }
  const reserved = reservation(
    resolution,
    now.toISOString().slice(0, 10),
    await config.trustedBundle(generation.binding.bundleId),
    Buffer.byteLength(JSON.stringify(input), 'utf8') + envelopeBytes,
  );
  const spending = BigInt(generation.spent_pico_usd) + BigInt(reserved);
  if (
    spending > BigInt(generation.budget_pico_usd) ||
    spending > BigInt(amount.parse(await config.budgetPicoUsd(workspaceId)))
  ) {
    await failGeneration(tx, generation, 'budget');
    return null;
  }
  const id = randomUUID();
  if (task) {
    const spent = amount.parse(
      (
        await tx.client.query(
          `SELECT COALESCE(sum(COALESCE(charged,reserved)),0)::text AS spent FROM ${relation(tx, 'tf_credit_usage')} WHERE flow_id=$1`,
          [task.flowId],
        )
      ).rows[0]?.spent,
    );
    const creditReservation = creditUnitsForProviderCost(BigInt(reserved));
    if (
      BigInt(spent) + (await knowledgeTaskSpend(tx, task.flowId)) + creditReservation >
      BigInt(task.credits) * 1000000000000n
    ) {
      await failGeneration(tx, generation, 'task-credits');
      return null;
    }
  }
  const lease = new Date(Math.min(now.getTime() + (task?.timeoutMs ?? 47000), generation.deadline.getTime()));
  if (!(await config.health.claim(resolution, id, lease))) return null;
  const agentId = z
    .string()
    .parse(
      (await tx.client.query(`SELECT agent_id FROM ${relation(tx, 'tf_agent_runs')} WHERE id=$1`, [generation.run_id]))
        .rows[0]?.agent_id,
    );
  try {
    await reserveCredits(tx, {
      id,
      flowId: task?.flowId ?? generation.run_id,
      modelId: resolution.modelId,
      agentId,
      activity: 'agent',
      providerPicoUsd: reserved,
      pricingRevision: resolution.pricingRevision,
    });
  } catch (error) {
    if (!(error instanceof CreditsExhausted)) throw error;
    await failGeneration(tx, generation, 'credits-exhausted');
    await config.health.finish(resolution, id, null, null);
    return null;
  }
  const result = await tx.client.query(
    `INSERT INTO ${relation(tx, 'tf_model_attempts')} (id,run_id,generation,ordinal,role,resolution,reserved_pico_usd,lease_until) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [id, generation.run_id, generation.generation, ordinal, role, resolution, reserved, lease],
  );
  await tx.client.query(
    `UPDATE ${relation(tx, 'tf_model_generations')} SET spent_pico_usd=spent_pico_usd+$3,status='running' WHERE run_id=$1 AND generation=$2`,
    [generation.run_id, generation.generation, reserved],
  );
  await tx.client.query(
    `UPDATE ${relation(tx, 'tf_agent_chat_turns')} SET status='selecting',lease_id=$2,lease_until=$3,attempted_at=clock_timestamp() WHERE id=$1`,
    [generation.run_id, id, lease],
  );
  return { attempt: attemptSchema.parse(result.rows[0]), dispatchDeadline: lease.getTime() - 2000 };
}

/** Reports usage metered by `settleAttempt` to the registered usage sinks, after its transaction commits. */
export function reportUsage(workspaceId: string, usage: MeteredUsage | null) {
  if (usage) void recordUsage({ ...usage, workspaceId, at: new Date() });
}

/** Settles a model attempt. `onMetered` receives the usage once the attempt settles at a known cost; report it after the transaction commits. */
export async function settleAttempt(
  tx: AgentTransaction,
  config: ModelContinuity,
  generation: Generation,
  attempt: Attempt,
  result: InferenceResult,
  onMetered?: (usage: MeteredUsage) => void,
) {
  const live = await tx.client.query(
    `SELECT 1 FROM ${relation(tx, 'tf_model_attempts')} a JOIN ${relation(tx, 'tf_model_generations')} g USING (run_id,generation) WHERE a.id=$1 AND a.status='running' AND a.lease_until>clock_timestamp() AND g.deadline>clock_timestamp() AND g.status='running' FOR UPDATE OF a`,
    [attempt.id],
  );
  const { kind, ...tokens } = result.usage;
  const actual = result.actualModel;
  let identityMatches = false;
  try {
    identityMatches =
      actual !== null &&
      config
        .actualModelIds(attempt.resolution)
        .some(
          id =>
            actual === id || (actual.startsWith(`${id}-`) && /^\d{4}-\d{2}-\d{2}$/.test(actual.slice(id.length + 1))),
        );
  } catch {
    identityMatches = false;
  }
  let usage = modelUsageSchema.parse(
    kind === 'known' && identityMatches
      ? { kind, tokens }
      : { kind: 'unknown', reason: kind === 'known' ? 'invalid' : 'missing' },
  );
  let cost: ReturnType<typeof calculateModelCost>;
  try {
    cost = calculateModelCost({
      resolution: attempt.resolution,
      usage,
      date: attempt.started_at.toISOString().slice(0, 10),
      trustedBundle: await config.trustedBundle(generation.binding.bundleId),
    });
  } catch {
    usage = { kind: 'unknown', reason: 'invalid' };
    cost = { kind: 'unknown', reason: 'invalid' };
  }
  const definitiveCharge =
    result.kind === 'failure' && result.dispatch === 'not-started'
      ? '0'
      : cost.kind === 'known'
        ? cost.providerPicoUsd
        : null;
  const settled = definitiveCharge === null ? null : await settleCredits(tx, attempt.id, definitiveCharge);
  if (settled && usage.kind === 'known' && cost.kind === 'known')
    onMetered?.({ ...settled, ...usageTokenCounts(usage.tokens) });
  if (!live.rowCount) {
    const corrected = await tx.client.query(
      `UPDATE ${relation(tx, 'tf_model_attempts')} SET outcome=COALESCE(outcome,'{}'::jsonb) || $2::jsonb,usage=$3,cost=$4 WHERE id=$1 AND usage->>'kind'='unknown' AND NOT COALESCE(outcome ? 'chargedPicoUsd',false) RETURNING id`,
      [
        attempt.id,
        {
          kind: 'late',
          actualModel: result.actualModel,
          requestId: result.requestId,
          ...(definitiveCharge !== null ? { chargedPicoUsd: definitiveCharge } : {}),
        },
        usage,
        cost,
      ],
    );
    if (corrected.rowCount && definitiveCharge !== null)
      await tx.client.query(
        `UPDATE ${relation(tx, 'tf_model_generations')} SET spent_pico_usd=spent_pico_usd-$3+$4 WHERE run_id=$1 AND generation=$2`,
        [generation.run_id, generation.generation, attempt.reserved_pico_usd, definitiveCharge],
      );
    return false;
  }
  const charged = definitiveCharge ?? attempt.reserved_pico_usd;
  await tx.client.query(
    `UPDATE ${relation(tx, 'tf_model_attempts')} SET status=$2,finished_at=clock_timestamp(),outcome=$3,usage=$4,cost=$5 WHERE id=$1`,
    [
      attempt.id,
      result.kind === 'success' ? 'succeeded' : 'failed',
      {
        kind: result.kind,
        ...(result.kind === 'failure' ? { reason: result.reason, status: result.status } : {}),
        actualModel: result.actualModel,
        requestId: result.requestId,
        ...(definitiveCharge !== null ? { chargedPicoUsd: definitiveCharge } : {}),
      },
      usage,
      cost,
    ],
  );
  await tx.client.query(
    `UPDATE ${relation(tx, 'tf_model_generations')} SET spent_pico_usd=spent_pico_usd-$3+$4 WHERE run_id=$1 AND generation=$2`,
    [generation.run_id, generation.generation, attempt.reserved_pico_usd, charged],
  );
  if (result.kind === 'success' && !identityMatches) {
    await failGeneration(tx, generation, 'model-identity-mismatch');
    return false;
  }
  if (result.kind === 'failure' && transient.has(result.reason)) {
    const delay = Math.max(result.retryAfterMs ?? 0, 100 + Math.floor(Math.random() * 250));
    const now = z.date().parse((await tx.client.query('SELECT clock_timestamp() AS now')).rows[0].now);
    if (attempt.ordinal === 3 || (attempt.ordinal === 2 && !generation.binding.fallback)) {
      await failGeneration(tx, generation, 'attempts-exhausted');
      return true;
    }
    if (delay + 2000 >= generation.deadline.getTime() - now.getTime()) {
      await failGeneration(tx, generation, 'deadline');
      return true;
    }
    await tx.client.query(
      `UPDATE ${relation(tx, 'tf_model_generations')} SET status='pending',next_at=clock_timestamp()+($3 * interval '1 millisecond') WHERE run_id=$1 AND generation=$2`,
      [generation.run_id, generation.generation, delay],
    );
    await tx.client.query(
      `UPDATE ${relation(tx, 'tf_agent_chat_turns')} SET status='pending',lease_until=NULL WHERE id=$1 AND decision IS NULL`,
      [generation.run_id],
    );
  } else if (result.kind === 'failure') await failGeneration(tx, generation, result.reason);
  return true;
}

export async function recordWinner(tx: AgentTransaction, generation: Generation, attempt: Attempt) {
  await tx.client.query(
    `UPDATE ${relation(tx, 'tf_model_generations')} SET status='committed',winner=$3 WHERE run_id=$1 AND generation=$2`,
    [generation.run_id, generation.generation, attempt.id],
  );
}

export async function previousRetry(tx: AgentTransaction, membershipId: string, input: unknown, requestId: string) {
  const previous = (
    await tx.client.query(
      `SELECT input,receipt FROM ${relation(tx, 'tf_model_retry_commands')} WHERE membership_id=$1 AND request_id=$2`,
      [membershipId, requestId],
    )
  ).rows[0];
  if (!previous) return null;
  if (canonicalJson(previous.input) !== canonicalJson(input)) throw new AgentError('idempotency-conflict');
  return retryModelReceiptSchema.parse(previous.receipt);
}
