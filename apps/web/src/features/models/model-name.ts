import { planModelNameFromId, planModelOfFamily } from '@tulipfarm/config/plan-models';

/**
 * The versioned name of model family `id`: its catalog name, or for a plan model the catalog no longer offers, such as
 * one from a disconnected plan, the name its id carries. Other unknown ids show as they are.
 */
export function modelName(families: readonly { id: string; displayName: string }[] | undefined, id: string): string {
  const listed = families?.find(family => family.id === id)?.displayName;
  if (listed) return listed;
  // Catalog plan families such as `chatgpt-sol` decode to a model id without a version; only derived ids carry one.
  const plan = planModelOfFamily(id);
  return plan && /\d/.test(plan.model) ? planModelNameFromId(plan.model) : id;
}
