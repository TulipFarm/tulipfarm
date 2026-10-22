import { createHash } from 'node:crypto';
import { githubEventFieldsSchema, type GitHubEventFields } from '@tulipfarm/github/event-contracts';
import { canonical } from '@tulipfarm/workflow-snippets/canonical';
import {
  automationApprovalSchema,
  automationDefaults,
  automationTemplateSchema,
  type AutomationApproval,
  type AutomationTemplate,
} from './automation-contracts.ts';

export class AutomationError extends Error {
  readonly code: 'template-field-missing' | 'template-output-too-large' | 'template-output-empty';
  constructor(code: AutomationError['code']) {
    super(code);
    this.code = code;
    this.name = 'AutomationError';
  }
}

export function automationApprovalDigest(input: AutomationApproval) {
  return createHash('sha256')
    .update(canonical({ policyVersion: 1, approval: automationApprovalSchema.parse(input) }))
    .digest('hex');
}

export function renderAutomationMessage(input: AutomationTemplate, values: GitHubEventFields) {
  const template = automationTemplateSchema.parse(input);
  for (const field of template.fields) {
    if (!Object.hasOwn(values, field) || values[field] === undefined)
      throw new AutomationError('template-field-missing');
  }
  const fields = githubEventFieldsSchema.parse(values);
  const message = template.parts
    .map(part =>
      part.kind === 'literal'
        ? part.text
        : String(fields[part.field]).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    )
    .join('');
  if (!message.trim()) throw new AutomationError('template-output-empty');
  if (message.length > automationDefaults.maxMessageLength) throw new AutomationError('template-output-too-large');
  return message;
}
