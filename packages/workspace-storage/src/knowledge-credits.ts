import { z } from 'zod';
import { creditGate, creditPricing, emitHook } from '@tulipfarm/extensions';
import { qualified, workspaceIdFromSchema } from './names.ts';
import { afterCommit, type SqlClient } from './transactions.ts';
import { CreditsExhausted, lockCredits } from './credits.ts';

type Transaction = { client: SqlClient; schema: string };
const units = z.string().regex(/^(0|[1-9]\d{0,29})$/);
const providerCost = z.string().regex(/^(0|[1-9]\d{0,26})$/);
const identity = z.string().min(1).max(512);
// Knowledge spend is kept in credit units and rounded as one workspace aggregate, under the registered pricing.
const rate = () => creditPricing().unitsPerPicoUsd;
const rounded = (units: bigint) => creditPricing().round(units);
const table = (tx: Transaction, name: string) => qualified(tx.schema, name);

const admissionSchema = z.object({
  id: identity,
  operationId: identity,
  modelId: identity,
  profileId: identity,
  pricingRevision: identity,
  purpose: z.enum(['ingestion', 'query', 'reindex']),
  attribution: z.object({ kind: z.enum(['member', 'source']), id: identity }),
  taskFlowId: identity.nullable(),
  upperProviderPicoUsd: providerCost,
});
export type KnowledgeCreditAdmission = z.infer<typeof admissionSchema>;

const outcomeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('known'),
    attemptId: identity,
    providerPicoUsd: providerCost,
    inputTokens: units,
    providerRequestId: identity.nullable(),
  }),
  z.object({ kind: z.literal('unknown'), attemptId: identity }),
  z.object({ kind: z.literal('undispatched'), attemptId: identity }),
  z.object({ kind: z.literal('marked-undispatched'), attemptId: identity }),
]);
export type KnowledgeCreditOutcome = z.infer<typeof outcomeSchema>;

const groupSchema = z.object({ known: units, pending: units, unfunded: units });
const attemptSchema = z.object({
  id: identity,
  group_version: z.literal(1),
  operation_id: identity,
  model_id: identity,
  profile_id: identity,
  pricing_revision: identity,
  purpose: admissionSchema.shape.purpose,
  attribution_kind: admissionSchema.shape.attribution.shape.kind,
  attribution_id: identity,
  task_flow_id: identity.nullable(),
  upper_provider_pico_usd: providerCost,
  state: z.enum(['reserved', 'dispatched', 'unknown', 'released', 'known']),
});
const observationSchema = z.object({
  provider_pico_usd: providerCost,
  input_tokens: units,
  provider_request_id: identity.nullable(),
  charged: units,
  above_bound: z.boolean(),
});

export class KnowledgeCreditConflict extends Error {
  constructor() {
    super('knowledge-credit-conflict');
  }
}

function groupView(group: z.infer<typeof groupSchema>) {
  const settled = rounded(BigInt(group.known));
  const commitment = rounded(BigInt(group.known) + BigInt(group.pending));
  return {
    version: 1,
    known: group.known,
    pending: group.pending,
    settled: settled.toString(),
    held: (commitment - settled).toString(),
    commitment: commitment.toString(),
    unfunded: group.unfunded,
  };
}

export async function readKnowledgeCreditGroup(tx: Transaction) {
  return groupView(
    groupSchema.parse(
      (
        await tx.client.query(
          `SELECT known,pending,unfunded FROM ${table(tx, 'tf_knowledge_credit_group')} WHERE version=1`,
        )
      ).rows[0],
    ),
  );
}

async function lockGroup(tx: Transaction) {
  const available = await lockCredits(tx);
  const group = groupSchema.parse(
    (
      await tx.client.query(
        `SELECT known,pending,unfunded FROM ${table(tx, 'tf_knowledge_credit_group')} WHERE version=1 FOR UPDATE`,
      )
    ).rows[0],
  );
  return { available, group };
}

async function readAttempt(tx: Transaction, id: string) {
  return attemptSchema
    .optional()
    .parse(
      (await tx.client.query(`SELECT * FROM ${table(tx, 'tf_knowledge_credit_attempts')} WHERE id=$1 FOR UPDATE`, [id]))
        .rows[0],
    );
}

