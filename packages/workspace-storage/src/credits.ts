import { z } from 'zod';
import { creditGate, creditPricing, creditUnitsForProviderCost, emitHook } from '@tulipfarm/extensions';
import { observeChatDetail } from '@tulipfarm/observability';
import { qualified, workspaceIdFromSchema } from './names.ts';
import { afterCommit, type SqlClient } from './transactions.ts';
import { creditActivitySchema, creditSummarySchema } from './credits-contracts.ts';

type Transaction = { client: SqlClient; schema: string };
const units = z.string().regex(/^(0|[1-9]\d{0,29})$/);
const row = z.object({
  flow_id: z.string(),
  model_id: z.string(),
  agent_id: z.string().nullable(),
  activity: creditActivitySchema,
  reserved: units,
  charged: units.nullable(),
});
const table = (tx: Transaction, name: string) => qualified(tx.schema, name);
const credits = (value: string) => Number(BigInt(value)) / 1_000_000_000_000;
export { creditUnitsForProviderCost };

export class CreditsExhausted extends Error {
  constructor() {
    super('credits-exhausted');
  }
}
export class CreditAttemptAlreadyDispatched extends Error {
  constructor() {
    super('credit-attempt-already-dispatched');
  }
}

// Usage is metered here in tf_credit_usage; the registered credit gate (unlimited by default) funds it.

/** Serializes credit work in the workspace until the transaction ends. Returns the gate's available units, or null when unlimited. */
export async function lockCredits(tx: Transaction) {
  return observeChatDetail('credit-account-lock', async () => {
    await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 761040))', [`${tx.schema}:credits`]);
    return creditGate().available(tx, { lock: true });
  });
}

export async function requireCredits(tx: Transaction) {
  const available = await creditGate().available(tx);
  if (available !== null && available <= 0n) throw new CreditsExhausted();
}

export async function reserveCredits(
  tx: Transaction,
  input: {
    id: string;
    flowId: string;
    modelId: string;
    agentId: string | null;
    activity: 'chat' | 'agent' | 'other' | 'table-search';
    providerPicoUsd: string;
    pricingRevision: string;
  },
) {
  const reserved = creditUnitsForProviderCost(BigInt(units.parse(input.providerPicoUsd))).toString();
  const available = await lockCredits(tx);
  if ((await tx.client.query(`SELECT 1 FROM ${table(tx, 'tf_credit_usage')} WHERE id=$1`, [input.id])).rowCount)
    return false;
  if (available !== null && (available <= 0n || available < BigInt(reserved))) throw new CreditsExhausted();
  await creditGate().debit(tx, BigInt(reserved), { id: input.id, activity: input.activity });
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_credit_usage')} (id,flow_id,model_id,agent_id,activity,reserved,pricing_revision) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [input.id, input.flowId, input.modelId, input.agentId, input.activity, reserved, input.pricingRevision],
  );
  return true;
}

/** Settles a reservation at its provider cost. Returns the settled attempt, or null when it was missing or already settled. */
export async function settleCredits(tx: Transaction, id: string, providerPicoUsd: string) {
  await lockCredits(tx);
  const previous = row
    .optional()
    .parse(
      (
        await observeChatDetail('credit-usage-lock', () =>
          tx.client.query(
            `SELECT flow_id,model_id,agent_id,activity,reserved,charged FROM ${table(tx, 'tf_credit_usage')} WHERE id=$1 FOR UPDATE`,
            [id],
          ),
        )
      ).rows[0],
    );
  if (!previous || previous.charged !== null) return null;
  const cost = units.parse(providerPicoUsd);
  const total = z
    .object({ cost: units, charged: units })
    .parse(
      (
        await tx.client.query(
          `SELECT COALESCE(sum(provider_pico_usd),0)::text AS cost, COALESCE(sum(charged),0)::text AS charged FROM ${table(tx, 'tf_credit_usage')} WHERE flow_id=$1`,
          [previous.flow_id],
        )
      ).rows[0],
    );
  const charged = creditUnitsForProviderCost(BigInt(total.cost) + BigInt(cost)) - BigInt(total.charged);
  if (charged > BigInt(previous.reserved)) throw new Error('credit-reservation-exceeded');
  await tx.client.query(`UPDATE ${table(tx, 'tf_credit_usage')} SET charged=$2,provider_pico_usd=$3 WHERE id=$1`, [
    id,
    charged.toString(),
    cost,
  ]);
  await creditGate().debit(tx, charged - BigInt(previous.reserved), { id, activity: previous.activity });
  afterCommit(
    tx.client,
    () =>
      void emitHook('usage.recorded', {
        workspaceId: workspaceIdFromSchema(tx.schema),
        usageId: id,
        flowId: previous.flow_id,
        modelId: previous.model_id,
        activity: previous.activity,
        providerPicoUsd: cost,
      }),
  );
  return {
    flowId: previous.flow_id,
    modelId: previous.model_id,
    agentId: previous.agent_id,
    activity: previous.activity,
    providerPicoUsd: cost,
  };
}

