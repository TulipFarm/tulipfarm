import type { z } from 'zod';
import { providerIntegrationInputSchema, type providerSourceSchema } from '@tulipfarm/workflows/contracts';

type ProviderSource = z.infer<typeof providerSourceSchema>;

export type ProviderField =
  | 'name'
  | 'token'
  | 'consent'
  | 'spreadsheetId'
  | 'range'
  | 'keyColumn'
  | 'teamId'
  | 'channelId'
  | 'dataSourceId'
  | 'emailAddress'
  | 'labelId'
  | 'formId'
  | 'cloudId'
  | 'projectKey'
  | 'portalId';
export type ProviderIntegrationDraft = { name: string; source: ProviderSource; token: string; consent: boolean };

export const providerFieldHelp: Partial<Record<ProviderField, string>> = {
  spreadsheetId: 'In the sheet’s address, copy the part between /d/ and /edit.',
  range: 'Start below the header row, for example Sheet1!A2:Z1000.',
  keyColumn: 'The first column in the selected range is 0, the next is 1. Choose a column whose values never repeat.',
  teamId: 'Starts with T. Open Slack in a browser: it follows /client/ in the address.',
  channelId:
    'Starts with C for a channel or D for a direct message. Open the conversation in a browser: it follows the workspace ID in the address.',
  dataSourceId: 'In the Notion database settings, choose Manage data sources, then Copy data source ID.',
  emailAddress: 'The Gmail account the token belongs to.',
  labelId: 'INBOX for the inbox. Custom labels have IDs such as Label_12.',
  formId: 'In the form editor’s address, copy the part between /d/ and /edit.',
  cloudId: 'Open your-site.atlassian.net/_edge/tenant_info and copy the cloudId value.',
  projectKey: 'The capital letters before issue numbers, such as OPS in OPS-12.',
  portalId: 'Numbers only. HubSpot shows it as the Hub ID in your account menu.',
};

const fieldErrors: Record<ProviderField, string> = {
  name: 'Enter a source name of up to 120 characters.',
  token: 'Paste the token exactly, up to 4096 characters, with no spaces or line breaks.',
  consent: 'Confirm that you authorize access to this source.',
  spreadsheetId: 'Use only the ID from the sheet’s address: up to 200 letters, numbers, - and _.',
  range: 'Enter a range of up to 200 characters, such as Sheet1!A2:Z1000.',
  keyColumn: 'Enter a whole number from 0 to 99.',
  teamId: 'Slack workspace IDs start with T followed by capital letters or numbers.',
  channelId: 'Conversation IDs start with C or D followed by capital letters or numbers.',
  dataSourceId: 'Data source IDs have 36 characters, such as 1f2e3d4c-5b6a-4980-8a2b-3c4d5e6f7a8b.',
  emailAddress: 'Enter a full email address, such as ops@example.com.',
  labelId: 'Label IDs use up to 200 letters, numbers, - and _, such as INBOX or Label_12.',
  formId: 'Use only the ID from the form’s address: up to 200 letters, numbers, - and _.',
  cloudId: 'Cloud IDs have 36 characters, such as 1f2e3d4c-5b6a-4980-8a2b-3c4d5e6f7a8b.',
  projectKey: 'Project keys start with a capital letter and use up to 50 capitals, numbers or _.',
  portalId: 'Portal IDs contain numbers only.',
};

const placeholderId = '00000000-0000-4000-8000-000000000000';

/** One readable message per invalid field, checked with the same schema the API applies. */
export function providerIssues(draft: ProviderIntegrationDraft): Partial<Record<ProviderField, string>> {
  const result = providerIntegrationInputSchema.safeParse({ id: placeholderId, ...draft });
  if (result.success) return {};
  const issues: Partial<Record<ProviderField, string>> = {};
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] === 'source' ? issue.path[1] : issue.path[0]);
    if (key in fieldErrors) issues[key as ProviderField] ??= fieldErrors[key as ProviderField];
  }
  return issues;
}
