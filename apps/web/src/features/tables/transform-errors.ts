const exponent = /^\s*[+-]?(\d+\.?\d*|\.\d+)e[+-]?\d+\s*$/i;

/** Says in plain words why a row failed a schema change and how to fix it. `value` is the row's current value, if known. */
export function transformErrorHelp(code: string, value?: string | null): string {
  const shown = value && value !== 'Not set' ? `“${value}”` : 'This value';
  switch (code) {
    case 'conversion-failed':
      if (value && exponent.test(value))
        return `${shown} is in exponent notation. Numbers must be plain decimals, such as 1000. Rewrite the value without the “e”.`;
      return `${shown} can’t be converted to the new field type. Numbers must be plain decimals such as 42.5, yes or no values must be true or false, and dates must look like 2026-01-31. Correct the value, or ask the assistant for a rule that maps it.`;
    case 'invalid-output':
      return `${shown} doesn’t fit the new field’s rules once converted. It may have too many digits or decimal places, be too long, or be empty when a value is required. Correct the value, or ask the assistant to loosen the field’s rules.`;
    case 'unmapped-value':
      return `No mapping covers ${value && value !== 'Not set' ? shown : 'this value'}. Ask the assistant to add a mapping for it, or to say what unmatched values become.`;
    case 'type-mismatch':
      return 'The conversion rule expects a different kind of value here, such as text. Ask the assistant to convert the value first or use a different rule.';
    case 'missing-field':
      return 'The conversion rule reads a field this row doesn’t have. Ask the assistant to correct the rule.';
    case 'split-index':
      return `${shown} has fewer parts than the split rule expects. Correct the value, or ask the assistant to change the rule.`;
    case 'invalid-input':
      return 'The conversion rules or this row’s values aren’t valid for this change. Ask the assistant to correct the rules.';
    default:
      return `This row can’t be converted (${code}). Ask the assistant how to correct it.`;
  }
}