/**
 * Finalizes an attempt whose usage stayed unknown without refunding it: the provider may have billed, so the
 * attempt settles as though it cost its whole reservation. Already settled attempts are unchanged.
 */
export async function settleCreditsAtReservation(tx: Transaction, id: string) {
  await lockCredits(tx);
  const previous = row
    .optional()
    .parse(
      (
        await observeChatDetail('credit-usage-lock', () =>
          tx.client.query(
            `SELECT flow_id,model_id,agent_id,activity,reserved,charged FROM ${table(tx, 'tf_credit_usage')} WHERE id=$1 FOR UPDATE`,
            [id],
          ),
        )
      ).rows[0],
    );
  if (!previous || previous.charged !== null) return null;
  // The largest provider cost whose charge, under the registered pricing, equals the reservation.
  return settleCredits(tx, id, (BigInt(previous.reserved) / creditPricing().unitsPerPicoUsd).toString());
}

/** The provider cost whose charge, under the registered pricing, equals `units`: the unknown-usage policy of {@link settleCreditsAtReservation}. */
export function providerCostAtUnits(units: bigint) {
  return (units / creditPricing().unitsPerPicoUsd).toString();
}

/**
 * Holds credits for a whole reply in one row: up to `preferred` units, never more than the gate has, and at least
 * `minimum`. The hold row becomes the usage row of the first call it funds. Returns the held units, or null when
 * the row already exists (the attempt was already dispatched).
 */
export async function holdReplyCredits(
  tx: Transaction,
  input: {
    id: string;
    flowId: string;
    modelId: string;
    activity: 'chat' | 'agent' | 'other';
    pricingRevision: string;
    minimum: bigint;
    preferred: bigint;
    planAttemptId: string | null;
  },
) {
  const available = await lockCredits(tx);
  if ((await tx.client.query(`SELECT 1 FROM ${table(tx, 'tf_credit_usage')} WHERE id=$1`, [input.id])).rowCount)
    return null;
  if (available !== null && (available <= 0n || available < input.minimum)) throw new CreditsExhausted();
  const preferred = input.preferred > input.minimum ? input.preferred : input.minimum;
  const reserved = available === null || available > preferred ? preferred : available;
  await creditGate().debit(tx, reserved, { id: input.id, activity: input.activity });
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_credit_usage')} (id,flow_id,model_id,agent_id,activity,reserved,pricing_revision,plan_attempt_id) VALUES ($1,$2,$3,NULL,$4,$5,$6,$7)`,
    [
      input.id,
      input.flowId,
      input.modelId,
      input.activity,
      reserved.toString(),
      input.pricingRevision,
      input.planAttemptId,
    ],
  );
  return reserved;
}

export type ReplyCreditCall = {
  id: string;
  modelId: string;
  pricingRevision: string;
  providerPicoUsd: string;
  planMilliseconds: number | null;
};

/**
 * Settles a reply hold with every call it funded, in call order, exactly as one settlement per call would: each
 * charge rounds the flow's running provider cost. The first call reuses the hold row when it has the hold's id;
 * every other call gets its own row. The gate is debited once for the difference from the hold. Returns the
 * charges, or null when the hold was missing or already settled (for example by crash recovery).
 */
