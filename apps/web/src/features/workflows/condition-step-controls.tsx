import type { ConditionStep, Definition } from '@tulipfarm/workflows/contracts';
import { Field } from '@tulipfarm/sprout/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { comparisonWords, conditionDescription, stepTitle } from './editor-controls';
import { ValueControl } from './table-step-controls';

type Operator = keyof typeof comparisonWords;
type Branch = 'met' | 'otherwise' | 'always';
const unary = (op: Operator) => op === 'is-empty' || op === 'not-empty';
const branchLabels = {
  met: 'Runs only when the condition is met',
  otherwise: 'Runs only when it is not met',
  always: 'Always runs',
} as const satisfies Record<Branch, string>;

/** Edits a condition in words: what to compare, and which later steps each outcome runs. */
export function ConditionStepControls({
  step,
  steps,
  index,
  disabled,
  onChange,
}: {
  step: ConditionStep;
  steps: Definition['steps'];
  index: number;
  disabled: boolean;
  onChange: (step: ConditionStep) => void;
}) {
  const earlier = steps.slice(0, index);
  const later = steps.slice(index + 1);
  const { when } = step;
  const setOperator = (op: Operator) =>
    onChange({
      ...step,
      when: unary(op)
        ? { left: when.left, op: op as 'is-empty' | 'not-empty' }
        : {
            left: when.left,
            op: op as Exclude<Operator, 'is-empty' | 'not-empty'>,
            right: 'right' in when ? when.right : { kind: 'literal', value: '' },
          },
    });
  const branch = (id: string): Branch =>
    step.ifMet.includes(id) ? 'met' : step.otherwise.includes(id) ? 'otherwise' : 'always';
  const setBranch = (id: string, next: Branch) =>
    onChange({
      ...step,
      ifMet: [...step.ifMet.filter(item => item !== id), ...(next === 'met' ? [id] : [])],
      otherwise: [...step.otherwise.filter(item => item !== id), ...(next === 'otherwise' ? [id] : [])],
    });
  const { condition, ifMet, otherwise } = conditionDescription(step, steps);
  return (
    <fieldset disabled={disabled} className="space-y-3">
      <legend className="sr-only">Condition for step {index + 1}</legend>
      <div className="space-y-2">
        <p className="text-sm font-medium">Compare</p>
        <ValueControl
          id={`${step.id} compared value`}
          value={when.left}
          earlier={earlier}
          typed
          onChange={left => onChange({ ...step, when: { ...when, left } })}
        />
      </div>
      <Field id={`condition-operator-${step.id}`} label="Test" required>
        <Select
          value={when.op}
          onValueChange={value => {
            if (value) setOperator(value as Operator);
          }}
        >
          <SelectTrigger id={`condition-operator-${step.id}`}>
            <SelectValue>{comparisonWords[when.op]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(comparisonWords) as Operator[]).map(op => (
              <SelectItem key={op} value={op}>
                {comparisonWords[op]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {'right' in when && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Against</p>
          <ValueControl
            id={`${step.id} comparison value`}
            value={when.right}
            earlier={earlier}
            typed
            onChange={right => onChange({ ...step, when: { ...when, right } })}
          />
        </div>
      )}
      {later.length ? (
        <div className="space-y-2" role="group" aria-label={`Branches for step ${index + 1}`}>
          <p className="text-sm font-medium">Later steps</p>
          <ul className="space-y-2">
            {later.map((target, offset) => (
              <li key={target.id} className="grid gap-1 sm:grid-cols-2 sm:items-center">
                <span className="text-sm">
                  Step {index + offset + 2} ({stepTitle(target)})
                </span>
                <Select
                  value={branch(target.id)}
                  onValueChange={value => {
                    if (value) setBranch(target.id, value as Branch);
                  }}
                >
                  <SelectTrigger aria-label={`When step ${index + offset + 2} runs`}>
                    <SelectValue>{branchLabels[branch(target.id)]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(branchLabels) as Branch[]).map(choice => (
                      <SelectItem key={choice} value={choice}>
                        {branchLabels[choice]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Add a step after this condition, or move this condition earlier, so it has a step to run or skip.
        </p>
      )}
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {step.ifMet.length || step.otherwise.length
          ? `${condition}. ${ifMet} ${otherwise}`
          : `${condition}. Choose at least one later step to run or skip.`}
      </p>
    </fieldset>
  );
}
