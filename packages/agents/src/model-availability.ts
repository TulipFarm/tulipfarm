import { z } from 'zod';
import {
  equivalentPlanFamilyIds,
  isByokProvider,
  isPlanProvider,
  loadModelCatalog,
  planCatalogModel,
  planModelFamilyId,
  planModelName,
  planModelOfFamily,
  planProviderNames,
  readModelCatalog,
  type PlanProvider,
  type ServedModelCatalog,
} from '@tulipfarm/config';
import { isFeatureEnabled } from '@tulipfarm/observability';
import { workspaceIdFromSchema } from '@tulipfarm/workspace-storage/runtime';
import { relation, type AgentTransaction } from './store.ts';
import { modelAvailabilitySchema } from './model-policy-contracts.ts';

/**
 * The workspace's model availability. `familyIds` may name models a member's plan lists that the catalog does not, such
 * as one an agent prefers; each is included while the catalog offers its plan.
 */
export async function modelAvailability(tx: AgentTransaction, familyIds: readonly string[] = []) {
  const rows = z
    .array(modelAvailabilitySchema.extend({ lastDisabledRevision: z.number().int().nonnegative() }))
    .parse(
      (
        await tx.client.query(
          `SELECT family_id AS "familyId", enabled, revision, last_disabled_revision AS "lastDisabledRevision" FROM ${relation(tx, 'tf_model_availability')}`,
        )
      ).rows,
    );
  // Every catalog model and image model, served or not, so workspace choices survive a missing key.
  const { catalog } = readModelCatalog();
  const flaggedOff = await flaggedOffModels(tx);
  const plans = catalogPlans();
  const offered = (provider: string) => !isPlanProvider(provider) || plans.has(provider);
  const named = new Set([...catalog.models, ...catalog.imageModels].map(family => family.id));
  const planListed = familyIds.filter(id => {
    const plan = named.has(id) ? null : planModelOfFamily(id);
    return plan !== null && plans.has(plan.provider);
  });
  return [
    ...[...catalog.models, ...catalog.imageModels]
      .filter(family => !flaggedOff.has(family.id))
      .filter(family => !('routes' in family) || family.routes.every(route => offered(route.provider)))
      .map(
        family =>
          rows.find(row => row.familyId === family.id) ?? {
            familyId: family.id,
            enabled: true,
            revision: 0,
            lastDisabledRevision: 0,
          },
      ),
    ...[...new Set(planListed)].map(familyId => {
      const aliases = equivalentPlanFamilyIds(familyId);
      const matching = rows.filter(row => aliases.includes(row.familyId));
      const disabled = matching.find(row => !row.enabled);
      const found = disabled ?? matching.find(row => row.familyId === familyId) ?? matching[0];
      return found
        ? { ...found, familyId }
        : {
            familyId,
            enabled: true,
            revision: 0,
            lastDisabledRevision: 0,
          };
    }),
  ];
}

/**
 * Catalog models and image models whose `featureFlag` is off for the transaction's workspace. They are left out of the
 * workspace's model availability, so they are hidden, cannot be turned on and no work runs on them.
 */
export async function flaggedOffModels(tx: Pick<AgentTransaction, 'schema'>): Promise<Set<string>> {
  const { catalog } = readModelCatalog();
  const flagged = [...catalog.models, ...catalog.imageModels].filter(model => model.featureFlag);
  if (!flagged.length) return new Set();
  const workspace = { id: workspaceIdFromSchema(tx.schema) };
  const flags = [...new Set(flagged.map(model => model.featureFlag!))];
  const on = new Set(
    (
      await Promise.all(flags.map(async flag => ((await isFeatureEnabled(flag, null, workspace)) ? flag : null)))
    ).filter(Boolean),
  );
  return new Set(flagged.filter(model => !on.has(model.featureFlag!)).map(model => model.id));
}

/** All member-connected model providers (subscription plans and BYOK API keys) are offered dynamically. */
export function catalogPlans(): Set<PlanProvider> {
  return new Set(planProviderNames);
}

const subscriptionConnectionRow = z.object({
  id: z.string(),
  provider: z.enum(planProviderNames),
  email: z.string().nullable(),
  plan: z.string().nullable(),
  models: z.unknown(),
  disabled_models: z.array(z.string()),
  rank: z.coerce.number().int(),
});

const storedSubscriptionModels = z.array(
  z
    .object({
      slug: z.string().min(1),
      label: z.string(),
      maxInputTokens: z.number().int().positive().optional(),
      maxOutputTokens: z.number().int().positive().optional(),
      imageInput: z.boolean().optional(),
    })
    .loose(),
);

const planAccountsMigration = 89;