export async function settleReplyCredits(
  tx: Transaction,
  holdId: string,
  calls: readonly ReplyCreditCall[],
  committed?: () => void,
) {
  await lockCredits(tx);
  const hold = row
    .extend({ plan_attempt_id: z.string().nullable() })
    .optional()
    .parse(
      (
        await observeChatDetail('credit-usage-lock', () =>
          tx.client.query(
            `SELECT flow_id,model_id,agent_id,activity,reserved,charged,plan_attempt_id FROM ${table(tx, 'tf_credit_usage')} WHERE id=$1 FOR UPDATE`,
            [holdId],
          ),
        )
      ).rows[0],
    );
  if (!hold || hold.charged !== null) return null;
  const total = z
    .object({ cost: units, charged: units })
    .parse(
      (
        await tx.client.query(
          `SELECT COALESCE(sum(provider_pico_usd),0)::text AS cost, COALESCE(sum(charged),0)::text AS charged FROM ${table(tx, 'tf_credit_usage')} WHERE flow_id=$1`,
          [hold.flow_id],
        )
      ).rows[0],
    );
  let cost = BigInt(total.cost);
  let charged = BigInt(total.charged);
  const charges = calls.map(call => {
    cost += BigInt(units.parse(call.providerPicoUsd));
    const charge = creditUnitsForProviderCost(cost) - charged;
    charged += charge;
    return { ...call, charged: charge };
  });
  const sum = charges.reduce((n, call) => n + call.charged, 0n);
  if (sum > BigInt(hold.reserved)) throw new Error('credit-reservation-exceeded');
  const first = charges[0]?.id === holdId ? charges[0] : undefined;
  const rest = first ? charges.slice(1) : charges;
  await tx.client.query(
    `UPDATE ${table(tx, 'tf_credit_usage')} SET charged=$2,provider_pico_usd=$3,plan_milliseconds=COALESCE($4,plan_milliseconds) WHERE id=$1`,
    [holdId, (first?.charged ?? 0n).toString(), first?.providerPicoUsd ?? '0', first?.planMilliseconds ?? null],
  );
  for (const call of rest)
    await tx.client.query(
      `INSERT INTO ${table(tx, 'tf_credit_usage')} (id,flow_id,model_id,agent_id,activity,reserved,charged,provider_pico_usd,pricing_revision,plan_attempt_id,plan_milliseconds) VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10)`,
      [
        call.id,
        hold.flow_id,
        call.modelId,
        hold.agent_id,
        hold.activity,
        call.charged.toString(),
        call.providerPicoUsd,
        call.pricingRevision,
        hold.plan_attempt_id,
        call.planMilliseconds,
      ],
    );
  await creditGate().debit(tx, sum - BigInt(hold.reserved), { id: holdId, activity: hold.activity });
  const workspaceId = workspaceIdFromSchema(tx.schema);
  for (const call of charges)
    afterCommit(
      tx.client,
      () =>
        void emitHook('usage.recorded', {
          workspaceId,
          usageId: call.id,
          flowId: hold.flow_id,
          modelId: call.modelId,
          activity: hold.activity,
          providerPicoUsd: call.providerPicoUsd,
        }),
    );
  if (committed) afterCommit(tx.client, committed);
  return charges.map(({ id, charged }) => ({ id, charged }));
}

/**
 * Finalizes reply holds that an earlier attempt in this flow left open (a crashed or abandoned worker), under the
 * unknown-usage policy: each settles at its whole reservation. `current` is the live attempt's id prefix, whose rows
 * are never touched. Only one attempt of a conversation holds its lease, so any other open chat row is abandoned.
 */
export async function recoverReplyHolds(tx: Transaction, flowId: string, current: string) {
  const open = z
    .array(z.object({ id: z.string() }))
    .parse(
      (
        await tx.client.query(
          `SELECT id FROM ${table(tx, 'tf_credit_usage')} WHERE flow_id=$1 AND charged IS NULL AND activity='chat' AND id LIKE 'chat:%' AND left(id,length($2))<>$2 ORDER BY created_at,id`,
          [flowId, current],
        )
      ).rows,
    );
  for (const { id } of open) await settleCreditsAtReservation(tx, id);
  return open.length;
}

// Balances stay workspace-wide. A workspace view covers all usage. A personal view covers
// only the given flows: its totals and rows exclude every other flow and workspace knowledge spend.
// Without a view, the ledger is returned unchanged.
export type CreditUsageView = { kind: 'workspace' } | { kind: 'personal'; flowIds: readonly string[] };

