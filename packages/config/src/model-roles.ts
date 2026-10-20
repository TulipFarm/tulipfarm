import { z } from 'zod';

/**
 * Features that pick a model family without the person choosing one. A catalog family lists the roles it can fill; the
 * default for a role is the first family in catalog order that lists it and is in `MODEL_FAMILIES`.
 */
export const modelRoles = Object.freeze([
  'default-chat',
  'title',
  'compaction',
  'review',
  'plan',
  'heartbeat',
  'public-guide',
] as const);
export type ModelRole = (typeof modelRoles)[number];
export const modelRoleSchema = z.enum(modelRoles);

export const modelRolesSchema = z
  .array(modelRoleSchema)
  .readonly()
  .refine(roles => new Set(roles).size === roles.length, 'Duplicate role')
  .describe(
    'Features this family is a default for: default-chat, title, compaction, review, plan, heartbeat, public-guide. The first family in catalog order that has the role and is in MODEL_FAMILIES fills it.',
  );

/** Settings that pin a role to one family, overriding the catalog. */
export const modelRoleSettings = Object.freeze({
  title: 'CHAT_TITLE_MODEL_FAMILY',
  review: 'SKILL_REVIEW_MODEL_FAMILY',
  plan: 'PLAN_SPECIALIST_MODEL_FAMILY',
  heartbeat: 'GMAIL_HEARTBEAT_MODEL_FAMILY',
  'public-guide': 'PUBLIC_GUIDE_MODEL_FAMILY',
} as const satisfies Partial<Record<ModelRole, string>>);