async function memberConnectedPlanModels(tx: AgentTransaction, membershipId: string | null) {
  const commonVersion = (tx as { commonVersion?: number }).commonVersion ?? 0;
  if (commonVersion < 64) return { connections: [], models: [] };
  const connectionsTable = relation(tx, 'tf_subscription_connections');
  const grantsTable = relation(tx, 'tf_subscription_grants');
  const membershipsTable = relation(tx, 'tf_memberships');
  const teamsTable = relation(tx, 'tf_member_teams');
  const rankExpr = `MIN(CASE
    WHEN c.owner_membership_id = $1::uuid THEN 1
    WHEN g.membership_id = $1::uuid THEN 2
    WHEN g.team_id IN (SELECT team_id FROM ${teamsTable} WHERE membership_id = $1::uuid) THEN 3
    WHEN g.grantee = 'workspace' THEN 4
  END)`;
  const useChatFilter = commonVersion >= planAccountsMigration ? 'AND c.use_for_chat' : '';
  const rows = await tx.client.query(
    `SELECT c.id, c.provider, c.email, c.plan, c.models, c.disabled_models, ${rankExpr} AS rank
       FROM ${connectionsTable} c
       JOIN ${membershipsTable} m ON m.id = c.owner_membership_id AND m.removed_at IS NULL
       LEFT JOIN ${grantsTable} g ON g.connection_id = c.id
      WHERE c.state = 'connected' ${useChatFilter}
      GROUP BY c.id
     HAVING ${rankExpr} IS NOT NULL
      ORDER BY rank, c.provider, c.created_at`,
    [membershipId],
  );
  const rawCatalog = readModelCatalog().catalog;
  const disabledAvailability = new Set(
    z
      .array(z.object({ familyId: z.string(), enabled: z.boolean() }))
      .parse(
        (
          await tx.client.query(
            `SELECT family_id AS "familyId", enabled FROM ${relation(tx, 'tf_model_availability')} WHERE NOT enabled`,
          )
        ).rows,
      )
      .map(row => row.familyId),
  );
  const byId = new Map<
    string,
    {
      id: string;
      name: string;
      vendor: string;
      provider: PlanProvider;
      source: 'subscription' | 'byok';
      speed: 'fast' | 'balanced' | 'deliberate';
      quality: 'standard' | 'high' | 'frontier';
      usdPerMillionTokens: null;
      default: false;
    }
  >();
  const connections: {
    provider: PlanProvider;
    source: 'subscription' | 'byok';
    account: string | null;
    plan: string | null;
    own: boolean;
    modelCount: number;
  }[] = [];

  for (const raw of rows.rows) {
    const parsed = subscriptionConnectionRow.safeParse(raw);
    if (!parsed.success) continue;
    const row = parsed.data;
    const listed = storedSubscriptionModels.safeParse(row.models).data ?? [];
    const enabledModels = listed.filter(item => !row.disabled_models.includes(item.slug));
    if (listed.length && !enabledModels.length) continue;
    const source = isByokProvider(row.provider) ? 'byok' : 'subscription';
    connections.push({
      provider: row.provider,
      source,
      account: row.email,
      plan: row.plan,
      own: row.rank === 1,
      modelCount: enabledModels.length,
    });
    for (const item of enabledModels) {
      const id = planModelFamilyId(row.provider, item.slug, row.id);
      if (!id || byId.has(id) || equivalentPlanFamilyIds(id).some(alias => disabledAvailability.has(alias))) continue;
      const built = planCatalogModel(rawCatalog, row.provider, item.slug, item.label, {
        maxInputTokens: item.maxInputTokens ?? null,
        maxOutputTokens: item.maxOutputTokens ?? null,
        imageInput: item.imageInput ?? null,
        connectionId: row.id,
      });
      if (!built) continue;
      byId.set(id, {
        id,
        name: planModelName(item.slug, item.label),
        vendor: built.vendor,
        provider: row.provider,
        source,
        speed: built.speed === 3 ? 'fast' : built.speed === 1 ? 'deliberate' : 'balanced',
        quality: built.quality === 3 ? 'frontier' : built.quality === 2 ? 'high' : 'standard',
        usdPerMillionTokens: null,
        default: false,
      });
    }
  }
  return { connections, models: [...byId.values()] };
}

/**
 * Models a new agent may prefer: selectable, served, unpaused and on for the workspace, plus live models from the
 * member's connected subscription plans and BYOK API keys. Chat recommends one from these to fit the agent's job;
 * `default` marks the model new agents use when none is chosen.
 */