export async function creditSummary(tx: Transaction, view?: CreditUsageView) {
  // The balance belongs to the registered credit gate; the default gate is unlimited (null).
  const gate = creditGate();
  const account = gate.balance
    ? await gate.balance(tx)
    : await gate.available(tx).then(available => (available === null ? null : { available, granted: null }));
  const balance = account
    ? {
        available: credits(account.available.toString()),
        granted: account.granted === null ? null : credits(account.granted.toString()),
      }
    : { available: null, granted: null };
  const periodStart = `(((clock_timestamp() AT TIME ZONE 'UTC')::date-29)::timestamp AT TIME ZONE 'UTC')`;
  if (view?.kind === 'personal') {
    const flows = [...view.flowIds];
    const own = z
      .object({ used: units, held: units })
      .parse(
        (
          await tx.client.query(
            `SELECT COALESCE(sum(charged),0)::text AS used, COALESCE(sum(reserved) FILTER (WHERE charged IS NULL),0)::text AS held FROM ${table(tx, 'tf_credit_usage')} WHERE flow_id = ANY($1::text[])`,
            [flows],
          )
        ).rows[0],
      );
    const activity = `SELECT model_id,agent_id,activity,charged,created_at AS occurred_at FROM ${table(tx, 'tf_credit_usage')} WHERE created_at >= ${periodStart} AND flow_id = ANY($1::text[])`;
    const { days, breakdown, series } = await usageRows(tx, activity, [flows]);
    return creditSummarySchema.parse({
      scope: 'personal',
      ...balance,
      used: credits(own.used),
      held: credits(own.held),
      days,
      breakdown,
      series,
    });
  }
  const knowledgeGroup = `SELECT known,pending,unfunded FROM ${table(tx, 'tf_knowledge_credit_group')} WHERE version=1`;
  const sums = z.object({ used: units, held: units, known: units, pending: units, unfunded: units }).parse(
    (
      await tx.client.query(`
    SELECT legacy.used::text AS used, legacy.held::text AS held, k.known::text AS known, k.pending::text AS pending, k.unfunded::text AS unfunded
    FROM (SELECT COALESCE(sum(charged),0) AS used, COALESCE(sum(reserved) FILTER (WHERE charged IS NULL),0) AS held FROM ${table(tx, 'tf_credit_usage')}) legacy
    CROSS JOIN (${knowledgeGroup}) k`)
    ).rows[0],
  );
  // Knowledge spend is one aggregate, rounded as a whole under the registered pricing.
  const { round } = creditPricing();
  const knowledgeUsed = round(BigInt(sums.known));
  const totals = {
    used: (BigInt(sums.used) + knowledgeUsed).toString(),
    held: (BigInt(sums.held) + round(BigInt(sums.known) + BigInt(sums.pending)) - knowledgeUsed).toString(),
    unfunded: sums.unfunded,
  };
  const usage = `
    SELECT model_id,agent_id,activity,charged,created_at AS occurred_at FROM ${table(tx, 'tf_credit_usage')} WHERE created_at >= ${periodStart}
    UNION ALL
    SELECT a.model_id,NULL::uuid AS agent_id,'knowledge-' || a.purpose AS activity,o.charged,o.observed_at AS occurred_at
    FROM ${table(tx, 'tf_knowledge_credit_observations')} o JOIN ${table(tx, 'tf_knowledge_credit_attempts')} a ON a.id=o.attempt_id WHERE o.observed_at >= ${periodStart}`;
  const { days, breakdown, series } = await usageRows(tx, usage, []);
  return creditSummarySchema.parse({
    ...(view ? { scope: view.kind } : {}),
    ...balance,
    used: credits(totals.used),
    held: credits(totals.held),
    unfunded: credits(totals.unfunded),
    days,
    breakdown,
    series,
  });
}

async function usageRows(tx: Transaction, activity: string, values: unknown[]) {
  const days = z
    .array(z.object({ date: z.string(), amount: units }))
    .parse(
      (
        await tx.client.query(
          `WITH activity AS (${activity}) SELECT to_char(day,'YYYY-MM-DD') AS date, COALESCE(sum(u.charged),0)::text AS amount FROM generate_series((clock_timestamp() AT TIME ZONE 'UTC')::date-29, (clock_timestamp() AT TIME ZONE 'UTC')::date, interval '1 day') day LEFT JOIN activity u ON (u.occurred_at AT TIME ZONE 'UTC')::date=day::date GROUP BY day ORDER BY day`,
          values,
        )
      ).rows,
    );
  const breakdown = z
    .array(
      z.object({
        model_id: z.string(),
        agent_id: z.string().nullable(),
        activity: creditActivitySchema,
        amount: units,
        calls: z.number().int(),
      }),
    )
    .parse(
      (
        await tx.client.query(
          `WITH activity AS (${activity}) SELECT model_id,agent_id,activity,COALESCE(sum(charged),0)::text AS amount,count(*)::integer AS calls FROM activity GROUP BY model_id,agent_id,activity ORDER BY sum(charged) DESC NULLS LAST,model_id,agent_id,activity`,
          values,
        )
      ).rows,
    );
  const series = z
    .array(
      z.object({
        date: z.string(),
        model_id: z.string(),
        agent_id: z.string().nullable(),
        activity: creditActivitySchema,
        amount: units,
        calls: z.number().int(),
      }),
    )
    .parse(
      (
        await tx.client.query(
          `WITH activity AS (${activity}) SELECT to_char((occurred_at AT TIME ZONE 'UTC')::date,'YYYY-MM-DD') AS date,model_id,agent_id,activity,COALESCE(sum(charged),0)::text AS amount,count(*)::integer AS calls FROM activity GROUP BY 1,2,3,4 ORDER BY 1,2,3,4`,
          values,
        )
      ).rows,
    );
  return {
    days: days.map(day => ({ date: day.date, credits: credits(day.amount) })),
    breakdown: breakdown.map(entry => ({
      modelId: entry.model_id,
      agentId: entry.agent_id,
      activity: entry.activity,
      credits: credits(entry.amount),
      calls: entry.calls,
    })),
    series: series.map(entry => ({
      date: entry.date,
      modelId: entry.model_id,
      agentId: entry.agent_id,
      activity: entry.activity,
      credits: credits(entry.amount),
      calls: entry.calls,
    })),
  };
}
