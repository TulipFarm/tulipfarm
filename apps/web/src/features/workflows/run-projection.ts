import {
  conditionOutputSchema,
  stepGates,
  unfinishedStatuses,
  withheldOutputSchema,
  type RunDetail,
} from '@tulipfarm/workflows/contracts';
import type { WorkflowStepState } from '../../components/workflow-diagram.tsx';

export function workflowRunStates({
  definition,
  run,
}: Pick<RunDetail, 'definition' | 'run'>): Record<string, WorkflowStepState> {
  const live = unfinishedStatuses.some(status => status === run.status);
  const receipts = new Map(run.steps.map(receipt => [receipt.stepId, receipt]));
  const choices = new Map<string, string>();
  const gates = stepGates(definition.steps);
  const states: Record<string, WorkflowStepState> = {
    $trigger: run.status === 'skipped' ? 'unknown' : run.startedAt || run.steps.length ? 'completed' : 'pending',
  };
  let next = live && run.status !== 'queued';
  for (const step of definition.steps) {
    const receipt = receipts.get(step.id);
    if (receipt) {
      const withheld = withheldOutputSchema.safeParse(receipt.output).success;
      states[step.id] = withheld ? 'withheld' : receipt.status;
      if (receipt.status === 'waiting') next = false;
      if (step.kind === 'condition' && receipt.status === 'completed') {
        const outcome = conditionOutputSchema.safeParse(receipt.output);
        const same = (a: string[], b: string[]) => a.length === b.length && a.every(id => b.includes(id));
        if (
          outcome.success &&
          same(outcome.data.ran, outcome.data.matched ? step.ifMet : step.otherwise) &&
          same(outcome.data.skipped, outcome.data.matched ? step.otherwise : step.ifMet)
        ) {
          choices.set(step.id, outcome.data.matched ? 'ifMet' : 'otherwise');
        } else next = false;
      }
      continue;
    }
    const required = [...(gates.get(step.id) ?? [])].map(gate => gate.split(':'));
    if (required.some(([id, branch]) => choices.has(id!) && choices.get(id!) !== branch)) {
      states[step.id] = 'skipped';
      continue;
    }
    const eligible = required.every(([id, branch]) => choices.get(id!) === branch);
    states[step.id] = next && eligible ? 'next' : live ? 'pending' : 'unknown';
    next = false;
  }
  return states;
}
