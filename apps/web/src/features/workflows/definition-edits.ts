import { stepValues, type Definition } from '@tulipfarm/workflows/contracts';

type Steps = Definition['steps'];
type Step = Steps[number];
type Label = (step: Step, index: number) => string;
export type Arranged = { steps: Steps; notice: string | null };

/** Reads a typed fixed value. Numbers and true or false keep their JSON type, so a condition compares 100 by value; anything else stays text. */
export function typedLiteral(text: string): string | number | boolean {
  const trimmed = text.trim();
  if (trimmed === 'true' || trimmed === 'false') return trimmed === 'true';
  return trimmed !== '' && /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed) && Number.isFinite(Number(trimmed))
    ? Number(trimmed)
    : text;
}

/** Splits a nested field path written as contract / start_date. */
export function fieldPath(text: string) {
  if (text.trim().startsWith('[')) {
    try {
      const path: unknown = JSON.parse(text);
      if (Array.isArray(path) && path.every(part => typeof part === 'string')) return path;
    } catch {
      /* Incomplete JSON stays visible while the person types. */
    }
  }
  return text
    .split('/')
    .map(part => part.trim())
    .filter(Boolean)
    .slice(0, 16);
}

const list = (parts: string[]) =>
  parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts.join('');

/** Drops branch targets that are gone or no longer come later, and names steps whose values now read a missing or later step. Those values are kept, so saving stays blocked until someone chooses another source. */
function settle(steps: Steps, label: Label): Arranged {
  const position = new Map(steps.map((step, index) => [step.id, index]));
  const after = (index: number) => (id: string) => (position.get(id) ?? -1) > index;
  const released: string[] = [];
  const settled = steps.map((step, index) => {
    if (step.kind !== 'condition') return step;
    const ifMet = step.ifMet.filter(after(index)),
      otherwise = step.otherwise.filter(after(index));
    if (ifMet.length === step.ifMet.length && otherwise.length === step.otherwise.length) return step;
    released.push(label(step, index));
    return { ...step, ifMet, otherwise };
  });
  const stale = settled.flatMap((step, index) =>
    stepValues(step).some(value => value.kind === 'step' && !((position.get(value.step) ?? index) < index))
      ? [label(step, index)]
      : [],
  );
  const notice = [
    released.length
      ? `${list(released)} no longer ${released.length > 1 ? 'control' : 'controls'} steps that were removed or now come before ${released.length > 1 ? 'them' : 'it'}.`
      : '',
    stale.length
      ? `${list(stale)} ${stale.length > 1 ? 'read' : 'reads'} the output of a removed or later step. Choose another source before saving.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  return { steps: settled, notice: notice || null };
}

export function removeStep(steps: Steps, index: number, label: Label): Arranged {
  return settle(
    steps.filter((_, position) => position !== index),
    label,
  );
}

export function moveStep(steps: Steps, index: number, offset: -1 | 1, label: Label): Arranged {
  const next = [...steps];
  const [moved] = next.splice(index, 1);
  if (!moved) return { steps, notice: null };
  next.splice(index + offset, 0, moved);
  return settle(next, label);
}
