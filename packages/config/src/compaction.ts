// Shipped catalog names, so browser bundles never load the server catalog. The server approves summary families from
// the effective catalog with `compactionModelFamilies`.
import modelFamilies from './model-families.json' with { type: 'json' };

const shippedRoles = (family: (typeof modelFamilies)[number]): readonly string[] =>
  'roles' in family ? family.roles : [];

// Shipped families approved for summary work: those with the compaction role.
export const compactionBudgetFamilies = Object.freeze(
  modelFamilies
    .filter(family => shippedRoles(family).includes('compaction'))
    .map(family => Object.freeze({ id: family.id, name: family.name })),
);

export const compactionDefaults = Object.freeze({
  automatic: true,
  triggerPercent: 70,
  targetPercent: 30,
  fallbackFamilyId: null as string | null,
  outputPrompt: null as string | null,
});
