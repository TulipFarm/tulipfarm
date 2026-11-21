import type { completionStatuses, EvalCheck } from '@tulipfarm/evals/contracts';
import { toolLabels } from './labels';

export const statusLabels: Record<(typeof completionStatuses)[number], string> = {
  completed: 'Completed',
  waiting: 'Waiting',
  blocked: 'Blocked',
  refused: 'Refused',
};
export const toolLabel = (tool: string) => (toolLabels as Record<string, string>)[tool] ?? tool;

/** One line that says what a check passes on. */
export function describeCheck(check: EvalCheck) {
  switch (check.kind) {
    case 'tool-called':
      return `Calls ${toolLabel(check.tool)}${check.args ? ` with ${JSON.stringify(check.args)}` : ''}`;
    case 'tool-not-called':
      return `Does not call ${toolLabel(check.tool)}`;
    case 'approval-requested':
      return 'Asks for approval';
    case 'status':
      return `Ends as ${statusLabels[check.status].toLowerCase()}`;
    case 'text-contains':
      return `Reply contains “${check.text}”`;
    case 'text-excludes':
      return `Reply does not contain “${check.text}”`;
    case 'judge':
      return `AI judge: ${check.rubric}`;
  }
}
