type TaskLimits = { toolCalls: number; activeMilliseconds: number; credits: number };
type LimitKey = keyof TaskLimits;
export type LimitDraft = Record<LimitKey, string>;

export const defaultTaskLimits: TaskLimits = { toolCalls: 100, activeMilliseconds: 300000, credits: 100 };
type LimitErrors = Partial<Record<LimitKey, string>>;

export const taskLimitFields = [
  { key: 'toolCalls', label: 'Tool call limit', unit: 'tool calls', min: 1, max: 1000, storedPerShown: 1 },
  { key: 'credits', label: 'Credit limit', unit: 'credits', min: 1, max: 10000, storedPerShown: 1 },
  {
    key: 'activeMilliseconds',
    label: 'Active seconds limit',
    unit: 'seconds',
    min: 1,
    max: 3600,
    storedPerShown: 1000,
  },
] as const;
type LimitField = (typeof taskLimitFields)[number];

type LimitMode = { kind: 'start' } | { kind: 'reply'; task: { limits: TaskLimits } };
type TaskUsage = {
  limits: TaskLimits;
  toolCalls: number;
  activeMilliseconds: string;
  cost: { chargedCreditUnits: string };
};
const creditUnitsPerCredit = 1_000_000_000_000n;

export function reachedTaskLimits(task: TaskUsage): LimitField[] {
  const used = {
    toolCalls: BigInt(task.toolCalls),
    credits: BigInt(task.cost.chargedCreditUnits),
    activeMilliseconds: BigInt(task.activeMilliseconds),
  };
  return taskLimitFields.filter(
    field => used[field.key] >= BigInt(task.limits[field.key]) * (field.key === 'credits' ? creditUnitsPerCredit : 1n),
  );
}

export function limitRange(field: LimitField, mode: LimitMode) {
  return {
    min: mode.kind === 'reply' ? Math.ceil(mode.task.limits[field.key] / field.storedPerShown) : field.min,
    max: field.max,
  };
}

export function parseLimits(
  draft: LimitDraft,
  mode: LimitMode,
): { ok: true; limits: TaskLimits } | { ok: false; errors: LimitErrors } {
  const errors: LimitErrors = {};
  const limits = { toolCalls: 0, credits: 0, activeMilliseconds: 0 };
  for (const field of taskLimitFields) {
    const { min, max } = limitRange(field, mode);
    const value = Number(draft[field.key]);
    if (!Number.isInteger(value) || value < min || value > max)
      errors[field.key] = `Use ${count(min)} to ${count(max)} ${field.unit}.`;
    else limits[field.key] = value * field.storedPerShown;
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, limits };
}

export function limitDraft(limits: TaskLimits): LimitDraft {
  const draft = { toolCalls: '', credits: '', activeMilliseconds: '' };
  for (const field of taskLimitFields) draft[field.key] = String(limits[field.key] / field.storedPerShown);
  return draft;
}

function count(value: number) {
  return value.toLocaleString('en-US');
}
