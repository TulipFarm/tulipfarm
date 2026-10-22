import {
  providerOperationSchema,
  type ProviderOperation,
  type SourceBinding,
} from '@tulipfarm/atlassian/operation-contracts';

type Field = {
  key: string;
  label: string;
  kind?: 'text' | 'multiline' | 'number' | 'boolean' | 'due';
  optional?: boolean;
  initial?: string;
  help?: string;
};
type Definition = { label: string; source: SourceBinding['kind']; fields: Field[] };
const issue: Field = { key: 'issueIdOrKey', label: 'Issue ID or key', help: 'For example, OPS-123.' };
const page: Field = { key: 'id', label: 'Page ID', help: 'The numeric Confluence page ID.' };
const card: Field = { key: 'cardId', label: 'Card ID', help: 'The full 24-character card ID, not its short link.' };
const body: Field = {
  key: 'body',
  label: 'Page body',
  kind: 'multiline',
  help: 'Confluence storage markup. This is sent as text and is never rendered here.',
};
export const operationDefinitions: Record<ProviderOperation['kind'], Definition> = {
  'jira.search': {
    label: 'Search Jira issues',
    source: 'jira',
    fields: [
      { key: 'jql', label: 'Jira query (JQL)' },
      { key: 'maxResults', label: 'Maximum results', kind: 'number', initial: '20', help: 'Between 1 and 50.' },
      { key: 'nextPageToken', label: 'Next page token', optional: true },
    ],
  },
  'jira.read': { label: 'Read Jira issue', source: 'jira', fields: [issue] },
  'jira.create': {
    label: 'Create Jira issue',
    source: 'jira',
    fields: [
      { key: 'projectKey', label: 'Project key' },
      { key: 'issueTypeName', label: 'Issue type', initial: 'Task' },
      { key: 'summary', label: 'Summary' },
      { key: 'description', label: 'Description', kind: 'multiline', optional: true },
    ],
  },
  'jira.update': {
    label: 'Update Jira issue',
    source: 'jira',
    fields: [
      issue,
      { key: 'summary', label: 'Summary', optional: true },
      { key: 'description', label: 'Description', kind: 'multiline', optional: true },
    ],
  },
  'jira.delete': { label: 'Delete Jira issue', source: 'jira', fields: [issue] },
  'confluence.search': {
    label: 'Search Confluence pages',
    source: 'confluence',
    fields: [
      { key: 'cql', label: 'Confluence query (CQL)' },
      { key: 'limit', label: 'Maximum results', kind: 'number', initial: '20', help: 'Between 1 and 50.' },
    ],
  },
  'confluence.read': { label: 'Read Confluence page', source: 'confluence', fields: [page] },
  'confluence.create': {
    label: 'Create Confluence page',
    source: 'confluence',
    fields: [{ key: 'spaceKey', label: 'Space key' }, { key: 'title', label: 'Page title' }, body],
  },
  'confluence.update': {
    label: 'Update Confluence page',
    source: 'confluence',
    fields: [
      page,
      { key: 'title', label: 'Page title' },
      body,
      {
        key: 'version',
        label: 'New version number',
        kind: 'number',
        help: 'Read the current page first. Enter its version plus one.',
      },
    ],
  },
  'confluence.trash': {
    label: 'Move Confluence page to trash',
    source: 'confluence-trash',
    fields: [{ ...page, key: 'pageId' }],
  },
  'card.search': {
    label: 'Search Trello cards',
    source: 'trello',
    fields: [
      { key: 'query', label: 'Card search query' },
      { key: 'page', label: 'Results page', kind: 'number', initial: '0', help: 'From 0 to 100.' },
    ],
  },
  'card.read': { label: 'Read Trello card', source: 'trello', fields: [card] },
  'card.create': {
    label: 'Create Trello card',
    source: 'trello',
    fields: [
      { key: 'listId', label: 'List ID', help: 'A full 24-character list ID on the selected board.' },
      { key: 'name', label: 'Card title' },
      { key: 'desc', label: 'Card description', kind: 'multiline', initial: '' },
    ],
  },
  'card.update': {
    label: 'Update Trello card',
    source: 'trello',
    fields: [
      card,
      { key: 'name', label: 'Card title', optional: true },
      { key: 'desc', label: 'Card description', kind: 'multiline', optional: true },
      { key: 'closed', label: 'Archived', kind: 'boolean', optional: true },
      {
        key: 'due',
        label: 'Due time',
        kind: 'due',
        optional: true,
        help: 'UTC date and time, such as 2026-10-01T12:00:00Z. Leave empty to clear the due time.',
      },
      { key: 'dueComplete', label: 'Due complete', kind: 'boolean', optional: true },
    ],
  },
  'card.delete': { label: 'Delete Trello card', source: 'trello', fields: [card] },
};
export const operationKinds = providerOperationSchema.options.map(option => option.shape.kind.value);
export function initialFields(kind: ProviderOperation['kind']) {
  return Object.fromEntries(
    operationDefinitions[kind].fields.map(field => [
      field.key,
      field.initial ?? (field.kind === 'boolean' ? 'false' : ''),
    ]),
  );
}
export function parseOperation(kind: ProviderOperation['kind'], values: Record<string, string>, included: string[]) {
  const fields: Record<string, unknown> = {};
  for (const field of operationDefinitions[kind].fields) {
    if (field.optional && !included.includes(field.key)) continue;
    const value = values[field.key] ?? '';
    fields[field.key] =
      field.kind === 'number'
        ? Number(value)
        : field.kind === 'boolean'
          ? value === 'true'
          : field.kind === 'due' && value === ''
            ? null
            : value;
  }
  let operation: unknown = { kind, ...fields };
  if (kind === 'jira.update') {
    const { issueIdOrKey, ...changes } = fields;
    operation = { kind, issueIdOrKey, fields: changes };
  }
  if (kind === 'card.update') {
    const { cardId, ...changes } = fields;
    operation = { kind, cardId, changes };
  }
  if (kind === 'confluence.create' || kind === 'confluence.update')
    operation = { kind, ...fields, representation: 'storage' };
  return providerOperationSchema.safeParse(operation);
}