async function writeGroup(
  tx: Transaction,
  previous: Awaited<ReturnType<typeof lockGroup>>,
  known: bigint,
  pending: bigint,
  entry: { id: string; purpose: KnowledgeCreditAdmission['purpose'] },
) {
  const oldCommitment = rounded(BigInt(previous.group.known) + BigInt(previous.group.pending));
  const commitment = rounded(known + pending);
  const delta = commitment - oldCommitment + BigInt(previous.group.unfunded);
  const debit = previous.available !== null && delta > previous.available ? previous.available : delta;
  const unfunded = delta - debit;
  await creditGate().debit(tx, debit, { id: entry.id, activity: `knowledge-${entry.purpose}` });
  await tx.client.query(
    `UPDATE ${table(tx, 'tf_knowledge_credit_group')} SET known=$1,pending=$2,unfunded=$3 WHERE version=1`,
    [known.toString(), pending.toString(), unfunded.toString()],
  );
  return groupView({ known: known.toString(), pending: pending.toString(), unfunded: unfunded.toString() });
}

export async function reserveKnowledgeCredits(tx: Transaction, input: KnowledgeCreditAdmission) {
  const admission = admissionSchema.parse(input);
  const locked = await lockGroup(tx);
  const previous = await readAttempt(tx, admission.id);
  if (previous) {
    const replay = {
      id: previous.id,
      operationId: previous.operation_id,
      modelId: previous.model_id,
      profileId: previous.profile_id,
      pricingRevision: previous.pricing_revision,
      purpose: previous.purpose,
      attribution: { kind: previous.attribution_kind, id: previous.attribution_id },
      taskFlowId: previous.task_flow_id,
      upperProviderPicoUsd: previous.upper_provider_pico_usd,
    };
    if (JSON.stringify(replay) !== JSON.stringify(admission)) throw new KnowledgeCreditConflict();
    return { admitted: false, state: previous.state, group: groupView(locked.group) };
  }
  const known = BigInt(locked.group.known);
  const pending = BigInt(locked.group.pending) + BigInt(admission.upperProviderPicoUsd) * rate();
  const delta = rounded(known + pending) - rounded(known + BigInt(locked.group.pending));
  if (locked.available !== null && BigInt(locked.group.unfunded) + delta > locked.available)
    throw new CreditsExhausted();
  const group = await writeGroup(tx, locked, known, pending, admission);
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_knowledge_credit_attempts')} (id,group_version,operation_id,model_id,profile_id,pricing_revision,purpose,attribution_kind,attribution_id,task_flow_id,upper_provider_pico_usd) VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      admission.id,
      admission.operationId,
      admission.modelId,
      admission.profileId,
      admission.pricingRevision,
      admission.purpose,
      admission.attribution.kind,
      admission.attribution.id,
      admission.taskFlowId,
      admission.upperProviderPicoUsd,
    ],
  );
  return { admitted: true, state: 'reserved' as const, group };
}

export async function markKnowledgeDispatched(tx: Transaction, attemptId: string) {
  await lockGroup(tx);
  const attempt = await readAttempt(tx, identity.parse(attemptId));
  if (!attempt) throw new KnowledgeCreditConflict();
  if (attempt.state !== 'reserved') return false;
  await tx.client.query(`UPDATE ${table(tx, 'tf_knowledge_credit_attempts')} SET state='dispatched' WHERE id=$1`, [
    attemptId,
  ]);
  return true;
}

