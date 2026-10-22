import type { CompactionPolicy, CompactionPolicyCommand } from './compaction-api';

export type CompactionDraft = {
  automatic: boolean;
  trigger: string;
  target: string;
  model: string;
  fallback: string;
  prompt: string;
};
export type CompactionErrors = Partial<Record<'trigger' | 'target' | 'model' | 'fallback' | 'prompt', string>>;

export function compactionDraft(policy: CompactionPolicy): CompactionDraft {
  return {
    automatic: policy.automatic,
    trigger: String(policy.triggerPercent),
    target: String(policy.targetPercent),
    model: policy.modelFamilyId,
    fallback: policy.fallbackFamilyId ?? '',
    prompt: policy.outputPrompt ?? '',
  };
}

const whole = (value: string) => (/^\d{1,2}$/u.test(value.trim()) ? Number(value) : null);

/** Field errors phrased as the fix. An empty object means the draft can be saved. */
export function compactionErrors(
  draft: CompactionDraft,
  families: CompactionPolicy['budgetFamilies'],
): CompactionErrors {
  const errors: CompactionErrors = {};
  const trigger = whole(draft.trigger);
  const target = whole(draft.target);
  const usable = (id: string) => families.some(family => family.id === id && family.enabled);
  if (trigger === null || trigger < 2 || trigger > 99) errors.trigger = 'Enter a whole percent from 2 to 99.';
  if (target === null || target < 1 || target > 98) errors.target = 'Enter a whole percent from 1 to 98.';
  else if (trigger !== null && !errors.trigger && target >= trigger)
    errors.target = 'Enter a percent lower than the trigger.';
  if (!usable(draft.model)) errors.model = 'Choose an available summary model.';
  if (draft.fallback && !usable(draft.fallback)) errors.fallback = 'Choose an available fallback, or no fallback.';
  else if (draft.fallback && draft.fallback === draft.model)
    errors.fallback = 'Choose a different model than the summary model, or no fallback.';
  if (draft.prompt.trim().length > 2000) errors.prompt = 'Keep handoff instructions under 2,000 characters.';
  return errors;
}

export function compactionCommand(draft: CompactionDraft, expectedRevision: number): CompactionPolicyCommand {
  const prompt = draft.prompt.trim();
  return {
    requestId: crypto.randomUUID(),
    expectedRevision,
    automatic: draft.automatic,
    triggerPercent: Number(draft.trigger),
    targetPercent: Number(draft.target),
    modelFamilyId: draft.model as CompactionPolicyCommand['modelFamilyId'],
    fallbackFamilyId: (draft.fallback || null) as CompactionPolicyCommand['fallbackFamilyId'],
    outputPrompt: prompt || null,
  };
}
