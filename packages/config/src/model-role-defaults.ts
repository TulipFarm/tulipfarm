import { modelFamilies } from './model-continuity.ts';
import { modelRoles, modelRoleSettings, type ModelRole } from './model-roles.ts';

export type ModelRoleDefault = {
  familyId: string;
  /** `setting`: pinned by the role's setting; `catalog`: a family with the role; `fallback`: no enabled family has it. */
  source: 'setting' | 'catalog' | 'fallback';
};

type RoleSettingRole = keyof typeof modelRoleSettings;

/** Static reads, so the settings registry check sees each variable `modelRoleSettings` names. */
const roleSettingValues: Record<RoleSettingRole, (env: NodeJS.ProcessEnv) => string | undefined> = {
  title: env => env.CHAT_TITLE_MODEL_FAMILY,
  review: env => env.SKILL_REVIEW_MODEL_FAMILY,
  plan: env => env.PLAN_SPECIALIST_MODEL_FAMILY,
  heartbeat: env => env.GMAIL_HEARTBEAT_MODEL_FAMILY,
  'public-guide': env => env.PUBLIC_GUIDE_MODEL_FAMILY,
};

/** Families named by `MODEL_FAMILIES`, in catalog order. */
function enabledFamilies(env: NodeJS.ProcessEnv) {
  const enabled = new Set((env.MODEL_FAMILIES ?? '').split(',').map(value => value.trim()));
  return modelFamilies.filter(family => enabled.has(family.id));
}

/** Families named by `MODEL_PAUSED_FAMILIES`: still served, but closed to new chats, new agents and model changes. */
export function pausedModelFamilies(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return new Set(
    (env.MODEL_PAUSED_FAMILIES ?? '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
  );
}

/** Families of the effective catalog that have `role`, in catalog order. */
export function modelRoleFamilies(role: ModelRole) {
  return modelFamilies.filter(family => family.roles?.includes(role));
}

/**
 * The family a feature uses when nothing chose one: the role's setting, else the first family in catalog order that has
 * the role and is in `MODEL_FAMILIES`. A role no enabled family has falls back to the default chat family, and the
 * default chat role to the first enabled family. Titles have no fallback; the chat model titles its chat. Null when no
 * model family is enabled.
 */
export function modelRoleDefault(role: ModelRole, env: NodeJS.ProcessEnv = process.env): ModelRoleDefault | null {
  const setting = role in roleSettingValues ? roleSettingValues[role as RoleSettingRole](env) : undefined;
  if (setting?.trim()) return { familyId: setting.trim(), source: 'setting' };
  const paused = pausedModelFamilies(env);
  // New chats start on the default chat family, so a paused family cannot fill that role.
  const enabled = enabledFamilies(env).filter(family => role !== 'default-chat' || !paused.has(family.id));
  const declared = enabled.find(family => family.roles?.includes(role));
  if (declared) return { familyId: declared.id, source: 'catalog' };
  if (role === 'title') return null;
  const fallback = role === 'default-chat' ? enabled[0]?.id : modelRoleDefault('default-chat', env)?.familyId;
  return fallback ? { familyId: fallback, source: 'fallback' } : null;
}

/** Startup warnings for roles that no enabled family fills, or whose setting names a family outside `MODEL_FAMILIES`. */
export function modelRoleWarnings(
  env: NodeJS.ProcessEnv = process.env,
  roles: readonly ModelRole[] = modelRoles,
): string[] {
  const enabled = enabledFamilies(env).map(family => family.id);
  if (!enabled.length) return [];
  return roles.flatMap(role => {
    const selected = modelRoleDefault(role, env);
    if (selected?.source === 'setting' && !enabled.includes(selected.familyId))
      return [
        `${modelRoleSettings[role as RoleSettingRole]}=${selected.familyId} is not in MODEL_FAMILIES; ${role === 'title' ? 'chats are titled by their chat model' : `the ${role} role has no model`}.`,
      ];
    if (selected?.source === 'catalog' || selected?.source === 'setting') return [];
    const missing = `No family in MODEL_FAMILIES has the catalog role "${role}"`;
    return [
      selected
        ? `${missing}; using ${selected.familyId}. Add "${role}" to a family's roles to choose one.`
        : `${missing}; chats are titled by their chat model.`,
    ];
  });
}

/**
 * Families approved for summary work: those with the compaction role. When no enabled family has the role, the
 * compaction fallback is approved too, so summaries still have a model.
 */
export function compactionModelFamilies(env: NodeJS.ProcessEnv = process.env) {
  const declared = modelRoleFamilies('compaction');
  const selected = modelRoleDefault('compaction', env)?.familyId;
  const fallback = declared.some(family => family.id === selected)
    ? []
    : modelFamilies.filter(family => family.id === selected);
  return [...declared, ...fallback].map(family => Object.freeze({ id: family.id, name: family.name }));
}

/** The summary family of a workspace that has not chosen one. */
export function compactionDefaultFamily(env: NodeJS.ProcessEnv = process.env): string {
  return modelRoleDefault('compaction', env)?.familyId ?? compactionModelFamilies(env)[0]?.id ?? modelFamilies[0]!.id;
}