export async function agentModelContext(
  tx: AgentTransaction,
  catalog: ServedModelCatalog = loadModelCatalog(),
  membershipId: string | null = null,
) {
  const enabled = new Set((await modelAvailability(tx)).filter(row => row.enabled).map(row => row.familyId));
  const workspaceModels = catalog.models
    .filter(model => model.selectable && !model.paused && enabled.has(model.id))
    .map(model => {
      const rate =
        model.pricing === 'unmetered' ? undefined : model.rates.find(item => item.promptTokensAbove === null);
      return {
        id: model.id,
        name: model.name,
        vendor: model.vendor,
        provider: model.route.type,
        source: 'workspace' as const,
        speed: model.speed,
        quality: model.quality,
        usdPerMillionTokens: rate
          ? { input: rate.usdPerMillionTokens.input, output: rate.usdPerMillionTokens.output }
          : null,
        default: model.id === catalog.defaultModel.id,
      };
    });
  const memberPlans = await memberConnectedPlanModels(tx, membershipId);
  return {
    choices: [...workspaceModels, ...memberPlans.models],
    connectedPlans: memberPlans.connections,
  };
}

export async function agentModelChoices(
  tx: AgentTransaction,
  catalog: ServedModelCatalog = loadModelCatalog(),
  membershipId: string | null = null,
) {
  return (await agentModelContext(tx, catalog, membershipId)).choices;
}

const inventoryByokModelLimit = 80;

/**
 * Compact summary of available models and connected plans/API keys for general chat context (`workspaceInventory`).
 * Caps BYOK models if a gateway (such as OpenRouter) lists hundreds, while always reporting the full connection count.
 */
export async function memberModelInventory(tx: AgentTransaction, membershipId: string | null) {
  let workspaceModels: {
    id: string;
    name: string;
    vendor: string;
    provider: string;
    source: 'workspace';
    default: boolean;
  }[] = [];
  try {
    const catalog = loadModelCatalog();
    const enabled = new Set((await modelAvailability(tx)).filter(row => row.enabled).map(row => row.familyId));
    workspaceModels = catalog.models
      .filter(model => model.selectable && !model.paused && enabled.has(model.id))
      .map(model => ({
        id: model.id,
        name: model.name,
        vendor: model.vendor,
        provider: model.route.type,
        source: 'workspace' as const,
        default: model.id === catalog.defaultModel.id,
      }));
  } catch {
    workspaceModels = [];
  }
  const { connections, models: planModels } = await memberConnectedPlanModels(tx, membershipId);
  const subscriptionModels = planModels.filter(model => model.source === 'subscription');
  const byokModels = planModels.filter(model => model.source === 'byok');
  const cappedByok = byokModels.slice(0, inventoryByokModelLimit);
  return {
    connectedPlans: connections,
    models: [
      ...workspaceModels,
      ...subscriptionModels.map(({ id, name, vendor, provider, source }) => ({
        id,
        name,
        vendor,
        provider,
        source,
        default: false,
      })),
      ...cappedByok.map(({ id, name, vendor, provider, source }) => ({
        id,
        name,
        vendor,
        provider,
        source,
        default: false,
      })),
    ],
    ...(byokModels.length > inventoryByokModelLimit
      ? {
          truncatedByokModels: byokModels.length - inventoryByokModelLimit,
          note: `${byokModels.length - inventoryByokModelLimit} additional BYOK models are omitted from this compact list; call agents.context for the full list.`,
        }
      : {}),
  };
}

export async function modelFamilyEnabled(tx: AgentTransaction, familyId: string) {
  return (await modelAvailability(tx, [familyId])).some(row => row.familyId === familyId && row.enabled);
}

/**
 * Whether a plan step can run on `familyId`: the catalog serves it unpaused and the workspace has not turned it off.
 * A step that names a family never falls back to another.
 */
export async function stepFamilyAvailable(
  tx: AgentTransaction,
  familyId: string,
  catalog: Pick<ServedModelCatalog, 'model'> = loadModelCatalog(),
) {
  const served = catalog.model(familyId);
  // A specialist step calls deployment routes and carries no member's plan token, so it cannot run on a plan model.
  if (served && isPlanProvider(served.route.type)) return false;
  return Boolean(served && !served.paused) && (await modelFamilyEnabled(tx, familyId));
}

/**
 * The family that serves an existing agent or chat in place of the paused `familyId`: the workspace fallback rule's
 * target, when the workspace enables it and the operator has not paused it too. Null keeps the paused family.
 */
export async function pausedFamilyReplacement(
  tx: AgentTransaction,
  familyId: string,
  paused: (familyId: string) => boolean,
): Promise<string | null> {
  if (!paused(familyId)) return null;
  const target = z
    .object({ target_family_id: z.string().nullable() })
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT target_family_id FROM ${relation(tx, 'tf_model_fallback_rules')} WHERE source_family_id=$1`,
          [familyId],
        )
      ).rows[0],
    )?.target_family_id;
  if (!target || paused(target)) return null;
  return (await modelFamilyEnabled(tx, target)) ? target : null;
}