export async function recordKnowledgeCreditOutcome(tx: Transaction, input: KnowledgeCreditOutcome) {
  const outcome = outcomeSchema.parse(input);
  const locked = await lockGroup(tx);
  const attempt = await readAttempt(tx, outcome.attemptId);
  if (!attempt) throw new KnowledgeCreditConflict();
  if (outcome.kind === 'known') {
    if (attempt.state === 'known') {
      const observation = observationSchema.parse(
        (
          await tx.client.query(`SELECT * FROM ${table(tx, 'tf_knowledge_credit_observations')} WHERE attempt_id=$1`, [
            attempt.id,
          ])
        ).rows[0],
      );
      if (
        observation.provider_pico_usd !== outcome.providerPicoUsd ||
        observation.input_tokens !== outcome.inputTokens ||
        observation.provider_request_id !== outcome.providerRequestId
      )
        throw new KnowledgeCreditConflict();
      const group = await writeGroup(tx, locked, BigInt(locked.group.known), BigInt(locked.group.pending), attempt);
      return { state: 'known' as const, reconciliation: observation.above_bound || BigInt(group.unfunded) > 0n, group };
    }
    if (attempt.state !== 'dispatched' && attempt.state !== 'unknown') throw new KnowledgeCreditConflict();
    const cost = BigInt(outcome.providerPicoUsd) * rate();
    const upper = BigInt(attempt.upper_provider_pico_usd) * rate();
    const known = BigInt(locked.group.known) + cost;
    const charged = rounded(known) - rounded(BigInt(locked.group.known));
    const group = await writeGroup(tx, locked, known, BigInt(locked.group.pending) - upper, attempt);
    await tx.client.query(
      `INSERT INTO ${table(tx, 'tf_knowledge_credit_observations')} (attempt_id,provider_pico_usd,input_tokens,provider_request_id,charged,above_bound) VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        attempt.id,
        outcome.providerPicoUsd,
        outcome.inputTokens,
        outcome.providerRequestId,
        charged.toString(),
        cost > upper,
      ],
    );
    await tx.client.query(`UPDATE ${table(tx, 'tf_knowledge_credit_attempts')} SET state='known' WHERE id=$1`, [
      attempt.id,
    ]);
    afterCommit(
      tx.client,
      () =>
        void emitHook('usage.recorded', {
          workspaceId: workspaceIdFromSchema(tx.schema),
          usageId: attempt.id,
          flowId: attempt.task_flow_id,
          modelId: attempt.model_id,
          activity: `knowledge-${attempt.purpose}`,
          providerPicoUsd: outcome.providerPicoUsd,
        }),
    );
    return { state: 'known' as const, reconciliation: cost > upper || BigInt(group.unfunded) > 0n, group };
  }
  if (outcome.kind === 'unknown') {
    if (attempt.state === 'reserved' || attempt.state === 'released') throw new KnowledgeCreditConflict();
    if (attempt.state === 'dispatched')
      await tx.client.query(`UPDATE ${table(tx, 'tf_knowledge_credit_attempts')} SET state='unknown' WHERE id=$1`, [
        attempt.id,
      ]);
    return {
      state: attempt.state === 'known' ? ('known' as const) : ('unknown' as const),
      reconciliation: attempt.state !== 'known' || BigInt(locked.group.unfunded) > 0n,
      group: groupView(locked.group),
    };
  }
  if (attempt.state === 'released')
    return {
      state: 'released' as const,
      reconciliation: BigInt(locked.group.unfunded) > 0n,
      group: groupView(locked.group),
    };
  if (
    outcome.kind === 'undispatched'
      ? attempt.state !== 'reserved'
      : attempt.state !== 'dispatched' && attempt.state !== 'unknown'
  )
    throw new KnowledgeCreditConflict();
  const group = await writeGroup(
    tx,
    locked,
    BigInt(locked.group.known),
    BigInt(locked.group.pending) - BigInt(attempt.upper_provider_pico_usd) * rate(),
    attempt,
  );
  await tx.client.query(`UPDATE ${table(tx, 'tf_knowledge_credit_attempts')} SET state='released' WHERE id=$1`, [
    attempt.id,
  ]);
  return { state: 'released' as const, reconciliation: BigInt(group.unfunded) > 0n, group };
}

// Credit units of knowledge embedding attempts made inside one agent task.
// The wallet is charged only through the knowledge aggregate; this is a budget observation.
export async function knowledgeTaskUsage(tx: Transaction, taskFlowId: string) {
  const installed = z
    .object({ installed: z.boolean() })
    .parse(
      (
        await tx.client.query('SELECT to_regclass($1) IS NOT NULL AS installed', [
          table(tx, 'tf_knowledge_credit_attempts'),
        ])
      ).rows[0],
    ).installed;
  if (!installed) return { known: 0n, held: 0n };
  const row = z.object({ known: units, held: units }).parse(
    (
      await tx.client.query(
        `SELECT
      COALESCE(sum(o.provider_pico_usd) FILTER (WHERE a.state='known'),0)::text AS known,
      COALESCE(sum(a.upper_provider_pico_usd) FILTER (WHERE a.state IN ('reserved','dispatched','unknown')),0)::text AS held
    FROM ${table(tx, 'tf_knowledge_credit_attempts')} a LEFT JOIN ${table(tx, 'tf_knowledge_credit_observations')} o ON o.attempt_id=a.id
    WHERE a.task_flow_id=$1`,
        [identity.parse(taskFlowId)],
      )
    ).rows[0],
  );
  return { known: BigInt(row.known) * rate(), held: BigInt(row.held) * rate() };
}

export async function knowledgeTaskSpend(tx: Transaction, taskFlowId: string) {
  const usage = await knowledgeTaskUsage(tx, taskFlowId);
  return usage.known + usage.held;
}
