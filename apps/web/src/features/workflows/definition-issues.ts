import { z } from 'zod';

const fieldFixes: Record<string, string> = {
  name: 'Enter a workflow name.',
  id: 'Use a step ID that starts with a lowercase letter and uses only lowercase letters, numbers, and underscores.',
  tableId: 'Choose a table.',
  url: 'Enter a valid HTTPS URL.',
  prompt: 'Enter the question or prompt.',
  source: 'Enter the code.',
  seconds: 'Enter a valid wait length.',
  at: 'Choose a valid date source.',
  agentId: 'Choose an agent.',
  integrationId: 'Choose an integration for the credential.',
  header: 'Use a lowercase header name with letters, numbers, and hyphens.',
  limit: 'Choose how many rows to find, from 1 to 50.',
  fields: 'Map at least one field.',
};

const fieldNames: Record<string, string> = {
  trigger: 'trigger',
  when: 'condition',
  ifMet: 'steps to run when the condition is met',
  otherwise: 'steps to run otherwise',
  filters: 'filters',
  row: 'row to update',
  input: 'input',
  body: 'request body',
  headers: 'request headers',
  credential: 'credential',
  method: 'request method',
  timeoutSeconds: 'answer deadline',
  limits: 'agent limits',
  left: 'value to compare',
  right: 'comparison value',
};

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

function problem(issue: z.core.$ZodIssue, stepLabel: (index: number) => string | undefined) {
  const [head, index, ...rest] = issue.path;
  const stepIndex = head === 'steps' && typeof index === 'number' ? index : null;
  const where =
    stepIndex !== null
      ? (stepLabel(stepIndex) ?? `Step ${stepIndex + 1}`)
      : head === 'trigger'
        ? 'Trigger'
        : head === 'name'
          ? 'Name'
          : head === 'steps'
            ? 'Steps'
            : 'Workflow';
  const fields = (stepIndex === null ? issue.path : rest).filter((part): part is string => typeof part === 'string');
  const field = fields.at(-1);
  const fix =
    issue.code === 'custom'
      ? sentence(issue.message)
      : field && fieldFixes[field]
        ? fieldFixes[field]
        : head === 'steps' && stepIndex === null
          ? 'Keep 1 to 32 steps.'
          : `Check the ${fields.map(part => fieldNames[part] ?? part.replaceAll('_', ' ')).at(-1) ?? 'step settings'}.`;
  return `${where}: ${fix}`;
}

/** Turns schema issues into one readable line per problem, naming the step and what to fix. */
export function definitionProblems(
  error: unknown,
  stepLabel: (index: number) => string | undefined = () => undefined,
): string[] {
  if (error instanceof SyntaxError)
    return ['The definition is not valid JSON. Check for a missing comma, quote, or bracket.'];
  if (!(error instanceof z.ZodError))
    return ['The definition could not be checked. Review steps, references, and trigger settings.'];
  return [...new Set(error.issues.map(issue => problem(issue, stepLabel)))];
}
