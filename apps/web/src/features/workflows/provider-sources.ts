import type { z } from 'zod';
import type { providerSourceSchema } from '@tulipfarm/workflows/contracts';

type Source = z.infer<typeof providerSourceSchema>;
export const workflowSources: { title: string; source: Source; help: string }[] = [
  {
    title: 'Google Sheets',
    source: { provider: 'sheets', spreadsheetId: '', range: 'Sheet1!A2:Z1000', keyColumn: 0 },
    help: 'Requires spreadsheets.readonly. Exclude the header. Use a stable unique key column. First poll records a baseline. Up to 1,000 rows and 100 columns.',
  },
  {
    title: 'Slack',
    source: { provider: 'slack', teamId: '', channelId: '', conversation: 'public' },
    help: 'Public channels require channels:read and channels:history. Direct conversations require im:read and im:history. The token must have access to this exact conversation.',
  },
  {
    title: 'Notion',
    source: { provider: 'notion', dataSourceId: '' },
    help: 'Share the database with your Notion integration. Choose its data source, not its database. New pages only.',
  },
  {
    title: 'Gmail',
    source: { provider: 'gmail', emailAddress: '', labelId: 'INBOX' },
    help: 'Requires gmail.readonly. Reads new email metadata, headers, and snippets for this label. Email bodies and attachments are not fetched.',
  },
  {
    title: 'Google Forms',
    source: { provider: 'forms', formId: '' },
    help: 'Requires forms.responses.readonly, forms.body.readonly and access to the form. Loading choices also needs drive.metadata.readonly. Reads submitted answers. Repeat submissions with the same response ID do not start another run.',
  },
  {
    title: 'Jira',
    source: { provider: 'jira', cloudId: '', projectKey: '' },
    help: 'Use a Jira Cloud OAuth bearer token with read:jira-work and Browse projects permission. Enter the cloud ID and one project key.',
  },
  {
    title: 'HubSpot',
    source: { provider: 'hubspot', portalId: '', objectType: 'contacts' },
    help: 'Use a private app or OAuth bearer token with account-info access and read access to the selected CRM object. Starts on new objects only. Search indexing can delay detection.',
  },
];
