import type { Definition } from '@tulipfarm/workflows/contracts';
import { removeStep } from './definition-edits.ts';

type Steps = Definition['steps'];
type CodeStep = Extract<Steps[number], { kind: 'code' }>;

export const maxSteps = 32;
export const maxCodeSource = 32768;

/** The size the server checks: the source's bytes once written as a JSON string. */
export function codeSourceBytes(source: string) {
  return new TextEncoder().encode(JSON.stringify(source)).length;
}

/** The first free ID of the form code, code_2, code_3… */
export function codeStepId(taken: readonly string[]) {
  const used = new Set(taken);
  if (!used.has('code')) return 'code';
  let next = 2;
  while (used.has(`code_${next}`)) next++;
  return `code_${next}`;
}

export function addCodeStep(steps: Steps, step: CodeStep): Steps {
  return [...steps, step];
}

export function replaceCodeStep(steps: Steps, id: string, step: CodeStep): Steps {
  return steps.map(current => (current.id === id && current.kind === 'code' ? step : current));
}

/** Removes the step and drops it from any condition's branch lists. */
export function removeCodeStep(steps: Steps, id: string): Steps {
  const index = steps.findIndex(step => step.id === id);
  return index < 0 ? steps : removeStep(steps, index, step => step.id).steps;
}
